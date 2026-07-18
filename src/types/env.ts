export interface Env {
  /** D1 数据库绑定 */
  DB: D1Database;
  /** 前端静态资源绑定 */
  ASSETS: Fetcher;
  /** 管理员密码，默认 "password" */
  ADMIN_PASSWORD: string;
  /** JWT 签名密钥 */
  JWT_SECRET: string;
}
