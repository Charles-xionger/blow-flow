# 01: 整合已完成的 Go 迁移代码

**What to build:** 在同一可运行版本中接通已有的用户账户、创作资源、生成任务、脚本任务和创作助手基础能力，使创作者可通过接口完成登录、读取项目并启动受控的后台任务，为后续功能对齐提供稳定基线。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [ ] 已有迁移成果整合后，账户、项目、生成、脚本和创作助手的服务能够共同启动，接口契约与数据库迁移保持一致。
- [ ] 同一创作者可登录、读取自己的项目、保存画布，并通过接口创建和查询已支持的后台任务；其他账户不能访问其资源。
- [ ] 数据库、消息队列或通知组件暂时不可用时，服务暴露可辨识的就绪状态和错误，不产生双重权威写入。
- [ ] 相关接口和集成检查通过，并记录仍由旧路径承担的能力，供后续票逐项接管。

## Answer

已将实现提交 `ea90ca8` 以非快进方式合入 `codex/go-cutover-integration`。Go API 的 `/health/ready` 现在分别报告 PostgreSQL、RabbitMQ 和 Redis 状态；`docs/architecture/go-consolidation-baseline.md` 记录已接通接口、权威数据边界及仍由旧路径承担的能力。验证通过：`go test ./internal/httpserver ./cmd/server`、`node --test tests/server.test.mjs`（1/1）、`go vet ./...` 和 Go 格式检查。`pnpm` 命令因当前 Node 25 不符合仓库要求的 Node 22 而未运行；格式检查已直接执行。
