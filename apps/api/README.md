# Go API

Go API 按完整领域逐步接管现有 TypeScript 实现的业务写入。当前已迁移账户领域，生成与画布数据仍由 `apps/web` 持有；两边不能同时成为同一业务数据的权威写入者。

## 模块边界

1. `internal/identity/localauth` 验证本地管理员密码，并签发、校验 15 分钟的 HS256 JWT；`internal/identity/imagecaptcha` 生成一次性图片验证码。
2. `internal/account` 定义本地用户账户、角色、状态和管理员操作规则，不依赖 Gin、GORM 或认证实现。
3. `internal/account/postgres` 维护身份映射、账户状态及追加式审计记录。
4. `internal/httpserver` 暴露 `openapi.yaml` 定义的版本化接口。

账户数据保存在 PostgreSQL。初始管理员首次通过本地认证后，账户仓储以固定本地主体创建管理员；如果已有管理员且邮箱与本地配置精确对应、唯一且账户正常，则把本地主体绑定到原有管理员，不改变其本地用户 ID。否则拒绝登录，不会自动提升另一账户。API 在每次受保护请求中重新查询账户状态，因此禁用账户会立即失去 Go API 的访问权限。禁用用户要求最近 10 分钟内完成登录。

## 本地配置

`DATABASE_URL` 连接 PostgreSQL。`pnpm admin:setup` 生成 `ADMIN_AUTH_EMAIL`、Argon2id 密码哈希及 32 字节签名密钥，写入忽略提交的 `apps/api/.env.local`。登录信息保存在 `apps/api/.admin-login.local`；这些文件只用于本机开发，不能提交到仓库。API 不自动加载 dotenv，启动或迁移前需在 shell 中加载配置：

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

`GET /v1/auth/captcha` 生成一次性四位图片验证码，按单进程令牌桶限制取图频率；`POST /v1/auth/admin/login` 校验图片答案后再校验密码。图片答案无论对错只可提交一次，未提交的验证码十分钟后过期；当前最多保留 1000 个挑战，均在单个 API 进程内，多实例部署需要共享挑战存储。失败响应在单进程内逐步延迟，不会因代理共享 IP 而锁定正常登录；`GET /v1/me`、用户列表、禁用用户、审计记录均使用签名令牌和本地账户授权。成功登录也会追加审计事件。密码存储采用带随机盐的 Argon2id。图片验证码用于限制简单自动请求，不是第二身份因素。

这只是首位管理员的本地引导。公开注册、邮箱验证、找回密码、跨实例共享的验证码与登录限流、签名密钥轮换、主动撤销已签发令牌、历史资源归属迁移和生成授权尚未完成。生产开放前必须补齐对应账户能力和运维流程。

## Go generation service

The Go API exposes `POST /v1/generation/tasks`, `GET /v1/generation/tasks/{id}` and
`POST /v1/generation/tasks/{id}/cancel`. Creation requires a bearer token, an
`Idempotency-Key`, an owned project, and the `runninghub/krea2` model. Krea2
currently rejects reference assets. An optional `nodeId` associates a task with
the current result for that node; a late result from an older task cannot replace
a newer result. The response contains task metadata and status; the prompt stays
in the PostgreSQL input snapshot. An authorized administrator may query a task,
while only its owner may cancel it before claim.

For this foundation phase, project and reference ownership is represented by
explicit `generation_resource_grants` rows. This is a controlled test resource
boundary: no application route provisions these grants, so production creation
fails closed until the project and asset domains migrate. Existing Next.js
generation remains untouched; production cutover is a separate step.

Run the schema migrations, start PostgreSQL, RabbitMQ, and Redis with
`docker compose -f infra/compose.yaml up -d --wait`, configure
`DATABASE_URL`, `RABBITMQ_URL`, `REDIS_URL`, `RUNNINGHUB_BASE_URL`,
`RUNNINGHUB_API_KEY`, and the `OSS_*` values in `.env.example`, then run
`pnpm --filter @blow-flow/api generation:worker` as a separate process.
The worker publishes outbox rows with broker confirms, consumes durable quorum
queue messages with manual acknowledgements, and scans PostgreSQL to recover
queued work even if a wakeup is lost. Redis only wakes SSE subscribers;
PostgreSQL remains the source of task state and events.

`GET /v1/generation/tasks/{id}/events` returns task events as JSON or, with
`Accept: text/event-stream`, a versioned task SSE stream. Failed delivery can
be resumed through `POST /v1/generation/tasks/{id}/resume` without resubmitting
the paid generation. Administrators can inspect audited aggregate metrics at
`GET /v1/admin/generation/operations`. See `openapi.yaml` for the contract.

For integration tests, set `TEST_DATABASE_URL`, `TEST_RABBITMQ_URL`, and
`TEST_REDIS_URL` to disposable services, then run `pnpm test:integration`.
The tests create and remove their own PostgreSQL schemas. The Go adapters are
tested with a simulated RunningHub and object store; live provider credentials
and production resource grants require separate validation before cutover.
