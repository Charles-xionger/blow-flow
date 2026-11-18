# 创作助手迁移设计（提案）

状态：待确认；仅设计，不代表已迁移或已切流。

## 结论

保留 TypeScript 的 Pi Agent 运行循环，移出 Next.js 进程，作为独立的 `apps/agent-runner` Node Worker 运行。Go API 持有创作助手的身份、任务、消息、确认、工具副作用和进度状态；PostgreSQL 是权威存储，RabbitMQ 只唤醒 Runner，Redis 只通知 SSE。浏览器仍只与应用 API 通信。这里的“迁移到 Go”是将业务状态和工具执行权迁到 Go，不重新实现 Pi 的模型循环。

Pi 当前通过 `@mariozechner/pi-agent-core` 和 `@mariozechner/pi-ai` 在 `apps/web/lib/agent/runtime.ts` 执行模型调用和工具循环；仓库固定版本为 0.73.1。`apps/web/lib/agent/service.ts` 自行实现 SQLite 任务、消息、步骤、租约和确认；`apps/web/lib/agent/mcp.ts` 使用进程内 MCP transport。Runner 只保留 Pi、模型适配、提示词构建与事件转换，不再访问 SQLite、画布数据库或生成任务数据库。Pi 上游包升级与本迁移分开验证。

```text
浏览器 ──HTTP/SSE──> Go API ──PostgreSQL（任务、消息、工具回执、确认、事件）
                         │                   │
                         │ outbox            └──Redis Pub/Sub──> Go SSE
                         v
                       RabbitMQ ──唤醒──> Node Pi Runner
                                             │ 领取、心跳、事件与工具调用
                                             ├───────────────────────> Go 内部接口/MCP
                                             └──模型流式调用──────────> 模型供应商
```

## 模块与接口

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Go `agent` 模块 | 用户和项目授权、任务命令、幂等、状态机、租约、事件、等待确认、运行恢复 | 拼接供应商请求或执行 Pi 循环 |
| Node Pi Runner | 领取一次运行、组装已持久化上下文、执行 Pi、转发模型与工具事件 | 决定用户是否有权修改项目，直接改画布或提交生成 |
| Go 资源与生成模块 | 校验并执行画布语义操作、生成确认和提交；写可重放回执 | 信任模型输出直接形成副作用 |
| PostgreSQL | 权威任务、消息、步骤、确认、工具回执与 outbox | 高频 token 广播队列 |

Runner 与 Go 的外部 seam 保持少量操作：`Claim(taskId)` 领取并取得运行令牌与上下文；`Heartbeat(runId)` 续租并获知停止/等待；`AppendEvents(runId, events)` 按序持久化消息和步骤；`ExecuteTool(runId, callId, name, args)` 执行工具并返回回执；`Finish(runId, outcome)` 结束本轮。工具通过应用内 MCP 向 Pi 暴露，但 MCP handler 只调用 Go 的工具接口。内部接口使用服务身份认证；Go 从已领取的任务推导用户和项目，拒绝 Runner 自报的所有者。每次写操作检查运行令牌，旧 Runner 不得覆盖新运行。

公开接口可沿用当前侧栏的 `snapshot/send/continue/answer/stop` 语义，Go 提供 `GET /v1/agent/projects/{projectId}`、`POST /v1/agent/projects/{projectId}/commands` 与 `GET /v1/agent/projects/{projectId}/events`。命令包含 `requestId`；相同 ID、相同请求返回原结果，复用 ID 改内容报冲突。SSE 发送数据库事件游标；Redis 丢通知后按游标补查。具体 JSON 字段以当前前端契约和接口测试固定，切换前不改前端。

## 状态与恢复

状态为 `queued → running → waiting/completed/failed/stopped/interrupted`。等待用户回答、编辑授权或生成确认时，Go 先保存待处理事项，再结束当前 Pi 运行；断开浏览器不批准、不取消。用户回答后由 Go 原子消费对应问题 ID 并重新排队。新消息可补充当前活动任务；同一项目只有一个活动任务，用数据库唯一约束而不是 Runner 内存锁保证。不同项目可并发，Runner 容量受并发名额控制。

Go 在同一事务中写任务变更、不可变事件和 outbox。RabbitMQ 消息只含任务 ID；重复投递由领取事务去重，确认消息后仍可由数据库扫描器找回排队任务。运行中租约过期后标记为 `interrupted`，保留已完成的步骤和用户消息，等待用户明确继续；不自动重发可能已收费的模型或生成调用。停止只阻止后续 Pi 轮次和未提交的生成请求；已提交的供应商任务仍由生成模块跟踪和保存。此规则遵循 [ADR-0008](../adr/0008-platform-managed-background-agent.md)。

持久化的上下文包含规范化的用户/助手消息、Pi 工具调用及结果、执行步骤和检查点，并记录 Pi 适配版本。重建上下文只读取已提交记录，不依赖 Runner 内存。模型流的文字增量可节流落库并通过 SSE 展示；完整助手消息在轮次结束时落库。工具开始事件必须先于副作用提交；工具完成回执与副作用用相同 `taskId + callId` 去重。无法确认是否执行的非幂等调用标为待核实，不盲目重放。

## 画布与生成工具

先把现有 `CanvasAgentService.apply` 的语义（操作校验、同一步历史批次、版本冲突、删除节点、授权与回执）迁入 Go `resource` 模块，再将 `edit_canvas` 等工具接向它。当前 Go `resource.SaveCanvas` 仅提供整张快照及版本检查，不能代替 Agent 的语义编辑，否则旧快照可能覆盖无关的人工修改。画布编辑遵循 [ADR-0009](../adr/0009-agent-canvas-history-and-conflicts.md) 与 [ADR-0011](../adr/0011-agent-preserves-existing-content.md)：默认新建；改写已有内容需本轮引用或确认；已删节点跳过；操作进入持久历史。

`generate_*` 工具由 Go 先规范化模型、输入、目标节点和预计新增节点，持久化确认快照；用户批准的是该快照的摘要。批准后使用稳定请求 ID 创建 Go 生成任务，任何重试先查已有回执。供应商提交结果不明交给生成模块待核实；Agent 不自行重复付费请求。结果保存与画布附着由 Go 生成/资源模块负责。`ask_question`、`read_canvas`、`read_reference` 与技能读取也经 Go 按任务所有者授权；内置只读技能可先随 Runner 打包，个人技能库再迁移。

## 实施顺序与验收

1. **Go 控制面**：任务/消息/事件/确认表、命令接口、领取与租约、outbox/SSE。用假 Runner 验证幂等、并发项目、同项目唯一活动任务、断线和崩溃恢复。
2. **Go 工具面**：先实现语义画布编辑及回执，再接只读、脚本和生成工具；用假 Pi 调用验证授权、人工确认、旧运行令牌、重试与“结果不覆盖旧内容”。
3. **Node Pi Runner**：从 Next.js 提取固定版本 Pi 运行时，改为通过 Go 内部接口/MCP 操作；用假模型验证完整对话、工具调用、停止和继续。接口与逻辑测试先行，前端暂不动。
4. **历史导入与切换**：只读导出 SQLite 的 Agent 消息、任务、步骤、确认和生成批次；活动任务导入为 `interrupted`，保留供应商任务 ID，绝不重新提交。停写、导入、核对后再把前端调用层切到 Go；禁止 Next.js 与 Go 同写同一 Agent 任务。

验收需包含 RabbitMQ 重复/丢失通知、Runner 崩溃、租约过期、确认后断网、工具执行后回执响应丢失、人工同时编辑、目标节点删除、已有结果保护、供应商提交不明和跨用户访问。性能上分别限制单任务轮次与工具次数、模型超时、Runner 并发和事件写入频率。独立测试服务不得复用当前预览服务。

## 待实现前核定

- 当前侧栏的消息和快照 JSON 契约、事件流方式及旧任务导入字段。
- Pi 0.73.1 的事件与中断行为；上游 scope 已变化，升级需单独回归，不与迁移混做。
- 画布历史在 Go 中的存储格式及 `CanvasAgentService.apply` 与现有资源保存回执如何共用事务。
- 内部 Runner 认证、模型凭据下发方式及部署拓扑；Runner 不接收用户 JWT 或任意项目 ID 的直接写权限。
