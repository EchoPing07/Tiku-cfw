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

  if (typeof body.question !== 'string' || typeof body.answer !== 'string' || !body.question.trim() || !body.answer.trim()) {
    return error('题目和答案不能为空');
  }
  if (body.type !== undefined && body.type !== null && typeof body.type !== 'string') return error('题型(type)必须为字符串');
  if (body.options !== undefined && body.options !== null && typeof body.options !== 'string') return error('选项(options)必须为字符串');

  const { normalized, hash } = await normalizeAndHash(body.question);
  if (!normalized) return error('题目内容无效（去除格式标记后为空）');

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

  if (body.question !== undefined && (typeof body.question !== 'string' || !body.question.trim())) {
    return error('题目(question)必须为非空字符串');
  }
  if (body.answer !== undefined && (typeof body.answer !== 'string' || !body.answer.trim())) {
    return error('答案(answer)必须为非空字符串');
  }
  if (body.type !== undefined && body.type !== null && typeof body.type !== 'string') return error('题型(type)必须为字符串');
  if (body.options !== undefined && body.options !== null && typeof body.options !== 'string') return error('选项(options)必须为字符串');

  // 按字段存在性更新，避免部分 PUT 清空字段
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (body.question !== undefined) {
    const { normalized, hash } = await normalizeAndHash(body.question);
    if (!normalized) return error('题目内容无效（去除格式标记后为空）');
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

  try {
    await env.DB.prepare(`UPDATE questions SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
  } catch (err) {
    // 检查与更新之间的并发竞态撞 UNIQUE 时转成友好错误，而非 500
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return error('与其他题目冲突（归一化后哈希重复）');
    }
    throw err;
  }

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
    // CSV 解析：question,answer,type,options（支持引号内换行/逗号）
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
  if (items.length > 5000) {
    return error('单次最多导入 5000 条，请分批导入');
  }

  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;

  for (const item of items) {
    // 类型/空值/归一化校验：非法条目跳过并计数，不中断整体导入
    if (typeof item?.question !== 'string' || typeof item?.answer !== 'string' || !item.question.trim() || !item.answer.trim()) {
      skipped++;
      continue;
    }
    if (item.type !== undefined && item.type !== null && typeof item.type !== 'string') { skipped++; continue; }
    if (item.options !== undefined && item.options !== null && typeof item.options !== 'string') { skipped++; continue; }

    const { normalized, hash } = await normalizeAndHash(item.question);
    if (!normalized) { skipped++; continue; }

    stmts.push(
      env.DB.prepare(
        `INSERT INTO questions (id, question, question_norm, question_hash, answer, type, options, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'import')
         ON CONFLICT(question_hash) DO NOTHING`
      ).bind(
        uuid(), item.question, normalized, hash, item.answer,
        item.type || null, item.options || null
      )
    );
  }

  // 分块 batch：一次往返写一批，避免逐条 await 的数千次 D1 往返
  let imported = 0;
  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const results = await env.DB.batch(stmts.slice(i, i + CHUNK));
    for (const r of results) {
      if (r.meta.changes) imported++;
    }
  }
  skipped += stmts.length - imported; // 批内因哈希重复（ON CONFLICT）未写入的

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

/** CSV 单条记录 */
export interface CSVRecord {
  question: string;
  answer: string;
  type?: string;
  options?: string;
}

/**
 * 解析 CSV 文本（question,answer,type,options），首行为表头。
 * 标准状态机实现：支持双引号包裹字段、"" 转义、引号内换行/逗号、\r\n 与 BOM。
 */
export function parseCSV(csv: string): CSVRecord[] {
  const text = csv.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const records: string[][] = [];
  let fields: string[] = [];
  let current = '';
  let inQuotes = false;

  const pushField = () => { fields.push(current); current = ''; };
  const pushRecord = () => {
    pushField();
    if (fields.some(f => f.trim() !== '')) records.push(fields);
    fields = [];
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      pushField();
    } else if (char === '\n') {
      pushRecord();
    } else {
      current += char;
    }
  }
  // 末行无换行符的收尾（含未闭合引号的容错）
  if (current !== '' || fields.length > 0 || inQuotes) pushRecord();

  if (records.length < 2) return [];

  const result: CSVRecord[] = [];
  for (let i = 1; i < records.length; i++) {
    const f = records[i];
    if (f.length >= 2) {
      result.push({
        question: f[0],
        answer: f[1],
        type: f[2] || undefined,
        options: f[3] || undefined,
      });
    }
  }
  return result;
}
