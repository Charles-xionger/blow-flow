# Go 迁移整合基线

本基线把现有 Go 模块接在同一个 `cmd/server` 进程上。部署时先运行 `pnpm db:migrate`，然后启动 API、`generation:worker`、`script:worker` 和 `agent:dispatcher`；Worker 和分发器是独立进程。PostgreSQL 是账户、创作资源、任务和 outbox 的权威状态。RabbitMQ 只分发任务 ID，Redis 只通知进度；API 不写旧 SQLite。

## 已接通的创作者接口

| 能力 | Go 接口 | 约束 |
| --- | --- | --- |
| 受控创作者登录 | `POST /v1/auth/user/login`、`/refresh`、`/logout` | 账户须由 `creator:setup` 创建；每次受保护请求检查账户状态。 |
| 工作空间、项目与画布 | `GET /v1/workspace`、`GET /v1/projects/:id`、`PUT /v1/projects/:id/canvas` | PostgreSQL 所有者范围；保存需要 `requestId` 与 `baseVersion`。 |
| 图片生成 | `POST /v1/generation/tasks`、`GET /v1/generation/tasks/:id`、`GET /v1/generation/tasks/:id/events` | 已支持 `runninghub/krea2`；创建需要幂等键。 |
| 脚本任务 | `POST /v1/script/tasks`、`GET /v1/script/tasks/:id`、`GET /v1/script/tasks/:id/events` | PostgreSQL 保存任务及结果节点。 |
| 创作助手基础命令 | `GET /v1/agent/projects/:projectId`、`POST /v1/agent/projects/:projectId/commands` | 仅 `AGENT_GO_EXPERIMENTAL_COMMANDS=1` 且 Runner 密钥已配置时开放受控冒烟。 |

以上路由共用同一认证与账户服务，项目、画布、生成、脚本和助手仓储均按资源所有者隔离。接口形状以 `apps/api/openapi.yaml` 为准；数据库形状以 `apps/api/migrations/` 为准。已有各领域接口测试和 PostgreSQL 集成测试覆盖授权、幂等及持久状态；此基线不表示前端已经切到 Go。

## 就绪与故障

`GET /health/ready` 分别给出 `postgres`、`rabbitmq`、`redis` 状态，任一不可用即返回 503。`GET /health/live` 不依赖外部服务。检查结果不含凭据。API 不自动运行迁移；迁移缺失时受影响接口会报错，不能把存活探针当作迁移验证。后台任务先在 PostgreSQL 事务中保存，再由 outbox 送入 RabbitMQ；通知断开后从 PostgreSQL 补读。切流期间每个项目只设一个权威写入方，见[切流验收边界](go-cutover-acceptance.md)。

## 尚由旧路径承担

- `apps/web` 的 Next.js/SQLite 路径仍为正式创作入口和旧项目的权威写入方；未按项目切流前不能同时开放 Go 写入。
- Go 创作助手只支持基础对话与部分画布操作。现有完整工具、技能读取、生成确认、素材引用及结果回填仍走 Next.js Agent；后续票负责能力对齐。
- 普通创作前端尚未接入 Go 登录。自助注册、邮箱验证、密码找回和多实例验证码／登录防护仍未交付。
- 个人技能库仍需迁入 Go 账户边界；生产切流、回滚和完整本地演练另由后续票验收。
