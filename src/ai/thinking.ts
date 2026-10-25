/**
 * 条目级思考等级（ai_channels.thinking_level）→ 厂商请求参数映射。
 *
 * 思考控制参数没有跨厂商统一标准，不能全局默认下发（OpenAI 等端点会拒绝未知参数，
 * 400），因此按条目存储抽象等级，请求时按模型 ID 识别厂商方言生成对应参数：
 *   Qwen3 混合推理（enable_thinking）:   {"enable_thinking": false}          — 仅开/关
 *   GLM / 豆包（thinking）:              {"thinking": {"type": "disabled"}}  — 仅开/关
 *   OpenAI o 系 / gpt-5 / Gemini 等:     {"reasoning_effort": "low"}         — 支持分档
 *                                         （o 系不接受 minimal，关闭思考映射为 low）
 *
 * 与 extra_params 的关系：同键时 extra_params 优先（合并顺序见 dispatcher.ts），
 * 需要完全自定义参数（如 Claude 的 budget_tokens）时仍用 extra_params。
 */

/** 思考等级（NULL/空 = 跟随厂商默认，不附加任何参数） */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** 合法输入集合：''（清除）+ 四档等级（写路径校验用） */
const VALID_LEVELS: ReadonlySet<string> = new Set(['', 'off', 'low', 'medium', 'high']);

export interface ThinkingLevelValidation {
  ok: boolean;
  /** 入库值；空输入（undefined/null/空串）为 null（表示清除） */
  value: string | null;
  msg?: string;
}

/** 校验并规范化思考等级（写路径，管理面板/API 创建与更新条目时调用） */
export function normalizeThinkingLevel(input: unknown): ThinkingLevelValidation {
  if (input === undefined || input === null) return { ok: true, value: null };
  const s = String(input).trim();
  if (!VALID_LEVELS.has(s)) {
    return { ok: false, value: null, msg: '思考等级必须为 off/low/medium/high（留空=跟随厂商默认）' };
  }
  return { ok: true, value: s === '' ? null : s };
}

/**
 * 按模型 ID 把思考等级映射为厂商请求参数（读路径，调度与连通性测试时调用）：
 * 未设置等级返回 undefined（不附加）。
 */
export function buildThinkingParams(
  model: string,
  raw: string | null | undefined
): Record<string, unknown> | undefined {
  const level = normalizeThinkingLevel(raw).value;
  if (!level) return undefined;
  const m = (model || '').toLowerCase();
  if (/qwen/.test(m)) {
    return { enable_thinking: level !== 'off' };
  }
  if (/glm|doubao/.test(m)) {
    return { thinking: { type: level === 'off' ? 'disabled' : 'enabled' } };
  }
  if (level === 'off') {
    return { reasoning_effort: /gpt-5/.test(m) ? 'minimal' : 'low' };
  }
  return { reasoning_effort: level };
}
