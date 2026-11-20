# 04: 补齐创作助手生成与结果交付

**What to build:** 创作者让助手使用当前支持的图片和视频模型生成内容，先确认目标与输入，再看到真实进度，并在画布中获得可访问的结果。

**Blocked by:** 01: 整合已完成的 Go 迁移代码；03: 补齐创作助手画布操作。

**Status:** resolved

- [x] 旧路径当前支持的图片、视频生成模式及参考素材在 Go 路径可用；确认内容包含模型、输入和目标节点。
- [x] 只有用户批准被冻结的生成请求后才创建任务；取消、画布变化、断线和命令重放不会绕过确认或重复付费提交。
- [x] 助手可读取任务进度与结果，已交付结果正确保存并附着到仍存在的目标画布内容；目标已删除时保留任务结果但不复活节点。
- [x] 部分失败、供应商响应不明、Worker 重启和通知丢失有安全恢复行为；固定接口案例核对保存、展示和重复请求。

## Answer

Go 助手生成现已冻结模型、输入、目标和有序参考素材，在批准后一次性创建任务。图片、视频和自定义工作流共用持久化任务进度与恢复路径；交付时将结果保存并只附着到仍存在的画布目标，删除的目标不会复活。供应商响应不明时不自动重提，重复命令和通知丢失按持久化状态恢复。

验证：`go test -count=1 ./internal/agent/... ./internal/generation/...` 通过；带 PostgreSQL/RabbitMQ 的 `go test -race -count=1 -tags=integration ./internal/agent/postgres ./internal/generation/postgres ./internal/generation/queue` 在修正新增连接对应的 circuit 数量断言后，三个包分别通过；`pnpm typecheck`、`pnpm lint`、`pnpm test` 通过（全量快速测试 4/4 包，Web 345/345）。完整浏览器回归留在切流最终验收边界执行。
