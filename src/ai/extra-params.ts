/**
 * 条目级附加请求参数（ai_channels.extra_params，JSON 对象字符串）。
 *
 * 调用时合并进 /chat/completions 请求体，用于同一份请求模板覆盖不了厂商差异参数。
 * 典型用途：混合推理模型显式关闭思考——思考默认开启的模型答题时既慢又贵，
 * 还容易把 max_tokens 全部耗在思考段导致 content 为空（见 openai-client.ts 的 empty_content）：
 *   Qwen（enable_thinking）:  {"enable_thinking": false}
 *   GLM / 豆包（thinking）:   {"thinking": {"type": "disabled"}}
 *   OpenAI 推理系（effort）:  {"reasoning_effort": "minimal"}
 *
 * 注意：不能全局默认下发——OpenAI 等端点会拒绝未知参数（400），必须按条目按厂商配置。
 * 请求体合并时核心字段（model/messages/temperature/max_tokens）始终优先，见 openai-client.ts。
 */

/** 核心字段：extra_params 不允许覆盖（校验拒绝 + 合并顺序兜底，双重保险） */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['model', 'messages', 'temperature', 'max_tokens']);

/** 序列化后的长度上限（防误贴大段内容进日志与请求体） */
const MAX_JSON_LEN = 2000;

/** 键数量上限 */
const MAX_KEYS = 20;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface ExtraParamsValidation {
  ok: boolean;
  /** 存储用 JSON 字符串；空输入（undefined/null/空串/空对象）为 null（表示清除） */
  value: string | null;
  msg?: string;
}

/**
 * 校验并规范化 extra_params（写路径，管理面板/API 创建与更新条目时调用）：
 * 接受 JSON 字符串（表单 textarea）或已解析的对象（API 调用方），返回可直接入库的字符串。
 */
export function validateExtraParams(input: unknown): ExtraParamsValidation {
  if (input === undefined || input === null) return { ok: true, value: null };

  let obj: unknown;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return { ok: true, value: null };
    try {
      obj = JSON.parse(s);
    } catch {
      return { ok: false, value: null, msg: '附加参数不是合法 JSON（应为对象，如 {"enable_thinking": false}）' };
    }
  } else {
    obj = input;
  }

  if (!isPlainObject(obj)) {
    return { ok: false, value: null, msg: '附加参数必须是 JSON 对象（如 {"enable_thinking": false}），不能是数组或标量' };
  }

  const entries = Object.entries(obj);
  if (entries.length === 0) return { ok: true, value: null };
  if (entries.length > MAX_KEYS) {
    return { ok: false, value: null, msg: `附加参数最多 ${MAX_KEYS} 个键` };
  }
  for (const [k] of entries) {
    if (RESERVED_KEYS.has(k)) {
      return { ok: false, value: null, msg: `附加参数不允许覆盖核心字段：${k}（请使用条目自身的对应字段）` };
    }
  }

  const json = JSON.stringify(obj);
  if (json.length > MAX_JSON_LEN) {
    return { ok: false, value: null, msg: `附加参数过长（≤${MAX_JSON_LEN} 字符）` };
  }
  return { ok: true, value: json };
}

/**
 * 解析 extra_params（读路径，调度与连通性测试时调用）：
 * 空/非法 JSON/非对象一律返回 undefined（不附加任何参数）——
 * 存量配置错误不应让搜题整链路失败，降级为"按无附加参数调用"并留 console 痕迹。
 */
export function parseExtraParams(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (!isPlainObject(v)) {
      console.warn('[extra_params] 非 JSON 对象，已忽略：', raw.slice(0, 120));
      return undefined;
    }
    return v;
  } catch {
    console.warn('[extra_params] 非法 JSON，已忽略：', raw.slice(0, 120));
    return undefined;
  }
}
