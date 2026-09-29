import { describe, it, expect, vi, afterEach } from 'vitest';
import { callOpenAI } from './openai-client';

/** 构造一次成功的上游响应 */
const okFetch = () =>
  vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'm',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 取第 1 次 fetch 调用的请求体并解析（mock 无参签名，需经 unknown 取参） */
function requestBodyOf(fetchMock: ReturnType<typeof okFetch>): Record<string, unknown> {
  const init = (fetchMock.mock.calls[0] as unknown[])[1] as { body: string };
  return JSON.parse(init.body);
}

describe('callOpenAI：请求体构造（extra_params 合并）', () => {
  it('extraParams 合并进请求体；核心字段不可被同名键覆盖', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      messages: [{ role: 'user', content: '题目' }],
      baseUrl: 'https://a.test/v1',
      apiKey: 'sk-x',
      model: 'real-model',
      temperature: 0.7,
      maxTokens: 4096,
      timeout: 5,
      // 恶意/误配的同名键：必须被核心字段压住（写入侧已校验拒绝，此处是合并顺序的双保险）
      extraParams: { enable_thinking: false, model: 'evil', temperature: 9, messages: [], max_tokens: 1 },
    });

    const body = requestBodyOf(fetchMock);
    expect(body.model).toBe('real-model');
    expect(body.temperature).toBe(0.7);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'user', content: '题目' }]);
    expect(body.enable_thinking).toBe(false); // 正常附加参数生效
  });

  it('无 extraParams 时请求体字段与原先一致（不多不少）', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      messages: [{ role: 'user', content: '题目' }],
      baseUrl: 'https://a.test/v1',
      apiKey: 'sk-x',
      model: 'm',
      temperature: 0.7,
      maxTokens: 4096,
      timeout: 5,
    });

    const body = requestBodyOf(fetchMock);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
  });

  it('嵌套附加参数（thinking.type 形态）原样传递', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);

    await callOpenAI({
      messages: [{ role: 'user', content: '题目' }],
      baseUrl: 'https://a.test/v1',
      apiKey: 'sk-x',
      model: 'm',
      temperature: 0.7,
      maxTokens: 4096,
      timeout: 5,
      extraParams: { thinking: { type: 'disabled' } },
    });

    const body = requestBodyOf(fetchMock);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
});
