# Go API

Go API 按完整领域逐步接管现有 TypeScript 实现的业务写入。当前已迁移账户领域，生成与画布数据仍由 `apps/web` 持有；两边不能同时成为同一业务数据的权威写入者。

## 模块边界

1. `internal/identity/localauth` 验证本地管理员密码和 TOTP，并签发、校验 15 分钟的 HS256 JWT。
2. `internal/account` 定义本地用户账户、角色、状态和管理员操作规则，不依赖 Gin、GORM 或认证实现。
3. `internal/account/postgres` 维护身份映射、账户状态及追加式审计记录。
4. `internal/httpserver` 暴露 `openapi.yaml` 定义的版本化接口。

账户数据保存在 PostgreSQL。初始管理员首次通过本地认证后，账户仓储以固定本地主体创建管理员；如果已有管理员且邮箱与本地配置精确对应、唯一且账户正常，则把本地主体绑定到原有管理员，不改变其本地用户 ID。否则拒绝登录，不会自动提升另一账户。API 在每次受保护请求中重新查询账户状态，因此禁用账户会立即失去 Go API 的访问权限。管理操作要求 MFA，禁用用户还要求最近 10 分钟内完成认证。

## 本地配置

`DATABASE_URL` 连接 PostgreSQL。`pnpm admin:setup` 生成 `ADMIN_AUTH_EMAIL`、Argon2id 密码哈希、TOTP 密钥及 32 字节签名密钥，写入忽略提交的 `apps/api/.env.local`。登录信息保存在 `apps/api/.admin-login.local`，验证器导入二维码保存在 `apps/api/.admin-totp-qr.local.png`；两者只用于本机开发，不能提交到仓库。已有配置可用 `pnpm admin:qr` 生成二维码，不轮换密钥。API 不自动加载 dotenv，启动或迁移前需在 shell 中加载配置：

```sh
set -a
source apps/api/.env.local
set +a
pnpm db:up
pnpm db:migrate
pnpm dev:api
```

迁移是独立步骤，API 启动时不会执行 DDL。数据库或本地认证配置缺失时，存活探针仍可用，但就绪探针返回未就绪，账户接口拒绝访问。

## 当前范围

`POST /v1/auth/admin/login` 使用密码和 TOTP 登录，失败响应在单进程内逐步延迟，不会因代理共享 IP 而锁定正常登录；`GET /v1/me`、用户列表、禁用用户、审计记录均使用签名令牌和本地账户授权。成功登录也会追加审计事件。密码存储采用带随机盐的 Argon2id；TOTP 不接受同一进程内的同一步重放。

这只是首位管理员的本地引导。公开注册、邮箱验证、找回密码、MFA 恢复、跨实例共享的登录限流与 TOTP 重放状态、签名密钥轮换、主动撤销已签发令牌、历史资源归属迁移和生成授权尚未完成。生产开放前必须补齐对应账户能力和运维流程。
