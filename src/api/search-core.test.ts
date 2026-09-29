import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSearchInput, truncate, performSearch } from './search-core';
import { dispatchAI } from '../ai/dispatcher';
import { normalizeAndHash, questionHash } from '../cache/normalize';
import type { Env } from '../types/env';

vi.mock('../ai/dispatcher', () => ({ dispatchAI: vi.fn() }));

describe('parseSearchInput', () => {
  it('最小合法请求通过', () => {
    const r = parseSearchInput({ title: ' 1+1=? ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.title).toBe(' 1+1=? ');
      expect(r.input.images).toBeUndefined();
    }
  });

  it('title 缺失/非字符串/空白被拒绝', () => {
    expect(parseSearchInput({}).ok).toBe(false);
    expect(parseSearchInput({ title: 123 }).ok).toBe(false);
    expect(parseSearchInput({ title: '   ' }).ok).toBe(false);
    expect(parseSearchInput(null).ok).toBe(false);
  });

  it('title/options 超长被拒绝', () => {
    expect(parseSearchInput({ title: 'x'.repeat(8193) }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', options: 'o'.repeat(16385) }).ok).toBe(false);
  });

  it('type/options 非字符串被拒绝', () => {
    expect(parseSearchInput({ title: 't', type: 1 }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', options: ['A'] }).ok).toBe(false);
  });

  it('images 非数组（含字符串）被拒绝，不再按字符迭代', () => {
    expect(parseSearchInput({ title: 't', images: 'https://x/y.png' }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', images: [1] }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', images: {} }).ok).toBe(false);
  });

  it('images 过滤空串与 null，全部为空则视为无图', () => {
    const r = parseSearchInput({ title: 't', images: [' https://a.png ', '', null, undefined] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.images).toEqual(['https://a.png']);

    const r2 = parseSearchInput({ title: 't', images: ['', null] });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.input.images).toBeUndefined();
  });

  it('图片数量与 URL 长度受限', () => {
    const ten = Array.from({ length: 10 }, () => 'https://a.png');
    expect(parseSearchInput({ title: 't', images: ten }).ok).toBe(true);
    expect(parseSearchInput({ title: 't', images: [...ten, 'https://b.png'] }).ok).toBe(false);
    expect(parseSearchInput({ title: 't', images: ['https://' + 'x'.repeat(8200)] }).ok).toBe(false);
  });
});

describe('truncate', () => {
  it('null/undefined/空串返回 null', () => {
    expect(truncate(null, 10)).toBeNull();
    expect(truncate(undefined, 10)).toBeNull();
    expect(truncate('', 10)).toBeNull();
  });

  it('短字符串原样返回', () => {
    expect(truncate('abc', 10)).toBe('abc');
  });

  it('超长截断并追加标记', () => {
    const out = truncate('a'.repeat(20), 10);
    expect(out).toBe('a'.repeat(10) + '\n...[truncated]');
    expect(out!.length).toBeLessThanOrEqual(10 + '\n...[truncated]'.length);
  });
});

// ======================================================================
// performSearch：缓存键含选项的查询/写入链路（mock D1 + mock dispatchAI）
// ======================================================================

interface FakeRow {
  id: string;
  question: string;
  answer: string;
  type?: string | null;
  options?: string | null;
  source?: string | null;
  ai_model?: string | null;
}

/** 极简 D1 mock：questions 表按 question_hash 查询；其余语句（UPDATE/INSERT/日志探测）仅记录 */
function makeEnv(rowsByHash: Record<string, FakeRow>) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...ps: unknown[]) { stmt.params = ps; return stmt; },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: stmt.params });
          if (/FROM questions WHERE question_hash/.test(sql)) {
            const row = rowsByHash[stmt.params[0] as string];
            return (row ? { ...row } : null) as T | null;
          }
          return null; // search_logs 列探测等
        },
        async run() { executed.push({ sql, params: stmt.params }); return { meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(list: Array<{ sql: string; params: unknown[] } | null>) {
      for (const s of list) if (s) executed.push({ sql: s.sql, params: s.params });
      return (list || []).map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { env: { DB: db } as unknown as Env, executed };
}

const TITLE = '下列哪项是正确的';
const OPTS = 'A. 甲\nB. 乙\nC. 丙';

const aiResult = {
  content: 'AI 新答案', channelName: '测试渠道', model: 'test-model',
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  url: 'https://ai.test', httpStatus: 200,
  rawRequest: 'req', rawResponse: 'res', attempts: [],
};

function questionSelects(executed: Array<{ sql: string; params: unknown[] }>): number {
  return executed.filter(e => /FROM questions WHERE question_hash/.test(e.sql)).length;
}

function insertStmts(executed: Array<{ sql: string; params: unknown[] }>): Array<{ sql: string; params: unknown[] }> {
  return executed.filter(e => /INSERT INTO questions/.test(e.sql));
}

beforeEach(() => {
  vi.mocked(dispatchAI).mockReset();
});

describe('performSearch（缓存键含选项）', () => {
  it('新键（题干+选项）直接命中：不调 AI，仅一次 questions 查询', async () => {
    const { hash } = await normalizeAndHash(TITLE, OPTS);
    const { env, executed } = makeEnv({
      [hash]: { id: 'q1', question: TITLE, answer: '缓存答案', options: OPTS },
    });

    const r = await performSearch(env, { title: TITLE, options: OPTS }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(true);
    expect(r.answer).toBe('缓存答案');
    expect(dispatchAI).not.toHaveBeenCalled();
    expect(questionSelects(executed)).toBe(1);
  });

  it('同题干不同选项不共享缓存：新键未命中且无旧条目 → 走 AI，答案以新键入库', async () => {
    const { hash: legacyHash } = await normalizeAndHash(TITLE);
    const { hash: newHash } = await normalizeAndHash(TITLE, OPTS);
    // 旧库存量条目：仅题干哈希、选项不同（修复前会错误命中并返回错误答案）
    const { env, executed } = makeEnv({
      [legacyHash]: { id: 'q-old', question: TITLE, answer: '旧选项的答案', options: 'A. 甲\nB. 丁' },
    });
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    const r = await performSearch(env, { title: TITLE, options: OPTS }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(false); // 未串到旧选项答案
    expect(r.answer).toBe('AI 新答案');
    expect(dispatchAI).toHaveBeenCalledTimes(1);
    // 新键（含选项）入库，不覆盖旧条目（旧键条目保留，无选项请求仍可命中）
    const inserts = insertStmts(executed);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[3]).toBe(newHash);
    expect(inserts[0].params[3]).not.toBe(legacyHash);
  });

  it('旧键回退命中且选项一致：返回缓存答案，并以新键回写变体', async () => {
    const legacyHash = await questionHash((await normalizeAndHash(TITLE)).normalized);
    const { hash: newHash } = await normalizeAndHash(TITLE, OPTS);
    const { env, executed } = makeEnv({
      [legacyHash]: { id: 'q-legacy', question: TITLE, answer: '存量答案', options: OPTS, source: 'ai', ai_model: 'm1' },
    });

    // 选项顺序/标签风格不同，但归一化一致
    const r = await performSearch(env, { title: TITLE, options: 'C、丙\nA、甲\nB、乙' }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(true);
    expect(r.answer).toBe('存量答案');
    expect(dispatchAI).not.toHaveBeenCalled();
    // 新键（含选项）回写变体，下次直接命中新键
    const inserts = insertStmts(executed);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[3]).toBe(newHash);
    expect(questionSelects(executed)).toBe(2); // 新键一次 + 旧键回退一次
  });

  it('旧键回退命中但库内无选项可校验：视为未命中，走 AI', async () => {
    const legacyHash = await questionHash((await normalizeAndHash(TITLE)).normalized);
    const { env } = makeEnv({
      [legacyHash]: { id: 'q-noopts', question: TITLE, answer: '无选项答案', options: null },
    });
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    const r = await performSearch(env, { title: TITLE, options: OPTS }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(false);
    expect(r.answer).toBe('AI 新答案');
    expect(dispatchAI).toHaveBeenCalledTimes(1);
  });

  it('无选项请求：哈希与旧版一致，单次查询即命中（存量兼容）', async () => {
    const { hash } = await normalizeAndHash(TITLE);
    const { env, executed } = makeEnv({
      [hash]: { id: 'q2', question: TITLE, answer: '无选项缓存' },
    });

    const r = await performSearch(env, { title: TITLE }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(true);
    expect(r.answer).toBe('无选项缓存');
    expect(questionSelects(executed)).toBe(1);
    expect(dispatchAI).not.toHaveBeenCalled();
  });

  it('退化选项（归一化为空，如纯标签行）按无选项处理：题干键单次命中，不做旧键回退', async () => {
    const { hash } = await normalizeAndHash(TITLE);
    const { env, executed } = makeEnv({
      [hash]: { id: 'q3', question: TITLE, answer: '退化选项缓存' },
    });

    // options 字段存在但归一化为空 → 与无选项请求同键，不触发带选项的旧键回退路径
    const r = await performSearch(env, { title: TITLE, options: 'A.' }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(true);
    expect(r.answer).toBe('退化选项缓存');
    expect(questionSelects(executed)).toBe(1);
    expect(dispatchAI).not.toHaveBeenCalled();
  });
});
