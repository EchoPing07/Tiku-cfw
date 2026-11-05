/**
 * 构建 OCS AnswererWrapper 兼容的题库配置 JSON 字符串（与前端原生成逻辑保持一致）。
 *
 * ## 为什么必须声明图片题参数
 *
 * OCS 5.1.0 起「图片题优化」默认开启：脚本把题干/选项里的图片转成 base64，
 * 并把题干/选项里的图片 URL 换成 `[图片N]` 占位文本。但只有题库配置**在 `data` 中
 * 显式引用**了 `images` / `suggestion_title` / `suggestion_options` 时才会真正提交
 * （判定见 `scripts/src/utils/answerer-env.ts isAnswererWrapperSupportImageOptimize`，
 * 支持 `${images}` 占位符或 `{ handler: "return (env) => env.images" }` 两种写法）。
 * 未声明时 OCS 每页弹「当前题库配置暂不支持图片、公式等题目处理」，
 * 且图题退化为“题干里只剩图片 URL 文本”（依赖服务端抓图，强防盗链图床会失败）。
 *
 * ## 为什么用 `{ handler }` 而不是 `${images}` 占位符
 *
 * `defaultAnswerWrapperHandler` 的占位符替换是字符串替换（`String(value)`），
 * 数组会被拼成 `"a,b"`；而 data URL 形如 `data:image/png;base64,...` 自带逗号，
 * 拼成一串后**无法无损还原**成数组。`{ handler }` 形式的返回值会原样写入请求体，
 * 数组仍是 JSON 数组；环境变量缺失时（老版本 OCS 无 `env.images`）返回 undefined，
 * 该字段直接从 JSON 中消失，不会留下字符串 `"undefined"`。
 *
 * ## data 各字段语义（服务端 parseSearchInput 全部识别）
 *
 * - `title` / `type` / `options`：OCS 老字段，始终提交。`type` 在 OCS 5.x 缺省为字面量
 *   `'unknown'`，服务端折叠为“未指定题型”。
 * - `suggestion_title` / `suggestion_options`：图片 URL 已换成 `[图片N]` 的题干/选项
 *   （不含 base64），服务端按占位符位置把 base64 图内联回原文位置。
 * - `images`：base64 data URL 数组，与 `[图片N]` 严格同序（N 从 1 起）。
 */
export function buildOCSConfig(opts: { siteName: string; origin: string; apiKey: string }): string {
  return JSON.stringify([{
    name: opts.siteName,
    homepage: opts.origin,
    url: opts.origin + '/api/search',
    method: 'post',
    contentType: 'json',
    type: 'fetch',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + opts.apiKey,
    },
    data: {
      'title': '${title}',
      'type': '${type}',
      'options': '${options}',
      // ↓ 图片题优化：用 handler 取值，保住 base64 数组形态（占位符会被拼成字符串）
      'images': { handler: 'return (env) => env.images' },
      'suggestion_title': { handler: 'return (env) => env.suggestion_title' },
      'suggestion_options': { handler: 'return (env) => env.suggestion_options' },
    },
    handler: 'return (res)=> res.code === 1 ? [res.question, res.answer] : undefined',
  }], null, 2);
}
