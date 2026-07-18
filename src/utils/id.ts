/** 生成 UUID */
export function uuid(): string {
  return crypto.randomUUID();
}

/** 生成随机 hex 字符串 */
export function randomHex(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 生成 API Key，格式 tk_<32位hex> */
export function generateApiKey(): string {
  return 'tk_' + randomHex(16);
}
