# 生成运营后台

`apps/admin` 是 monorepo 中独立的 Vite 应用，使用共享的 `@blow-flow/api-client` 调用 Go API。基于 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) 导入版本 `e16c87f213a5ba5e45964e9b67c792105ec74d26`；原 MIT 许可见 [LICENSE](LICENSE)。

## 模板取舍

| 保留 | 用途 |
| --- | --- |
| `src/styles/theme.css`、`src/styles/index.css` | 管理端独立主题和 Tailwind 基础样式 |
| `src/components/ui/button.tsx`、`card.tsx`、`src/lib/utils.ts` | 当前页面实际使用的基础组件与 `cn` 样式合并函数 |
| 模板的侧栏、顶栏与内容区布局方式 | 构成独立的管理入口 |

模板中的 Clerk/演示登录、模拟仪表盘数据、聊天、应用目录、示例任务、设置页以及未使用的 UI 组件没有导入。身份认证由 `src/auth.ts` 的 OIDC 客户端处理；本地管理员授权由 Go API 判定。`src/main.tsx` 只负责挂载，页面入口在 `src/app.tsx`，业务接口集中在 `src/api.ts`。

复制 `.env.example` 为 `.env.local`，设置 Go API 地址、OIDC issuer 和管理员客户端 ID。该客户端需要授权码 + PKCE，回调地址为 `http://127.0.0.1:3218/auth/callback`（开发环境）。身份服务必须签发符合 Go API 配置的 JWT access token，并提供 `email`、`email_verified`、`auth_time` 和 MFA `amr`/`acr` 声明。开发服务器代理 `/v1` 到 `API_URL`；生产部署也需要把同源 `/v1` 代理到 Go API。

针对所选身份服务配置 `VITE_OIDC_API_AUDIENCE`、`VITE_OIDC_SCOPE` 和 `VITE_OIDC_MFA_ACR`，确保返回的访问令牌满足 API 的 audience 与 MFA 映射。上线前须用真实身份服务完成一次授权码回调和 `/v1/me` 往返验证。

从仓库根目录运行 `pnpm dev:admin`；`pnpm dev:all` 也会启动管理端。尚未配置身份服务时，可打开 `http://127.0.0.1:3218/?preview` 查看仅在 Vite 开发模式启用的静态页面预览；预览不请求管理接口，也不展示真实数据。正式入口先调用 `/v1/me` 验证本地管理员角色；用户与审计页面调用 Go API。任务、成本和总览目前是明确的待接入状态，直到生成领域迁移后才展示权威数据。`pnpm build` 会构建该独立应用，产物在 `apps/admin/dist`。
