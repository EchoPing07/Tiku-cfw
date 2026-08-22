import type { Env } from '../types/env';
import { json, error, options } from '../utils/response';
import { requireAuth } from '../auth/middleware';
import { normalizeAndHash } from '../cache/normalize';
import { uuid } from '../utils/id';
import { parseJsonBody } from '../utils/request';

/** 题目管理路由 */
export async function questionsHandler(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method === 'OPTIONS') return options();

  const authFail = await requireAuth(request, env);
  if (authFail) return authFail;

  const url = new URL(request.url);

  // /api/admin/questions - 列表/创建
  if (path === '/api/admin/questions') {
    if (request.method === 'GET') return listQuestions(env, url);
    if (request.method === 'POST') return createQuestion(request, env);
    return error('不支持的方法', 405);
  }

  // /api/admin/questions/import - 导入
  if (path === '/api/admin/questions/import') {
    if (request.method === 'POST') return importQuestions(request, env);
    return error('不支持的方法', 405);
  }

  // /api/admin/questions/export - 导出
  if (path === '/api/admin/questions/export') {
    if (request.method === 'GET') return exportQuestions(env, url);
    return error('不支持的方法', 405);
  }

  // /api/admin/questions/by-hash/:hash - 按归一化哈希查题目（日志纠错用）
  const byHashMatch = path.match(/^\/api\/admin\/questions\/by-hash\/(.+)$/);
  if (byHashMatch) {
    let hash: string;
    try {
      hash = decodeURIComponent(byHashMatch[1]);
    } catch {
      return error('哈希编码无效');
    }
    if (request.method === 'GET') return getQuestionByHash(env, hash);
    return error('不支持的方法', 405);
  }

  // /api/admin/questions/:id
  const idMatch = path.match(/^\/api\/admin\/questions\/(.+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (request.method === 'GET') return getQuestion(env, id);
    if (request.method === 'PUT') return updateQuestion(request, env, id);
    if (request.method === 'DELETE') return deleteQuestion(env, id);
    return error('不支持的方法', 405);
  }

  return error('接口不存在', 404);
}

/** 列表查询 */
async function listQuestions(env: Env, url: URL): Promise<Response> {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get('size') || '10', 10) || 10));
  const search = url.searchParams.get('search') || '';
  const type = url.searchParams.get('type') || '';

  const offset = (page - 1) * size;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push("question LIKE ? ESCAPE '\\'");
    params.push('%' + search.replace(/[\\%_]/g, c => '\\' + c) + '%');
  }
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // 总数
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM questions ${where}`
  ).bind(...params).first<{ count: number }>();

  // 列表
  const listResult = await env.DB.prepare(
    `SELECT id, question, answer, type, options, source, ai_model, hit_count, created_at
     FROM questions ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(...params, size, offset).all();

  return json({
    total: countRow?.count || 0,
    page,
    size,
    data: listResult.results || [],
  });
}

/** 单条查询 */
async function getQuestion(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
  if (!row) return error('题目不存在', 404);
  return json(row);
}

/** 按归一化哈希查询（日志详情关联缓存题目），未缓存返回 question: null */
async function getQuestionByHash(env: Env, hash: string): Promise<Response> {
  const row = await env.DB.prepare(
    'SELECT id, question, answer, type, options, source, hit_count, created_at, updated_at FROM questions WHERE question_hash = ?'
  ).bind(hash).first();
  return json({ code: 1, question: row || null });
}

/** 创建题目 */
async function createQuestion(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<{ question: string; answer: string; type?: string; options?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.question || !body.answer) {
    return error('题目和答案不能为空');
  }

  const { normalized, hash } = await normalizeAndHash(body.question);

  // 前置检查：给出友好提示
  const existing = await env.DB.prepare('SELECT id FROM questions WHERE question_hash = ?').bind(hash).first();
  if (existing) {
    return error('该题目已存在');
  }

  const id = uuid();
  // ON CONFLICT 兑底并发插入
  const result = await env.DB.prepare(
    `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')
     ON CONFLICT(question_hash) DO NOTHING`
  ).bind(id, body.question, normalized, hash, body.answer, body.type || null, body.options || null).run();

  if (!result.meta.changes) {
    return error('该题目已存在');
  }

  return json({ id, msg: '创建成功' });
}

/** 更新题目 */
async function updateQuestion(request: Request, env: Env, id: string): Promise<Response> {
  const parsed = await parseJsonBody<{ question?: string; answer?: string; type?: string; options?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const existing = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
  if (!existing) return error('题目不存在', 404);

  // 按字段存在性更新，避免部分 PUT 清空字段
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (body.question !== undefined) {
    const { normalized, hash } = await normalizeAndHash(body.question);
    // 撞库检查（排除自身）
    const conflict = await env.DB.prepare(
      'SELECT id FROM questions WHERE question_hash = ? AND id <> ?'
    ).bind(hash, id).first();
    if (conflict) return error('与其他题目冲突（归一化后哈希重复）');
    sets.push('question = ?', 'question_norm = ?', 'question_hash = ?');
    params.push(body.question, normalized, hash);
  }
  if (body.answer !== undefined) { sets.push('answer = ?'); params.push(body.answer); }
  if (body.type !== undefined) { sets.push('type = ?'); params.push(body.type); }
  if (body.options !== undefined) { sets.push('options = ?'); params.push(body.options); }
  params.push(id);

  await env.DB.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  return json({ msg: '更新成功' });
}

/** 删除题目 */
async function deleteQuestion(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
  if (!result.meta.changes) return error('题目不存在', 404);
  return json({ msg: '删除成功' });
}

/** 批量导入 */
async function importQuestions(request: Request, env: Env): Promise<Response> {
  const parsed = await parseJsonBody<{ format?: 'json' | 'csv'; content?: string }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (!body.content) return error('内容不能为空');

  let items: Array<{ question: string; answer: string; type?: string; options?: string }>;

  if (body.format === 'csv') {
    // 简单 CSV 解析：question,answer,type,options
    items = parseCSV(body.content);
  } else {
    // JSON
    try {
      items = JSON.parse(body.content);
    } catch {
      return error('JSON 格式错误');
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    return error('没有可导入的题目');
  }

  let imported = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.question || !item.answer) {
      skipped++;
      continue;
    }

    const { normalized, hash } = await normalizeAndHash(item.question);

    // ON CONFLICT 兑底并发/重复，meta.changes=0 视为跳过
    const result = await env.DB.prepare(
      `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'import')
       ON CONFLICT(question_hash) DO NOTHING`
    ).bind(
      uuid(), item.question, normalized, hash, item.answer,
      item.type || null, item.options || null
    ).run();

    if (result.meta.changes) imported++; else skipped++;
  }

  return json({ imported, skipped, total: items.length, msg: `导入 ${imported} 条，跳过 ${skipped} 条` });
}

/** 导出题目 */
async function exportQuestions(env: Env, url: URL): Promise<Response> {
  const format = url.searchParams.get('format') || 'json';
  const type = url.searchParams.get('type');

  // 超过 10000 条直接拒绝，避免静默截断
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM questions${type ? ' WHERE type = ?' : ''}`
  ).bind(...(type ? [type] : [])).first<{ count: number }>();
  if ((countRow?.count || 0) > 10000) {
    return error('数据超过 10000 条，请按类型筛选或分批导出');
  }

  let query = 'SELECT question, answer, type, options FROM questions';
  const params: unknown[] = [];
  if (type) {
    query += ' WHERE type = ?';
    params.push(type);
  }
  query += ' ORDER BY created_at DESC LIMIT 10000';

  const result = await env.DB.prepare(query).bind(...params).all<{
    question: string; answer: string; type: string | null; options: string | null
  }>();

  const data = result.results || [];

  if (format === 'csv') {
    const csv = [
      'question,answer,type,options',
      ...data.map(d => {
        const escape = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
        return [escape(d.question), escape(d.answer), escape(d.type || ''), escape(d.options || '')].join(',');
      })
    ].join('\n');

    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="questions.csv"',
      }
    });
  }

  // JSON
  return new Response(JSON.stringify(data, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/** 简单 CSV 解析 */
function parseCSV(csv: string): Array<{ question: string; answer: string; type?: string; options?: string }> {
  // 统一换行：处理 \r\n / \r
  const lines = csv.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const result: Array<{ question: string; answer: string; type?: string; options?: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length >= 2) {
      result.push({
        question: fields[0],
        answer: fields[1],
        type: fields[2] || undefined,
        options: fields[3] || undefined,
      });
    }
  }

  return result;
}

/** 解析单行 CSV（支持双引号转义） */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }

  result.push(current);
  return result;
}
