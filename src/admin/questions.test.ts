import { describe, it, expect, vi } from 'vitest';
import { questionsHandler, parseCSV } from './questions';
import { normalizeAndHash } from '../cache/normalize';
import type { Env } from '../types/env';

vi.mock('../auth/middleware', () => ({ requireAuth: vi.fn().mockResolvedValue(null) }));

interface Executed { sql: string; params: unknown[] }

/**
 * 极简 D1 mock：
 * - SELECT ... WHERE question_hash = ? AND id <> ? → hashConflicts（撞库检查）
 * - SELECT * FROM questions WHERE id = ? → existing（更新前的原行）
 * - 其余语句仅记录，供断言 SET 子句与参数顺序
 */
function makeEnv(
  existing: Record<string, unknown> | null,
  hashConflicts: Record<string, { id: string }> = {}
) {
  const executed: Executed[] = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...ps: unknown[]) { stmt.params = ps; return stmt; },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: stmt.params });
          if (/WHERE question_hash/.test(sql)) {
            return (hashConflicts[stmt.params[0] as string] ?? null) as T | null;
          }
          if (/WHERE id = \?/.test(sql)) return (existing ?? null) as T | null;
          return null;
        },
        async run() { executed.push({ sql, params: stmt.params }); return { meta: { changes: 1 } }; },
        async all() { return { results: [] }; },
      };
      return stmt;
    },
    async batch(list: Array<Executed | null>) {
      for (const s of list || []) if (s) executed.push({ sql: s.sql, params: s.params });
      return (list || []).map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { env: { DB: db } as unknown as Env, executed };
}

const LEGACY = {
  id: 'q1', question: '题干内容', question_norm: '题干内容',
  question_hash: 'legacy-hash', answer: '旧答案', type: 'single',
  options: 'A. 甲', source: 'ai', ai_model: 'm1', has_images: 0,
  hit_count: 0, created_at: '2024-01-01', updated_at: '2024-01-01',
};

function putReq(id: string, body: unknown): Request {
  return new Request(`https://x/api/admin/questions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function updates(executed: Executed[]): Executed[] {
  return executed.filter(e => e.sql.startsWith('UPDATE questions'));
}

describe('updateQuestion（缓存键含选项后的 SET/参数顺序）', () => {
  it('仅改选项：重算组合键哈希，SET 顺序与参数严格对齐，不改写题干列', async () => {
    const { env, executed } = makeEnv(LEGACY);
    const { hash: expectedHash } = await normalizeAndHash('题干内容', 'B. 乙');

    const res = await questionsHandler(putReq('q1', { options: 'B. 乙' }), env, '/api/admin/questions/q1');

    expect(res.status).toBe(200);
    const upd = updates(executed);
    expect(upd).toHaveLength(1);
    // SET 子句：updated_at（无参数）、question_hash、options、WHERE id
    expect(upd[0].sql).toContain('question_hash = ?');
    expect(upd[0].sql).toContain('options = ?');
    expect(upd[0].sql).not.toContain('question = ?');      // 题干未提供 → 不改写
    expect(upd[0].sql).not.toContain('question_norm = ?');
    // 参数顺序必须与 SET 顺序一致：hash, options, id
    expect(upd[0].params).toEqual([expectedHash, 'B. 乙', 'q1']);
  });

  it('仅改答案：不动哈希（旧行仍可被旧键回退命中）', async () => {
    const { env, executed } = makeEnv(LEGACY);

    const res = await questionsHandler(putReq('q1', { answer: '新答案' }), env, '/api/admin/questions/q1');

    expect(res.status).toBe(200);
    const upd = updates(executed);
    expect(upd[0].sql).not.toContain('question_hash');
    expect(upd[0].params).toEqual(['新答案', 'q1']);
  });

  it('题干与选项同时更新：新哈希来自组合值，撞库检查排除自身', async () => {
    const { env, executed } = makeEnv(LEGACY);
    const { hash: expectedHash, normalized } = await normalizeAndHash('新题干', 'C. 丙');

    const res = await questionsHandler(
      putReq('q1', { question: '新题干', options: 'C. 丙' }), env, '/api/admin/questions/q1'
    );

    expect(res.status).toBe(200);
    const upd = updates(executed);
    // SET 顺序：question, question_norm, question_hash, options, id
    expect(upd[0].params).toEqual(['新题干', normalized, expectedHash, 'C. 丙', 'q1']);
    // 撞库检查排除了自身 id
    const conflict = executed.find(e => /question_hash = \? AND id <> \?/.test(e.sql));
    expect(conflict?.params).toEqual([expectedHash, 'q1']);
  });

  it('组合键撞库（其他行已占同哈希）→ 400 且不执行 UPDATE', async () => {
    const { hash } = await normalizeAndHash('题干内容', 'B. 乙');
    const { env, executed } = makeEnv(LEGACY, { [hash]: { id: 'other' } });

    const res = await questionsHandler(putReq('q1', { options: 'B. 乙' }), env, '/api/admin/questions/q1');

    expect(res.status).toBe(400);
    const body = (await res.json()) as { msg?: string };
    expect(body.msg).toContain('冲突');
    expect(updates(executed)).toHaveLength(0);
  });

  it('选项置 null（清空）：options 列写 NULL 且哈希回到题干键，与搜索路径约定一致', async () => {
    const { env, executed } = makeEnv(LEGACY);
    const { hash: titleOnlyHash } = await normalizeAndHash('题干内容');

    const res = await questionsHandler(putReq('q1', { options: null }), env, '/api/admin/questions/q1');

    expect(res.status).toBe(200);
    const upd = updates(executed);
    // 清空选项后行内已无选项 → 键回到题干哈希（无选项请求可命中），SET/参数顺序对齐
    expect(upd[0].sql).toContain('question_hash = ?');
    expect(upd[0].sql).toContain('options = ?');
    expect(upd[0].params).toEqual([titleOnlyHash, null, 'q1']);
  });
});

describe('createQuestion（缓存键含选项）', () => {
  function postReq(body: unknown): Request {
    return new Request('https://x/api/admin/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('同题干不同选项不再判重为“已存在”', async () => {
    const { hash: h1 } = await normalizeAndHash('题干', 'A. 甲');
    const { hash: h2 } = await normalizeAndHash('题干', 'A. 乙');
    expect(h1).not.toBe(h2);

    // 撞库检查只按组合键：同题干不同选项不冲突
    const { env, executed } = makeEnv(null, { [h1]: { id: 'existing' } });
    const res = await questionsHandler(
      postReq({ question: '题干', answer: '答案', options: 'A. 乙' }), env, '/api/admin/questions'
    );
    expect(res.status).toBe(200);
    const insert = executed.find(e => e.sql.startsWith('INSERT INTO questions'));
    expect(insert?.params[3]).toBe(h2);
  });

  it('同题干同选项（顺序不同）仍判重为已存在', async () => {
    const { hash } = await normalizeAndHash('题干', 'A. 甲\nB. 乙');
    const { env } = makeEnv(null, { [hash]: { id: 'existing' } });

    const res = await questionsHandler(
      postReq({ question: '题干', answer: '答案', options: 'B、乙\nA、甲' }), env, '/api/admin/questions'
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { msg?: string };
    expect(body.msg).toContain('已存在');
  });
});
describe('parseCSV', () => {
  it('基础两列解析并跳过表头', () => {
    const rows = parseCSV('question,answer,type,options\n1+1=?,2\n2+2=?,4');
    expect(rows).toEqual([
      { question: '1+1=?', answer: '2', type: undefined, options: undefined },
      { question: '2+2=?', answer: '4', type: undefined, options: undefined },
    ]);
  });

  it('支持引号内逗号', () => {
    const rows = parseCSV('question,answer\n"下列哪个,是正确的","A, B"');
    expect(rows[0].question).toBe('下列哪个,是正确的');
    expect(rows[0].answer).toBe('A, B');
  });

  it('支持双引号转义（"" → "）', () => {
    const rows = parseCSV('question,answer\n"他说""你好""","ok"');
    expect(rows[0].question).toBe('他说"你好"');
  });

  it('支持引号内换行（题目多行不再错位）', () => {
    const csv = 'question,answer\n"第一行\n第二行","答案"';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].question).toBe('第一行\n第二行');
    expect(rows[0].answer).toBe('答案');
  });

  it('兼容 \r\n 与 \r 换行及 BOM', () => {
    const rows = parseCSV('\uFEFFquestion,answer\r\n1+1=?,2\r3+3=?,6');
    expect(rows).toHaveLength(2);
    expect(rows[1].answer).toBe('6');
  });

  it('过滤空行与字段不足的行', () => {
    const rows = parseCSV('question,answer\n\n1+1=?,2\n只有一列\n\n,,');
    expect(rows).toHaveLength(1);
  });

  it('末行无换行符也能解析', () => {
    const rows = parseCSV('question,answer\n1+1=?,2');
    expect(rows).toHaveLength(1);
  });

  it('只有表头时返回空数组', () => {
    expect(parseCSV('question,answer')).toEqual([]);
    expect(parseCSV('')).toEqual([]);
  });

  it('与导出格式可往返（引号转义互逆）', () => {
    const escape = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
    const csv = 'question,answer,type,options\n' +
      [escape('含"引号"与,逗号'), escape('答案'), escape('single'), escape('')].join(',') + '\n';
    const rows = parseCSV(csv);
    expect(rows[0].question).toBe('含"引号"与,逗号');
    expect(rows[0].answer).toBe('答案');
    expect(rows[0].type).toBe('single');
    expect(rows[0].options).toBeUndefined();
  });
});
