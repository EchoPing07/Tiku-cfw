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

  it('type 非字符串被拒绝；options 数组按行拼接（兼容 OCS 官方 handler 示例）', () => {
    expect(parseSearchInput({ title: 't', type: 1 }).ok).toBe(false);

    const r = parseSearchInput({ title: 't', options: ['A. 甲', 'B. 乙', '', null] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.options).toBe('A. 甲\nB. 乙');

    expect(parseSearchInput({ title: 't', options: [1] }).ok).toBe(false);
  });

  it('type=unknown（OCS 5.x 缺省值）折叠为 undefined；中文/别名题型归一化', () => {
    const unknown = parseSearchInput({ title: 't', type: 'unknown' });
    expect(unknown.ok).toBe(true);
    if (unknown.ok) expect(unknown.input.type).toBeUndefined();

    const zh = parseSearchInput({ title: 't', type: '多选题' });
    expect(zh.ok).toBe(true);
    if (zh.ok) expect(zh.input.type).toBe('multiple');

    const alias = parseSearchInput({ title: 't', type: 'single_choice' });
    expect(alias.ok).toBe(true);
    if (alias.ok) expect(alias.input.type).toBe('single');
  });

  it('图片题优化 v2：base64 data URL 不再按 URL 长度拒绝（≤5 MiB 可用）', () => {
    const b64 = 'data:image/png;base64,' + 'A'.repeat(200 * 1024);
    const r = parseSearchInput({ title: '题 [图片1]', images: [b64] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.input.images).toEqual([b64]);
  });

  it('图片题优化 v2：单张/总量超限仍拒绝', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024);
    const r = parseSearchInput({ title: 't', images: [huge] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.msg).toContain('单张图片过大');
  });

  it('图片题优化 v2：suggestion_title/suggestion_options 接收字符串，空串视为未提供', () => {
    const r = parseSearchInput({
      title: '题 [图片1]',
      suggestion_title: '题 [图片1]',
      suggestion_options: 'A. [图片2]\nB. 乙',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input.suggestionTitle).toBe('题 [图片1]');
      expect(r.input.suggestionOptions).toBe('A. [图片2]\nB. 乙');
    }

    const empty = parseSearchInput({ title: 't', suggestion_title: '   ', suggestion_options: '' });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.input.suggestionTitle).toBeUndefined();
      expect(empty.input.suggestionOptions).toBeUndefined();
    }

    expect(parseSearchInput({ title: 't', suggestion_title: 1 }).ok).toBe(false);
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
  });});

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

// ======================================================================
// performSearch：入库门槛——空答案/拒答不入库（否则拒答文本永久污染缓存）
// ======================================================================
describe('performSearch（内嵌图片 URL 检测路由）', () => {
  it('title 内嵌 <img>：提取图片 URL 合并进 images 走视觉模型（治失败模式 A）', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    const r = await performSearch(env, { title: '如图<img src="https://x.com/a.png">所示，自由度为____' }, null);

    expect(r.found).toBe(true);
    expect(dispatchAI).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchAI).mock.calls[0][0].images).toEqual(['https://x.com/a.png']);
  });

  it('title 内嵌裸图片 URL：同样路由视觉模型', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '自由度为____ https://x.com/a.png' }, null);

    expect(vi.mocked(dispatchAI).mock.calls[0][0].images).toEqual(['https://x.com/a.png']);
  });

  it('超星无后缀图（/ananas/ 默认模式）也路由视觉模型，images 为归一化 URL（身份形态）', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '自由度为____ https://mooc1.chaoxing.com/ananas/latex/p/12345.png' }, null);

    // images 传归一化 URL（与 dispatcher 端提取键一致，保证图文交错定位与去重）；
    // 实际抓取用 fetchUrl 原始形态（.png），在 dispatcher 内部处理
    const call = vi.mocked(dispatchAI).mock.calls[0][0];
    expect(call.images).toEqual(['https://mooc1.chaoxing.com/ananas/latex/p/12345']);
  });

  it('内嵌 URL 与显式 images 数组合并去重（客户端数组优先）', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(
      env,
      { title: '如图 https://x.com/a.png 所示', images: ['https://x.com/a.png', 'https://x.com/b.png'] },
      null
    );

    expect(vi.mocked(dispatchAI).mock.calls[0][0].images).toEqual([
      'https://x.com/a.png',
      'https://x.com/b.png',
    ]);
  });

  it('纯图题不再被“内容无效”拒绝：走 AI 正常作答（治失败模式 D）', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    const r = await performSearch(env, { title: '<img src="https://x.com/a.png">' }, null);

    expect(r.found).toBe(true);
    expect(r.answer).toBe('AI 新答案');
    expect(r.invalidInput).toBeUndefined();
    expect(dispatchAI).toHaveBeenCalledTimes(1);
  });

  it('Tier 2 URL（无图片特征的链接）不路由视觉模型：仍走文本链路', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '详见 https://x.com/doc/page1 说明' }, null);

    expect(vi.mocked(dispatchAI).mock.calls[0][0].images).toEqual([]);
  });

  it('含 URL 的题不走旧键回退（旧键形态必然 miss，省一次查询）', async () => {
    const { env, executed } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '如图 https://x.com/a.png 所示', options: 'A. 甲\nB. 乙' }, null);

    expect(questionSelects(executed)).toBe(1); // 仅新键一次，无旧键回退
  });

  it('失败模式 B 回归：图不同同文字的两次搜题互不命中缓存（各自走 AI 入库）', async () => {
    const { env, executed } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '如图<img src="https://x.com/a.png">所示，自由度为____' }, null);
    await performSearch(env, { title: '如图<img src="https://x.com/b.png">所示，自由度为____' }, null);

    expect(dispatchAI).toHaveBeenCalledTimes(2); // 第二题不得命中第一题的缓存
    expect(insertStmts(executed)).toHaveLength(2);
    const hashA = insertStmts(executed)[0].params[3];
    const hashB = insertStmts(executed)[1].params[3];
    expect(hashA).not.toBe(hashB);
  });

  it('同图不同包装形态的第二次搜题直接命中缓存（不重复调 AI）', async () => {
    const { hash } = await normalizeAndHash('如图<img src="https://x.com/a.png">所示，自由度为____');
    const { env } = makeEnv({
      [hash]: { id: 'q-img', question: '如图…所示，自由度为____', answer: '缓存图题答案' },
    });

    // 裸 URL 形态与 img 包装同键 → 命中
    const r = await performSearch(env, { title: '如图 https://x.com/a.png 所示，自由度为____' }, null);

    expect(r.found).toBe(true);
    expect(r.fromCache).toBe(true);
    expect(r.answer).toBe('缓存图题答案');
    expect(dispatchAI).not.toHaveBeenCalled();
  });
});

describe('performSearch（入库门槛）', () => {
  it('拒答文本不入库：返回未找到，无 questions INSERT', async () => {
    const { env, executed } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue({ ...aiResult, content: '题目不完整，无法作答' });

    const r = await performSearch(env, { title: TITLE }, null);

    expect(r.found).toBe(false);
    expect(r.fromCache).toBe(false);
    expect(r.answer).toBeNull();
    expect(r.errorType).toBe('refusal');
    expect(r.error).toContain('未入库');
    expect(insertStmts(executed)).toHaveLength(0); // 拒答绝不写入题库
  });

  it('空答案不入库', async () => {
    const { env, executed } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue({ ...aiResult, content: '   ' });

    const r = await performSearch(env, { title: TITLE }, null);

    expect(r.found).toBe(false);
    expect(r.answer).toBeNull();
    expect(r.errorType).toBe('refusal');
    expect(insertStmts(executed)).toHaveLength(0);
  });

  it('短拒答措辞（如「无法确定」）不入库', async () => {
    const { env, executed } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue({ ...aiResult, content: '无法确定' });

    const r = await performSearch(env, { title: TITLE }, null);

    expect(r.found).toBe(false);
    expect(insertStmts(executed)).toHaveLength(0);
  });

  it('正常答案不受门槛影响（回归）', async () => {
    const { hash } = await normalizeAndHash(TITLE, OPTS);
    const { env, executed } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    const r = await performSearch(env, { title: TITLE, options: OPTS }, null);

    expect(r.found).toBe(true);
    expect(r.answer).toBe('AI 新答案');
    const inserts = insertStmts(executed);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[3]).toBe(hash);
  });
});

// ======================================================================
// performSearch：OCS 图片题优化 v2（base64 图 + [图片N] 占位文本）
// ======================================================================
describe('performSearch（OCS v2 图片题优化）', () => {
  const IMG_A = 'data:image/png;base64,' + 'A'.repeat(500);
  const IMG_B = 'data:image/png;base64,' + 'B'.repeat(500);

  it('base64 图进 inlineImages（不再当 URL 抓取），suggestion_* 透传给 dispatcher', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, {
      title: '题干 [图片1] 与 [图片2]',
      type: 'single',
      options: 'A. [图片3]',
      images: [IMG_A, IMG_B],
      suggestionTitle: '题干 [图片1] 与 [图片2]',
      suggestionOptions: 'A. [图片3]',
    }, null);

    const call = vi.mocked(dispatchAI).mock.calls[0][0];
    expect(call.inlineImages).toEqual([IMG_A, IMG_B]);
    expect(call.images).toEqual([]); // base64 不进 URL 抓取列表
    expect(call.suggestionTitle).toBe('题干 [图片1] 与 [图片2]');
    expect(call.suggestionOptions).toBe('A. [图片3]');
    expect(call.type).toBe('single');
  });

  it('base64 图内容参与缓存键：同题同图命中缓存，换图不串答案', async () => {
    const input = { title: '题干 [图片1]', images: [IMG_A] };

    // 第一次：未命中 → AI
    const first = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);
    const r1 = await performSearch(first.env, input, null);
    expect(r1.fromCache).toBe(false);

    // 取出实际写入的缓存键，模拟该行已入库
    const insertedHash = insertStmts(first.executed)[0].params[3] as string;

    // 第二次：同题同图 → 命中
    const second = makeEnv({ [insertedHash]: { id: 'q-img', question: '题干 [图片1]', answer: '缓存图答案' } });
    const r2 = await performSearch(second.env, input, null);
    expect(r2.fromCache).toBe(true);
    expect(r2.answer).toBe('缓存图答案');

    // 第三次：同题干、不同图 → 不同键，必须未命中
    const third = makeEnv({ [insertedHash]: { id: 'q-img', question: '题干 [图片1]', answer: '缓存图答案' } });
    vi.mocked(dispatchAI).mockResolvedValue({ ...aiResult, content: '另一张图的答案' });
    const r3 = await performSearch(third.env, { title: '题干 [图片1]', images: [IMG_B] }, null);
    expect(r3.fromCache).toBe(false);
    expect(r3.answer).toBe('另一张图的答案');
  });

  it('无图题（images 为空数组）仍走文本链路', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '纯文本题', images: [] }, null);

    const call = vi.mocked(dispatchAI).mock.calls[0][0];
    expect(call.inlineImages).toEqual([]);
    expect(call.images).toEqual([]);
  });

  it('http(s) 图与 base64 图可共存：前者进 images（抓取），后者进 inlineImages', async () => {
    const { env } = makeEnv({});
    vi.mocked(dispatchAI).mockResolvedValue(aiResult);

    await performSearch(env, { title: '题 [图片1]', images: [IMG_A, 'https://x.com/a.png'] }, null);

    const call = vi.mocked(dispatchAI).mock.calls[0][0];
    expect(call.inlineImages).toEqual([IMG_A]);
    expect(call.images).toEqual(['https://x.com/a.png']);
  });
});
