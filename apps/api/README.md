# Go API

Go API 按完整领域逐步接管现有 TypeScript 实现的业务写入。Go 已具备账户、生成任务及项目／素材资源 API；在生产切换前，`apps/web` 仍是旧 SQLite 项目与生成任务的权威写入者。两边不能同时写同一批项目。

## 模块边界

1. `internal/identity/localauth` 验证本地管理员密码，并签发、校验 15 分钟的 HS256 JWT；`internal/identity/session` 在 PostgreSQL 中保存可轮换的七天刷新会话；`internal/identity/imagecaptcha` 生成一次性图片验证码。
2. `internal/account` 定义本地用户账户、角色、状态和管理员操作规则，不依赖 Gin、GORM 或认证实现。
3. `internal/account/postgres` 维护身份映射、账户状态及追加式审计记录。
4. `internal/httpserver` 暴露 `openapi.yaml` 定义的版本化接口。

账户数据保存在 PostgreSQL。初始管理员首次通过本地认证后，账户仓储以固定本地主体创建管理员；如果已有管理员且邮箱与本地配置精确对应、唯一且账户正常，则把本地主体绑定到原有管理员，不改变其本地用户 ID。否则拒绝登录，不会自动提升另一账户。API 在每次受保护请求中重新查询账户状态，因此禁用账户会立即失去 Go API 的访问权限。禁用用户要求最近 10 分钟内完成登录。

## 本地配置

`DATABASE_URL` 连接 PostgreSQL。`pnpm admin:setup` 生成 `ADMIN_AUTH_EMAIL`、Argon2id 密码哈希及 32 字节签名密钥，写入忽略提交的 `apps/api/.env.local`。登录信息保存在 `apps/api/.admin-login.local`；这些文件只用于本机开发，不能提交到仓库。pnpm 启动脚本会加载根目录和 API 的 `.env.local`；直接运行 Go 二进制时仍需在 shell 中提供配置：

```sh
set -a
source apps/api/.env.local
set +a
pnpm db:up
pnpm db:migrate
pnpm dev:go
```

迁移是独立步骤，API 启动时不会执行 DDL。`/health/live` 只表示进程仍在运行；`/health/ready` 分别检查 PostgreSQL、RabbitMQ 和 Redis，返回各组件的 `ready` 或 `unavailable` 状态，不返回连接地址或错误详情。缺少数据库或签名配置时 PostgreSQL 组件也标记为不可用，账户接口拒绝访问。RabbitMQ 或 Redis 暂时不可用时，就绪探针返回 503；已经写入 PostgreSQL 的任务及 outbox 仍以 PostgreSQL 为准，通知不能取代持久状态。

已接通的接口、需要的服务，以及仍由旧路径承担的能力见[整合基线](../../docs/architecture/go-consolidation-baseline.md)。

## 当前范围

`GET /v1/auth/captcha` 生成一次性四位图片验证码，按单进程令牌桶限制取图频率；`POST /v1/auth/admin/login` 校验图片答案后再校验密码。图片答案无论对错只可提交一次，未提交的验证码十分钟后过期；当前最多保留 1000 个挑战，均在单个 API 进程内，多实例部署需要共享挑战存储。失败响应在单进程内逐步延迟，不会因代理共享 IP 而锁定正常登录；`GET /v1/me`、用户列表、禁用用户、审计记录均使用签名令牌和本地账户授权。成功登录也会追加审计事件。密码存储采用带随机盐的 Argon2id。图片验证码用于限制简单自动请求，不是第二身份因素。

首位管理员仍由本地引导。Go API 还提供受控创建的普通创作用户登录：运行 `CREATOR_SETUP_PASSWORD=... pnpm --filter @blow-flow/api creator:setup -- -email creator@example.com`，随后调用 `POST /v1/auth/user/login`（邮箱、密码、图片验证码）获取 15 分钟 JWT 和仅限认证路径的刷新 Cookie。管理员与创作者分别调用 `/v1/auth/admin/refresh` 或 `/v1/auth/user/refresh` 轮换 Cookie 并取得新 JWT，退出时调用对应 `/logout`。Admin 前端已自动续期；普通创作前端尚未接入 Go 登录。迁移 `00010_auth_sessions.sql` 必须先于新 API 部署执行。公开自助注册、邮箱验证、找回密码、跨实例共享验证码与登录限流、签名密钥轮换和主动撤销已签发 JWT 尚未提供，生产开放前须补齐。

## Agent migration boundary

The Go Agent store now persists project-scoped commands and messages, validates the
confirmed canvas version on `send`, and writes an outbox wakeup in the same
transaction. `pnpm --filter @blow-flow/api agent:dispatcher` publishes queued task
IDs to the RabbitMQ `agent.tasks.v1` quorum queue with publisher confirms. A
claimed Node Runner can read `/internal/agent/run/context`, persist replies,
tool steps and questions, and use the scoped canvas endpoints. An explicit
`pnpm agent:go-worker` can consume the new queue for
basic conversation and canvas edits. Public `/v1/agent/projects/:projectId`
routes return `503` by default; `AGENT_GO_EXPERIMENTAL_COMMANDS=1` opens them
only for controlled smoke tests because the new Runner does not yet cover every
existing tool and confirmation. The existing
Next.js Agent remains the active product path. See
[the migration design](../../docs/architecture/go-agent-migration.md).

## Go generation service

The Go API exposes `POST /v1/generation/tasks`, `GET /v1/generation/tasks/{id}` and
`POST /v1/generation/tasks/{id}/cancel`. Creation requires a bearer token, an
`Idempotency-Key`, an owned project, and the `runninghub/krea2` model. Krea2
currently rejects reference assets. An optional `nodeId` associates a task with
the current result for that node; a late result from an older task cannot replace
a newer result. The response contains task metadata and status; the prompt stays
in the PostgreSQL input snapshot. An authorized administrator may query a task,
while only its owner may cancel it before claim.

Project and asset ownership now comes from PostgreSQL `projects` and
`media_assets`. A deleted or purged project cannot start a new generation;
already submitted tasks continue recovery. Existing Next.js generation remains
untouched; production cutover is a separate step.

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
require separate validation before cutover.

## Project and asset migration

The Go API exposes owner-scoped `/v1/workspace`, `/v1/projects`, `/v1/folders`,
and `/v1/assets` endpoints. Canvas saves use `requestId` and `baseVersion`;
PostgreSQL stores the snapshot, version, receipt, and deleted-node record in one
transaction. Asset upload requires an owned active project and writes the object
to OSS under a server-generated key. See `openapi.yaml` for request shapes.

The one-time export/import tools preserve legacy project IDs, versions, folder
links, save receipts, deleted-node records, and `media_files`. Import can also
index trusted OSS links already embedded in project snapshots. Follow
[the cutover procedure](../../docs/architecture/resource-migration.md) before
running it against persistent data. The export contains project content and is
created with mode `0600`; remove it after verifying the import.

The export also carries legacy Agent tasks, messages, request and canvas receipts, tool
steps, and generation batches. The importer stores completed history and archives
old generation batches without creating Go generation tasks or outbox messages.
Old active tasks become read-only interrupted history and their original snapshots are archived,
so legacy approvals cannot authorize a new provider submission. This does not by itself enable the production Agent
route: creator login, Go-owned project writes, and tool parity remain required.

## Go script tasks

`/v1/script/models` reports server-configured Ark and Gemini text models without exposing keys. Set `ARK_API_KEY` or `GOOGLE_API_KEY`/`GEMINI_API_KEY` in both Go API and worker environments. Run `pnpm --filter @blow-flow/api script:worker` as a separate process. `SCRIPT_CONCURRENCY` sets its local and PostgreSQL claim limit; `SCRIPT_MAX_QUEUED_PER_USER` caps waiting tasks. RabbitMQ carries wakeups and Redis wakes individual task SSE subscribers. PostgreSQL owns task state, leases, workflow checkpoints, immutable task events, request aliases, and output node writes. A provider circuit pauses new model calls after repeated failures; already stored output and checkpoints stay available.

`POST /v1/script/tasks` accepts the script input shape. Plain text tasks create the result text node in the same transaction as the task and outbox row. The fixed storyboard workflow saves plan, assets, detail batches and final prompts as resumable checkpoints on the task; a retry with identical input uses the same task and completed steps. Stopping and failures keep received text or stage drafts. `GET /v1/script/tasks`, `GET /v1/script/tasks/{id}`, `POST /v1/script/tasks/{id}/stop`, and the two SSE endpoints expose progress. Historical `shots` mode is read through imported tasks but cannot start new tasks.

Image references must match an owned uploaded asset or completed generation result. The worker only fetches exact configured HTTPS hosts, never follows redirects, and limits image bytes to 10 MB. `SCRIPT_ASSET_HOSTS` permits additional legacy OSS hosts; the active OSS bucket host is derived from `OSS_BUCKET_NAME` and `OSS_REGION`.

The resource export now includes legacy `script_tasks` and `script_requests`. Existing active legacy tasks import as interrupted, preserving drafts and workflow checkpoints without resubmitting model requests. Stop legacy writers and verify the imported rows before routing client traffic to Go. Frontend calls still target Next.js; production cutover is separate.
