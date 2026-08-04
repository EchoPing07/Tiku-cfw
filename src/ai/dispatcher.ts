import type { Env } from '../types/env';
import type { ChatMessage, ChannelType, DispatchResult, AIChannelRow, AIChannelKeyRow } from './types';
import { AIError } from './types';
import { callOpenAI } from './openai-client';
import { buildSystemPrompt, buildUserMessage, buildVisionMessage } from './prompt';
import { parseAIAnswer } from './answer-parser';
import type { QuestionType } from './types';

interface DispatchOptions {
  title: string;
  type?: QuestionType;
  options?: string;
  images?: string[];
  env: Env;
}

/** 按权重分组 */
function groupByWeight<T extends { weight: number }>(items: T[]): T[][] {
  const groups: Map<number, T[]> = new Map();
  for (const item of items) {
    if (!groups.has(item.weight)) groups.set(item.weight, []);
    groups.get(item.weight)!.push(item);
  }
  // 按权重降序排列
  return Array.from(groups.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([, items]) => items);
}

/** 数组随机打乱 */
function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 多渠道 AI 调度器 */
export async function dispatchAI(opts: DispatchOptions): Promise<DispatchResult> {
  const { title, type, options, images, env } = opts;

  // 判断渠道类型
  const channelType: ChannelType = images && images.length > 0 ? 'vision' : 'text';

  // 读取设置（一次性查询，减少 D1 往返）
  let timeout = 30;
  let failThreshold = 3;
  let customPrompt = '';
  try {
    const settingsRes = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN ('ai_timeout', 'key_fail_threshold', 'system_prompt')`
    ).all<{ key: string; value: string }>();
    for (const r of settingsRes.results || []) {
      if (r.key === 'ai_timeout') timeout = parseInt(r.value, 10) || timeout;
      else if (r.key === 'key_fail_threshold') failThreshold = parseInt(r.value, 10) || failThreshold;
      else if (r.key === 'system_prompt') customPrompt = r.value;
    }
  } catch { /* 用默认值 */ }
  const systemPrompt = buildSystemPrompt(customPrompt);

  // 构建消息
  let messages: ChatMessage[];
  if (channelType === 'vision' && images && images.length > 0) {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildVisionMessage(title, images, type, options) },
    ];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildUserMessage(title, type, options) },
    ];
  }

  // 查询该类型下所有启用的渠道，按 weight DESC 排序
  const channels = await env.DB.prepare(
    'SELECT * FROM ai_channels WHERE type = ? AND enabled = 1 ORDER BY weight DESC'
  ).bind(channelType).all<AIChannelRow>();

  if (!channels.results || channels.results.length === 0) {
    throw new AIError(
      `没有可用的${channelType === 'text' ? '文本' : '视觉'}渠道`,
      JSON.stringify(messages, null, 2)
    );
  }

  // 按权重分组
  const weightGroups = groupByWeight(channels.results);

  // 一次性查询所有渠道下的启用 key，按 channel_id 分组（避免 N+1 查询）
  const channelIds = channels.results.map(c => c.id);
  const keysByChannel = new Map<string, AIChannelKeyRow[]>();
  if (channelIds.length > 0) {
    const placeholders = channelIds.map(() => '?').join(',');
    const allKeys = await env.DB.prepare(
      `SELECT * FROM ai_channel_keys WHERE channel_id IN (${placeholders}) AND enabled = 1 ORDER BY use_count ASC`
    ).bind(...channelIds).all<AIChannelKeyRow>();
    for (const k of allKeys.results || []) {
      if (!keysByChannel.has(k.channel_id)) keysByChannel.set(k.channel_id, []);
      keysByChannel.get(k.channel_id)!.push(k);
    }
  }

  // 追踪第一次和最后一次失败的错误信息，用于最终报错和日志
  // 第一次失败通常是根因（如 401 无效 key），最后一次失败可能是症状（如超时）
  let firstError = '';
  let firstRawRequest = '';
  let firstRawResponse = '';
  let lastError = '';
  let lastRawRequest = '';
  let lastRawResponse = '';

  // 从最高权重组开始尝试
  for (const group of weightGroups) {
    // 同权重组内随机打乱
    const shuffledChannels = shuffle(group);

    for (const channel of shuffledChannels) {
      const keys = keysByChannel.get(channel.id) || [];
      if (keys.length === 0) continue; // 此渠道无可用 key，跳过

      // 依次尝试每个 key
      for (const key of keys) {
        try {
          const result = await callOpenAI({
            messages,
            baseUrl: channel.base_url as string,
            apiKey: key.api_key as string,
            model: channel.model as string,
            temperature: channel.temperature as number,
            maxTokens: channel.max_tokens as number,
            timeout,
          });

          // 成功：use_count++，fail_count=0，last_used=now
          await env.DB.prepare(
            `UPDATE ai_channel_keys
             SET use_count = use_count + 1, fail_count = 0, last_used = datetime('now')
             WHERE id = ?`
          ).bind(key.id).run();

          // 解析答案
          const parsedAnswer = parseAIAnswer(result.content, type);

          return {
            content: parsedAnswer,
            channelName: channel.name as string,
            model: result.model,
            rawRequest: result.rawRequest,
            rawResponse: result.rawResponse,
          };
        } catch (err) {
          // 记录错误信息（用于最终报错和日志排查）
          const errMsg = err instanceof Error ? err.message : String(err);
          const errReq = err instanceof AIError ? (err.rawRequest || '') : '';
          const errResp = err instanceof AIError ? (err.rawResponse || '') : '';
          // 第一次失败通常是根因，优先保留
          if (!firstError) {
            firstError = errMsg;
            firstRawRequest = errReq;
            firstRawResponse = errResp;
          }
          // 最后一次失败也保留（可能展示不同的失败模式）
          lastError = errMsg;
          lastRawRequest = errReq;
          lastRawResponse = errResp;

          // 失败：原子自增 fail_count，达阈值则禁用（避免并发读改写竞态）
          await env.DB.prepare(
            `UPDATE ai_channel_keys
             SET fail_count = fail_count + 1,
                 enabled = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE enabled END
             WHERE id = ?`
          ).bind(failThreshold, key.id).run();

          // 继续尝试下一个 key
          continue;
        }
      }
      // 此渠道所有 key 都失败，尝试下一个渠道
    }
    // 此权重组所有渠道都失败，尝试下一个权重组
  }

  // 所有渠道都失败，携带错误详情便于排查
  // 优先使用第一个错误（根因），如果只有一个错误则 lastError === firstError
  const errorMsg = firstError
    ? (firstError === lastError
      ? `所有 AI 渠道均不可用（${firstError}）`
      : `所有 AI 渠道均不可用（首次错误：${firstError}；最后错误：${lastError}）`)
    : '所有 AI 渠道均不可用';
  throw new AIError(
    errorMsg,
    firstRawRequest || lastRawRequest || undefined,
    firstRawResponse || lastRawResponse || undefined
  );
}
