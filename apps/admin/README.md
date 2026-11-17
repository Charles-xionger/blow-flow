# 生成运营后台

独立的 Vite 管理端，基于 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) 的视觉样式和基础组件；导入版本 `e16c87f213a5ba5e45964e9b67c792105ec74d26`，原 MIT 许可见 [LICENSE](LICENSE)。演示登录和模拟业务数据没有接入。

复制 `.env.example` 为 `.env.local`，设置 Go API 地址、OIDC issuer 和管理员客户端 ID。该客户端需要授权码 + PKCE，回调地址为 `http://127.0.0.1:3218/auth/callback`（开发环境）。身份服务必须签发符合 Go API 配置的 JWT access token，并提供 `email`、`email_verified`、`auth_time` 和 MFA `amr`/`acr` 声明。开发服务器代理 `/v1` 到 `API_URL`；生产部署也需要把同源 `/v1` 代理到 Go API。

针对所选身份服务配置 `VITE_OIDC_API_AUDIENCE`、`VITE_OIDC_SCOPE` 和 `VITE_OIDC_MFA_ACR`，确保返回的访问令牌满足 API 的 audience 与 MFA 映射。上线前须用真实身份服务完成一次授权码回调和 `/v1/me` 往返验证。

运行 `pnpm --filter @blow-flow/admin dev`。入口先调用 `/v1/me` 验证本地管理员角色；用户与审计页面调用 Go API。任务、成本和总览目前是明确的待接入状态，直到生成领域迁移后才展示权威数据。
