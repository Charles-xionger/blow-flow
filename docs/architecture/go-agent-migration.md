# 创作助手迁移设计（提案）

状态：实施中。画布计算器、Go 资源适配、运行令牌约束的画布提交、用户命令、消息、工具步骤与问题持久化已落地测试；独立 Go Pi Runner 已接通基础画布工具和受确认的 Krea2 文生图任务，仍未与旧工具等价，生产切流尚未完成。

当前代码边界：`apps/web/lib/agent/canvas-plan.ts` 是不访问数据库的画布编辑计算器，现有 SQLite Agent 工具已复用它。`apps/web/lib/agent/go-canvas.ts` 和 `go-runner-host.ts` 为独立 Node Go Runner 提供运行令牌画布适配及进程内 MCP。Go `agent` 模块持久化任务、消息、工具步骤、待回答问题和运行租约，提交入口从运行令牌推导所有者与项目，在同一事务中检查版本、操作范围、删除节点并写快照和工具回执。服务密钥是 Base64 文本，只用于领取任务，不能访问运行画布；过期运行令牌不能提交。`/v1/agent/projects/:projectId` 和 `/commands` 已实现身份与归属边界，默认返回 503；仅通过 `AGENT_GO_EXPERIMENTAL_COMMANDS=1` 可做受控接口冒烟测试，避免不完整工具集接管用户任务。`agent-dispatcher` 从 PostgreSQL outbox 向 RabbitMQ quorum queue 发布带确认的任务 ID；独立 `agent:go-worker` 可以消费并执行基础对话、画布读取与编辑工具，但不在 `dev:all` 中启用。前端及生产 Agent 路由保持现状。

本阶段内部接口：`POST /internal/agent/tasks/:id/claim` 使用 `AGENT_RUNNER_KEY`（标准 Base64 编码的至少 32 字节）；领取后使用返回的独立运行令牌调用 `POST /run/heartbeat`、`GET /run/context`、`GET /run/canvas`、`POST /run/deleted-nodes/check`、`GET /run/canvas/receipt/:callId`、`PUT /run/canvas`、`POST /run/finish`（均在 `/internal/agent` 前缀下）。`PUT /run/canvas` 提交 `callId`、`label`、`baseVersion`、`operations`、`snapshot`、`skipped`。同一工具调用重复提交返回原回执；画布版本冲突需要 Runner 重读后计算，运行过期则停止写入。Go 当前仅允许助手本任务新建节点的内容更新；现有节点的引用或用户确认授权仍待用户命令与确认持久化后接入，不能由 Runner 自报授权。

画布提交只做服务端差异与授权边界校验；TypeScript 计算器仍负责历史补丁、提示词引用和图语义。Agent 画布提交及普通用户经 Go 资源 API 删除节点时，在同一事务中取消排队生成任务、清除节点结果映射；已提交供应商的任务继续跟踪，但无法回填已删除节点。`skipped` 是 Runner 报告，不代表 Go 独立推导了跳过原因。

切流阻塞项：Go Runner 还缺旧版 `delete_canvas_nodes` 的一次性用户授权、已有节点编辑确认、视频与其他图像模型的生成适配、已存在结果的旁路新节点承接、脚本/技能读取及上传素材引用；现有普通创作前端也未登录 Go 用户账户、未确认画布保存版本，旧 Agent 历史尚未导入。缺一项都不能把生产 `/api/agent` 路由或 `dev:all` 切向 Go。切流时应只保留一个任务写入者，不做双写。

Go 生成确认现仅接受 `runninghub/krea2` 文生图、无参考素材、目标为空的图片节点。Runner 的 `prepare_generation` 以当前运行令牌冻结批次、画布版本和摘要，持久化待确认问题并终止本轮；用户回答“确认生成”时 Go 在一个 PostgreSQL 事务内创建每项任务、生成 outbox、写批次状态和用户回答。相同命令 ID 重放只返回原回执；画布版本变更必须重新准备。取消和停止只取消未提交批次，已建单的生成任务继续跟踪。`generation_results` 通过运行令牌查询 Go 任务状态，不触发供应商提交或重试。旧 Next.js 生成路径继续负责当前生产流量；此阶段尚无批次完成后的 Agent 自动等待和画布附着能力，不能据此切流。

## 结论

保留现有独立 Node Worker 中的 TypeScript Pi Agent 运行循环；后续可从 `apps/web` 目录整理到 `apps/agent-runner`，目录调整不是迁移前置。Pi 与工具之间继续使用进程内 MCP。画布操作仍由 TypeScript 画布逻辑计算；Go API 持有创作助手的身份、任务、消息、确认、资源授权、快照提交和进度状态。PostgreSQL 是权威存储，RabbitMQ 只唤醒 Worker，Redis 只通知 SSE。浏览器仍只与应用 API 通信。这里的“迁移到 Go”不要求重新实现 Pi、另建远程 MCP 服务或把画布编辑规则复制成第二套 Go 实现。

Pi 当前通过 `@mariozechner/pi-agent-core` 和 `@mariozechner/pi-ai` 在 `apps/web/lib/agent/runtime.ts` 执行模型调用和工具循环；仓库固定版本为 0.73.1。`apps/web/lib/agent/service.ts` 自行实现 SQLite 任务、消息、步骤、租约和确认；`apps/web/lib/agent/mcp.ts` 使用进程内 MCP transport。普通画布编辑规则主要在浏览器的 TypeScript 代码中，Agent 专用编辑在服务端 TypeScript 的 `apps/web/lib/agent/canvas.ts` 中组合这些规则。Runner 最终保留 Pi、画布操作计算、模型适配、提示词构建与事件转换，不再直接访问 SQLite、画布数据库或生成任务数据库。Pi 上游包升级与本迁移分开验证。

```text
浏览器 ──HTTP/SSE──> Go API ──PostgreSQL（任务、消息、工具回执、确认、事件）
                         │                   │
                         │ outbox            └──Redis Pub/Sub──> Go SSE
                         v
                       RabbitMQ ──唤醒──> Node Pi Worker
                                             │ Pi ↔ 进程内 MCP ↔ TS 画布工具
                                             ├──Go 内部接口：领取、心跳、事件、快照提交
                                             └──模型流式调用──────────> 模型供应商
```

## 模块与接口

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Go `agent` 模块 | 用户和项目授权、任务命令、幂等、状态机、租约、事件、等待确认、运行恢复 | 拼接供应商请求或执行 Pi 循环 |
| Node Pi Runner | 领取一次运行、组装已持久化上下文、执行 Pi、用 TypeScript 画布规则计算下一个快照 | 决定用户是否有权修改项目，直接写数据库或提交生成 |
| Go 资源与生成模块 | 校验所有权与编辑授权、按版本提交完整快照及回执、执行生成确认与提交 | 重新实现浏览器/Agent 的画布操作算法 |
| PostgreSQL | 权威任务、消息、步骤、确认、工具回执与 outbox | 高频 token 广播队列 |

Worker 与 Go 的外部 seam 保持少量操作：`Claim(taskId)` 领取并取得运行令牌与上下文；`Heartbeat(runId)` 续租并获知停止/等待；`AppendEvents(runId, events)` 按序持久化消息和步骤；`ReadCanvas(projectId)` 读取当前快照及版本；`CommitCanvasEdit(runId, callId, baseVersion, operations, nextSnapshot)` 提交经 TypeScript 计算的编辑；`Finish(runId, outcome)` 结束本轮。工具仍通过现有进程内 MCP 向 Pi 暴露，MCP handler 调用 TypeScript 画布计算器或 Go 内部接口。此设计不开放 MCP 网络端点；Codex 连接活动浏览器画布属于另一项功能。内部 Go 接口使用服务身份认证；Go 从已领取的任务推导用户和项目，拒绝 Worker 自报的所有者。每次写操作检查运行令牌，旧 Worker 不得覆盖新运行。

公开接口可沿用当前侧栏的 `snapshot/send/continue/answer/stop` 语义，Go 提供 `GET /v1/agent/projects/{projectId}`、`POST /v1/agent/projects/{projectId}/commands` 与 `GET /v1/agent/projects/{projectId}/events`。命令包含 `requestId`；相同 ID、相同请求返回原结果，复用 ID 改内容报冲突。SSE 发送数据库事件游标；Redis 丢通知后按游标补查。具体 JSON 字段以当前前端契约和接口测试固定，切换前不改前端。

## 状态与恢复

状态为 `queued → running → waiting/completed/failed/stopped/interrupted`。等待用户回答、编辑授权或生成确认时，Go 先保存待处理事项，再结束当前 Pi 运行；断开浏览器不批准、不取消。用户回答后由 Go 原子消费对应问题 ID 并重新排队。新消息可补充当前活动任务；同一项目只有一个活动任务，用数据库唯一约束而不是 Runner 内存锁保证。不同项目可并发，Runner 容量受并发名额控制。

Go 在同一事务中写任务变更、不可变事件和 outbox。RabbitMQ 消息只含任务 ID；重复投递由领取事务去重，确认消息后仍可由数据库扫描器找回排队任务。运行中租约过期后标记为 `interrupted`，保留已完成的步骤和用户消息，等待用户明确继续；不自动重发可能已收费的模型或生成调用。停止只阻止后续 Pi 轮次和未提交的生成请求；已提交的供应商任务仍由生成模块跟踪和保存。此规则遵循 [ADR-0008](../adr/0008-platform-managed-background-agent.md)。

持久化的上下文包含规范化的用户/助手消息、Pi 工具调用及结果、执行步骤和检查点，并记录 Pi 适配版本。重建上下文只读取已提交记录，不依赖 Runner 内存。模型流的文字增量可节流落库并通过 SSE 展示；完整助手消息在轮次结束时落库。工具开始事件必须先于副作用提交；工具完成回执与副作用用相同 `taskId + callId` 去重。无法确认是否执行的非幂等调用标为待核实，不盲目重放。

## 画布与生成工具

**第一步先实现画布工具，不启动 Agent 状态迁移。** 将 `CanvasAgentService.apply` 中不依赖 SQLite 的编辑计算提取成 TypeScript 函数：输入当前快照、操作列表及已核定的权限上下文，输出新快照、受影响节点和跳过原因。复用现有 `assertCanvasGraph`、`syncReferences`、`versionContent`、`createCanvasHistory`，使 Agent 编辑与浏览器使用同一套画布规则及 `CanvasHistory.schema=1`；先不改浏览器组件。数据库读取、回执与保存从计算函数中移走，接到 Go 资源接口。此函数只计算，不持久化，不调用生成供应商。

Go 当前 `resource.SaveCanvas` 已按项目行锁、`baseVersion` 和 `requestId` 保存整张快照。为 Agent 增加受保护的提交入口：Go 从任务/运行令牌得出所有者与项目，校验修改权限、实际快照差异与操作清单一致，并在同一事务内写项目快照、版本、删除节点记录和工具回执。Go 不需要复刻布局、连线更新与历史补丁算法，但要拒绝越权修改、已删除节点复活和跳过版本检查的提交；由 TypeScript 计算器校验 `CanvasHistory.schema=1` 并用原有撤销/重做实现做回归测试。删除节点时还须通知 Go 生成模块取消未提交请求并防止迟到结果回写。Agent 专用调用不对浏览器公开，尚未具备 Go 任务授权时只做隔离的接口与逻辑测试，不切生产流量。

工具读取 `(snapshot, version)` 后在 TypeScript 中计算，提交时使用稳定的 `taskId + callId` 作为请求身份。若响应丢失，先用原请求重试或查询回执；若确认为版本冲突，重新读取最新快照并重新计算该批操作，最多有限次数，不把旧快照整体覆盖上去。若目标节点已删除则跳过并返回说明；已有节点内容只有本轮引用或持久确认后可改。每批操作生成一个现有格式的撤销历史记录。画布编辑遵循 [ADR-0009](../adr/0009-agent-canvas-history-and-conflicts.md) 与 [ADR-0011](../adr/0011-agent-preserves-existing-content.md)。

Pi 只能读取服务端已提交快照。当前侧栏发消息前调用 `canvasAutosave.flush()`，但 `flush()` 在离线或同步退避时可能正常返回，不能单凭它确认远端保存。前端切换 Agent 接口时增加严格的 `flushAndConfirm(projectId)`：等待当前画布的所有待提交操作收到服务器回执，核对本地内容版本与服务器确认版本，再把 `canvasVersion` 连同消息发送。未确认就阻止本次发送并显示同步状态。Go 接收消息时核对该版本，若版本已变更，返回冲突让前端刷新后重发；Agent 开始运行后每次 `read_canvas` 仍读取最新已提交版本。这是前端切换阶段的必要小改动，不能用普通 `flush()` 冒充保存确认。

`generate_*` 工具由 Go 先规范化模型、输入、目标节点和预计新增节点，持久化确认快照；用户批准的是该快照的摘要。批准后使用稳定请求 ID 创建 Go 生成任务，任何重试先查已有回执。供应商提交结果不明交给生成模块待核实；Agent 不自行重复付费请求。结果保存与画布附着由 Go 生成/资源模块负责。`ask_question`、`read_canvas`、`read_reference` 与技能读取也经 Go 按任务所有者授权；内置只读技能可先随 Runner 打包，个人技能库再迁移。

## 实施顺序与验收

1. **画布工具优先**：提取 TypeScript 画布操作计算器；Go 增加受保护的快照提交、权限核验和回执查询。用现有 Agent 编辑案例及浏览器历史用例做相同输入的结果比对，验证并发人工编辑、提交响应丢失、节点删除、撤销重做及不同用户隔离。此阶段不切换前端或生产 Agent。
2. **Go 控制面**：任务/消息/事件/确认表、命令接口、领取与租约、outbox/SSE。把第一步的假任务授权换为真实运行令牌；用假 Runner 验证幂等、同项目唯一活动任务和崩溃恢复。
3. **现有 Node Pi Worker 改接 Go**：保留固定版本 Pi 和进程内 MCP，把 SQLite 任务/资源访问换成 Go 内部接口；用假模型验证完整对话、工具调用、停止和继续。接口与逻辑测试先行，前端暂不动。最后再整理 Worker 的目录归属。
4. **历史导入与切换**：只读导出 SQLite 的 Agent 消息、任务、步骤、确认和生成批次；活动任务导入为 `interrupted`，保留供应商任务 ID，绝不重新提交。停写、导入、核对后再把前端调用层切到 Go；禁止 Next.js 与 Go 同写同一 Agent 任务。

验收需包含 RabbitMQ 重复/丢失通知、Runner 崩溃、租约过期、确认后断网、工具执行后回执响应丢失、人工同时编辑、目标节点删除、已有结果保护、供应商提交不明和跨用户访问。性能上分别限制单任务轮次与工具次数、模型超时、Runner 并发和事件写入频率。独立测试服务不得复用当前预览服务。

## 待实现前核定

- 当前侧栏的消息和快照 JSON 契约、事件流方式及旧任务导入字段。
- Pi 0.73.1 的事件与中断行为；上游 scope 已变化，升级需单独回归，不与迁移混做。
- TypeScript 计算器与 Go 提交入口之间的操作清单、快照差异、回执和冲突错误契约；现有历史仍由 TypeScript 生成并由 Go 原样存储。
- 内部 Runner 认证、模型凭据下发方式及部署拓扑；Runner 不接收用户 JWT 或任意项目 ID 的直接写权限。
