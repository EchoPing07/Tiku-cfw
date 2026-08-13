/** 构建 OCS AnswererWrapper 兼容的题库配置 JSON 字符串（与前端原生成逻辑保持一致） */
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
    },
    handler: 'return (res)=> res.code === 1 ? [res.question, res.answer] : undefined',
  }], null, 2);
}
