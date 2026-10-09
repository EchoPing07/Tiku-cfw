import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dispatchAI } from './dispatcher';
import { callOpenAI } from './openai-client';
import { fetchImagesAsDataUrls } from './image-fetch';
import { AIError } from './types';
import type { AIChannelRow, AIErrorType } from './types';
import type { Env } from '../types/env';

vi.mock('./openai-client', () => ({ callOpenAI: vi.fn() }));
// 视觉链路会先在 Worker 侧下载图片转 base64；测试中 mock 为“全部下载失败”
// （回退原始 URL），避免真实联网
vi.mock('./image-fetch', () => ({ fetchImagesAsDataUrls: vi.fn(async () => new Map()) }));

const mockedCall = vi.mocked(callOpenAI);

function makeChannel(overrides: Partial<AIChannelRow> = {}): AIChannelRow {
  return {
    id: 'ch1', name: '渠道A', type: 'text', base_url: 'https://a.test/v1',
    model: 'test-model', api_key: 'sk-abcdefghijklmnop', weight: 1,
    temperature: 0.7, max_tokens: 4096, extra_params: null,
    enabled: 1, use_count: 0, fail_count: 0,
    last_used: null, disabled_until: null,
    created_at: '2024-01-01 00:00:00', updated_at: '2024-01-01 00:00:00',
    ...overrides,
  };
}

/** 极简 D1 mock：settings/ai_channels 查询返回固定数据，其余语句仅记录 */
function makeEnv(channels: AIChannelRow[], settings: Record<string, string> = {}) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        bind(...ps: unknown[]) { stmt.params = ps; return stmt; },
        async all<T>(): Promise<{ results: T[] }> {
          executed.push({ sql, params: stmt.params });
          if (/FROM settings/.test(sql)) {
            return { results: Object.entries(settings).map(([key, value]) => ({ key, value })) as T[] };
          }
          if (/FROM ai_channels/.test(sql)) {
            return { results: channels.filter(c => c.type === stmt.params[0]) as T[] };
          }
          return { results: [] };
        },
        async first<T>(): Promise<T | null> {
          executed.push({ sql, params: stmt.params });
          return null;
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

const okResult = {
  content: '测试答案', model: 'test-model', usage: null,
  url: 'https://a.test/v1/chat/completions', httpStatus: 200,
  rawRequest: '{}', rawResponse: '{}',
};

function aiErr(type: AIErrorType, msg = 'mock error', httpStatus: number | null = null): AIError {
  return new AIError(msg, type, 'req', 'resp', undefined, httpStatus);
}

const failCountUpdates = (executed: Array<{ sql: string }>) =>
  executed.filter(e => /SET fail_count = CASE/.test(e.sql));
const useCountUpdates = (executed: Array<{ sql: string }>) =>
  executed.filter(e => /SET use_count = use_count \+ 1/.test(e.sql));

/** 固定 Math.random=0 使 weightedRandomOrder 按传入顺序取条目（多渠道测试确定性） */
function fixChannelOrder() {
  return vi.spyOn(Math, 'random').mockReturnValue(0);
}

const mockedFetch = vi.mocked(fetchImagesAsDataUrls);

beforeEach(() => {
  mockedCall.mockReset();
  mockedFetch.mockReset();
  // 默认“全部下载失败”（回退原始 URL），个别测试按需覆盖
  mockedFetch.mockResolvedValue(new Map());
});

describe('dispatchAI：超时与预算（通道类型区分）', () => {
  it('文本通道：单次超时用 ai_timeout（默认 30s）', async () => {
    const { env } = makeEnv([makeChannel()]);
    mockedCall.mockResolvedValue(okResult);
    await dispatchAI({ title: '题目', env });
    expect(mockedCall.mock.calls[0][0].timeout).toBe(30);
  });

  it('视觉通道：单次超时用 vision_timeout（默认 60s）', async () => {
    const { env } = makeEnv([makeChannel({ type: 'vision' })]);
    mockedCall.mockResolvedValue(okResult);
    await dispatchAI({ title: '题目', env, images: ['https://a.png'] });
    expect(mockedCall.mock.calls[0][0].timeout).toBe(60);
  });

  it('设置可覆盖两种超时', async () => {
    const { env } = makeEnv(
      [makeChannel(), makeChannel({ id: 'ch2', name: '渠道B', type: 'vision' })],
      { ai_timeout: '45', vision_timeout: '80' },
    );
    mockedCall.mockResolvedValue(okResult);
    await dispatchAI({ title: '题目', env });
    expect(mockedCall.mock.calls[0][0].timeout).toBe(45);
    await dispatchAI({ title: '题目', env, images: ['https://a.png'] });
    expect(mockedCall.mock.calls[1][0].timeout).toBe(80);
  });

  it('文本通道预算 60s：耗尽后中止剩余条目并抛 budget 错误', async () => {
    // 固定时钟 + 手动推进：第一渠道失败耗时 61s，第二循环首检即超预算
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { env } = makeEnv([makeChannel(), makeChannel({ id: 'ch2', name: '渠道B' })]);
      mockedCall.mockImplementation(async () => { now += 61_000; throw aiErr('network', '网络错误'); });
      await expect(dispatchAI({ title: '题目', env })).rejects.toMatchObject({
        errorType: 'budget',
        message: expect.stringContaining('60s'),
      });
      expect(mockedCall).toHaveBeenCalledTimes(1); // 第二条目未再尝试
    } finally {
      clock.mockRestore();
    }
  });

  it('视觉通道预算 90s', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { env } = makeEnv([makeChannel({ type: 'vision' }), makeChannel({ id: 'ch2', name: '渠道B', type: 'vision' })]);
      mockedCall.mockImplementation(async () => { now += 91_000; throw aiErr('network', '网络错误'); });
      await expect(dispatchAI({ title: '题目', env, images: ['https://a.png'] })).rejects.toMatchObject({
        errorType: 'budget',
        message: expect.stringContaining('90s'),
      });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('dispatchAI：同条目瞬时错误重试', () => {
  it('瞬时错误（429）重试一次成功：不计失败、不触发熔断，尝试链记录两跳', async () => {
    const { env, executed } = makeEnv([makeChannel()]);
    mockedCall
      .mockRejectedValueOnce(aiErr('http_rate', '限流', 429))
      .mockResolvedValueOnce(okResult);

    const r = await dispatchAI({ title: '题目', env });

    expect(r.content).toBe('测试答案');
    expect(mockedCall).toHaveBeenCalledTimes(2);
    // 重试成功：use_count 只加一次、无 fail_count 熔断计数
    expect(useCountUpdates(executed)).toHaveLength(1);
    expect(failCountUpdates(executed)).toHaveLength(0);
    // 尝试链：失败 → 成功，同一渠道
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts.map(a => a.ok)).toEqual([false, true]);
    expect(r.attempts[0].channel).toBe('渠道A');
    expect(r.attempts[0].error_type).toBe('http_rate');
  });

  it('非瞬时错误（401）不重试：立即换下一条目', async () => {
    const randomSpy = fixChannelOrder();
    try {
      const { env } = makeEnv([makeChannel(), makeChannel({ id: 'ch2', name: '渠道B', base_url: 'https://b.test/v1' })]);
      mockedCall.mockImplementation(async (req) => {
        if (req.baseUrl === 'https://b.test/v1') return okResult;
        throw aiErr('http_auth', '无效 Key', 401);
      });

      const r = await dispatchAI({ title: '题目', env });

      expect(r.content).toBe('测试答案');
      expect(mockedCall).toHaveBeenCalledTimes(2); // 每渠道各一次，无重试
      expect(r.attempts).toHaveLength(2);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('瞬时错误重试仍失败：计入熔断并换下一条目，两条目共 3 次尝试', async () => {
    const randomSpy = fixChannelOrder();
    try {
      const { env, executed } = makeEnv([makeChannel(), makeChannel({ id: 'ch2', name: '渠道B', base_url: 'https://b.test/v1' })]);
      mockedCall.mockImplementation(async (req) => {
        if (req.baseUrl === 'https://b.test/v1') return okResult;
        throw aiErr('timeout', '超时'); // 渠道A 永远超时（含重试）
      });

      const r = await dispatchAI({ title: '题目', env });

      expect(r.content).toBe('测试答案');
      expect(mockedCall).toHaveBeenCalledTimes(3); // A×2（含重试）+ B×1
      expect(failCountUpdates(executed)).toHaveLength(1); // 仅 A 计最终失败（A 重试前的临时失败不计）
      expect(r.attempts.map(a => a.channel)).toEqual(['渠道A', '渠道A', '渠道B']);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('预算不足退避时不重试：直接计入失败并结束', async () => {
    // 单渠道；首次尝试耗掉 59.9s 后超时，剩余预算(100ms) < 退避(400ms) → 不重试
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { env, executed } = makeEnv([makeChannel()]);
      mockedCall.mockImplementation(async () => { now += 59_900; throw aiErr('timeout', '超时'); });

      await expect(dispatchAI({ title: '题目', env })).rejects.toMatchObject({ errorType: 'timeout' });
      expect(mockedCall).toHaveBeenCalledTimes(1); // 无重试
      expect(failCountUpdates(executed)).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('单次尝试超时被剩余预算钳制（预算是硬顶，不再越过预算拖满超时）', async () => {
    // 两渠道：A 耗掉 59s 后失败（非瞬时），B 仅剩 1s 预算 → B 的 attempt timeout 应为 1s
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const randomSpy = fixChannelOrder();
    try {
      const { env } = makeEnv([makeChannel(), makeChannel({ id: 'ch2', name: '渠道B', base_url: 'https://b.test/v1' })]);
      mockedCall.mockImplementation(async (req) => {
        if (req.baseUrl === 'https://b.test/v1') { now += 2_000; throw aiErr('timeout', '超时'); }
        now += 59_000;
        throw aiErr('http_auth', '无效 Key', 401);
      });

      // A(401 非瞬时，不重试) → B 预算只剩 1s：timeout 钳到 1；两渠道耗尽后抛「所有模型均不可用」
      await expect(dispatchAI({ title: '题目', env })).rejects.toMatchObject({ errorType: 'http_auth' });
      expect(mockedCall).toHaveBeenCalledTimes(2);
      expect(mockedCall.mock.calls[0][0].timeout).toBe(30);  // A：min(30, 60)
      expect(mockedCall.mock.calls[1][0].timeout).toBe(1);   // B：min(30, 1)，预算硬顶
    } finally {
      clock.mockRestore();
      randomSpy.mockRestore();
    }
  });
});

describe('dispatchAI：视觉链路（内嵌图片检测路由 + ANSWER 协议）', () => {
  it('title 内嵌图片：消息图文交错（图片按原文位置），抓取目标为 fetchUrl 形态', async () => {
    const { env } = makeEnv([makeChannel({ type: 'vision' })]);
    mockedCall.mockResolvedValue(okResult);
    mockedFetch.mockResolvedValue(new Map([['https://x/a.png', 'data:image/png;base64,AAA']]));

    await dispatchAI({
      title: '前文 https://x/a.png 后文',
      env,
      images: ['https://x/a.png'],
    });

    // 抓取目标：fetchUrl 原始形态
    expect(mockedFetch.mock.calls[0][0]).toEqual([{ key: 'https://x/a.png', url: 'https://x/a.png' }]);
    // 消息：图文交错 + data URL 内联
    const content = mockedCall.mock.calls[0][0].messages[1].content as Array<Record<string, any>>;
    const img = content.find((p) => p.type === 'image_url')!;
    expect(img.image_url).toEqual({ url: 'data:image/png;base64,AAA', detail: 'high' });
    expect(content[0].type).toBe('text');
  });

  it('超星 LaTeX：抓取用原始 .png 形态，消息用归一化键定位', async () => {
    const { env } = makeEnv([makeChannel({ type: 'vision' })]);
    mockedCall.mockResolvedValue(okResult);

    await dispatchAI({
      title: '自由度为 https://mooc1.chaoxing.com/ananas/latex/p/12345.png',
      env,
      images: ['https://mooc1.chaoxing.com/ananas/latex/p/12345'],
    });

    expect(mockedFetch.mock.calls[0][0]).toEqual([
      { key: 'https://mooc1.chaoxing.com/ananas/latex/p/12345', url: 'https://mooc1.chaoxing.com/ananas/latex/p/12345.png' },
    ]);
    // 抓取失败回退原始 URL
    const content = mockedCall.mock.calls[0][0].messages[1].content as Array<Record<string, any>>;
    expect(content.find((p) => p.type === 'image_url')!.image_url.url).toBe(
      'https://mooc1.chaoxing.com/ananas/latex/p/12345.png'
    );
  });

  it('ANSWER 协议解析：编号映射选项正文（多选用 # 连接）', async () => {
    const { env } = makeEnv([makeChannel({ type: 'vision' })]);
    mockedCall.mockResolvedValue({ ...okResult, content: '分析过程略\nANSWER: 1 3' });

    const r = await dispatchAI({
      title: '如图所示 https://x/a.png 下列正确的是',
      type: 'multiple',
      options: 'A. 甲\nB. 乙\nC. 丙',
      env,
      images: ['https://x/a.png'],
    });

    expect(r.content).toBe('甲#丙');
  });

  it('无 ANSWER 行：回退通用 parseAIAnswer（兼容未遵循协议的模型）', async () => {
    const { env } = makeEnv([makeChannel({ type: 'vision' })]);
    mockedCall.mockResolvedValue({ ...okResult, content: '答案：传动角' });

    const r = await dispatchAI({
      title: '如图 https://x/a.png 机构压力角',
      type: 'completion',
      env,
      images: ['https://x/a.png'],
    });

    expect(r.content).toBe('传动角');
  });

  it('images 数组中不在文本里的额外图：抓取并追加在消息末尾（不重复内嵌图）', async () => {
    const { env } = makeEnv([makeChannel({ type: 'vision' })]);
    mockedCall.mockResolvedValue(okResult);

    await dispatchAI({
      title: '题干文字',
      env,
      images: ['https://extra/1.png', 'https://extra/2.png'],
    });

    expect(mockedFetch.mock.calls[0][0]).toEqual([
      { key: 'https://extra/1.png', url: 'https://extra/1.png' },
      { key: 'https://extra/2.png', url: 'https://extra/2.png' },
    ]);
    const content = mockedCall.mock.calls[0][0].messages[1].content as Array<Record<string, any>>;
    const imgs = content.filter((p) => p.type === 'image_url');
    expect(imgs).toHaveLength(2);
  });

  it('无可用视觉条目时直接失败，不浪费图片抓取', async () => {
    const { env } = makeEnv([]); // 无任何条目
    mockedFetch.mockClear();

    await expect(
      dispatchAI({ title: '题 https://x/a.png', env, images: ['https://x/a.png'] })
    ).rejects.toMatchObject({ errorType: 'no_channel' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});

describe('dispatchAI：条目级附加参数（extra_params）', () => {
  it('合法 JSON 合并进请求', async () => {
    const { env } = makeEnv([makeChannel({ extra_params: '{"enable_thinking": false}' })]);
    mockedCall.mockResolvedValue(okResult);
    await dispatchAI({ title: '题目', env });
    expect(mockedCall.mock.calls[0][0].extraParams).toEqual({ enable_thinking: false });
  });

  it('非法 JSON 降级为不附加（不阻塞搜题）', async () => {
    const { env } = makeEnv([makeChannel({ extra_params: 'not-json' })]);
    mockedCall.mockResolvedValue(okResult);
    const r = await dispatchAI({ title: '题目', env });
    expect(mockedCall.mock.calls[0][0].extraParams).toBeUndefined();
    expect(r.content).toBe('测试答案');
  });

  it('空（NULL）不附加', async () => {
    const { env } = makeEnv([makeChannel({ extra_params: null })]);
    mockedCall.mockResolvedValue(okResult);
    await dispatchAI({ title: '题目', env });
    expect(mockedCall.mock.calls[0][0].extraParams).toBeUndefined();
  });
});
