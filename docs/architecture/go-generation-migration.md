# Go 生成链路迁移设计

状态：架构方向已确认，接口与容量参数待实现前细化。决策依据：[ADR-0021](../adr/0021-rabbitmq-redis-for-go-generation.md)。

## 范围与第一条链路

第一阶段只建设 Go API、Go Worker、数据库与消息设施，通过 HTTP、SSE、集成测试和故障注入验证；不改 `apps/web` 前端代码。先迁移一个 RunningHub Krea2 生图工作流的完整链路，再用相同任务生命周期接入视频及其他模型。切换前 Next.js 的生成任务仍由原 Worker 处理；已提交供应商的旧任务不得因迁移重新提交。

## 运行时职责

| 模块 | 职责 |
| --- | --- |
| Go API | 校验身份、所有权、模型能力和幂等键；在 PostgreSQL 事务中创建任务及 outbox 记录；立即返回任务 ID；提供任务查询、取消和 SSE 进度接口。 |
| Outbox 发布器 | 发布任务 ID 到 RabbitMQ，等待发布确认后标记已发布；失败时补发。 |
| RabbitMQ | 持久化分发待处理任务的唤醒消息；使用 quorum queue、手动确认、受控 prefetch 和异常消息隔离。它不是任务状态的权威存储。 |
| Go Worker | 在独立进程中消费消息，以数据库租约和连接名额领取任务；执行供应商提交、查询、保存及恢复；按操作设置超时。 |
| RunningHub 适配器 | 封装 Krea2 的参数映射、提交、原任务查询和 WebSocket 进度解析；供应商协议不进入任务状态模块。 |
| PostgreSQL | 保存任务状态、输入快照、供应商任务 ID、租约、任务事件和 outbox；提供断线后的状态补查与运营审计。 |
| Redis Pub/Sub | 在数据库事件提交后广播任务 ID 和事件版本，唤醒各 Go API 实例上的 SSE 订阅者；丢失通知后从 PostgreSQL 补查。 |

```text
HTTP POST → Go API → PostgreSQL（任务 + outbox） → 202 + taskId
                           ↓
                    outbox 发布器 → RabbitMQ → Go Worker
                                                  ↓
                                         RunningHub / OSS
                                                  ↓
                                      PostgreSQL（状态 + 事件）
                                                  ↓
                                       Redis Pub/Sub → Go SSE
```

Go 的“异步”是请求处理与任务执行分离：HTTP handler 只提交持久化任务，不在请求 goroutine 中等待生图，也不靠 `go func()` 启动无法跨重启恢复的后台工作。Worker 进程可以用受控的 goroutine 池并发处理消息；全局并发名额由数据库协调，避免多个实例各自认为还有空位。

## 任务领取和恢复

1. 消费消息后先查权威任务记录；终态或已被其他 Worker 领取的重复消息直接确认。
2. 在数据库事务中原子检查任务状态、供应商连接并发名额、租约与许可，再记录领取者和租约令牌。任务取消、审批失效或熔断时不提交供应商。
3. 消息仅用于唤醒。领取和后续恢复计划持久化后确认 RabbitMQ 消息；不把长时间生成绑定在未确认消息上。数据库扫描器补发未发布 outbox、找回到期租约与应查询任务；没有消息也能恢复工作。一次供应商任务可能经历多次短暂领取。
4. 所有状态写入带租约令牌或版本条件，过期 Worker 不得覆盖新领取者的结果；数据库事件与当前状态在同一事务中写入。
5. RabbitMQ 的重复投递只能导致重复检查，不能导致重复付费提交。提交开始后若未收到明确结果，转为“待核实”，由原供应商任务查询或人工排障决定下一步。

## 并发、熔断和异常

- Go Worker 的 goroutine 数、RabbitMQ prefetch、单用户限制和供应商连接名额分别配置；供应商名额跨进程生效。队列长度、最老等待时间和 Worker 心跳纳入监控。
- 熔断按供应商连接及操作区分。提交故障达到阈值时暂停新的付费提交，让任务留在队列；已取得供应商任务 ID 的查询和已取得结果的保存继续执行。半开探测、阈值与冷却时间在容量测试后定值。
- 查询与临时网络错误按上限和退避重试。付费提交结果不明确绝不自动重提。结果保存失败只重试保存，不重新生成。内容审核拒绝、用户取消、任务超时和供应商失败分别记录。
- Redis 不可用时，任务照常运行并落库；SSE 可以从 PostgreSQL 定期补查。RabbitMQ 不可用时，API 可持久化任务和 outbox，发布器恢复后补发；是否因队列积压拒绝新请求由容量和运营阈值决定。

## 进度接口与测试

`GET /v1/generation/tasks/{id}` 返回最新状态、阶段、可用的供应商进度和结果；`GET /v1/generation/tasks/{id}/events` 提供 SSE。客户端连接或重连时先取得数据库快照，再接收后续通知；事件带版本或游标并处理重复与间隙。百分比仅在 Krea2 实际返回可验证进度时展示，不能由排队时长估算。

不改前端时，使用 Go HTTP 测试验证创建、幂等、查询、取消和 SSE；使用真实 PostgreSQL、RabbitMQ、Redis 的集成测试验证发布确认、重复投递、Worker 崩溃和断线恢复；使用假 RunningHub 验证提交响应丢失、WebSocket 断线、查询超时、熔断和 OSS 保存失败。前端后续只替换生成接口和进度订阅的调用层。

## 仍需在实现前定值

- RabbitMQ、Redis 的部署与高可用等级，队列积压与拒绝新任务阈值。
- 单用户、模型和供应商连接的并发、排队上限及超时。
- Krea2 实际 WebSocket 事件与百分比语义；SSE 事件格式和保留窗口。
- 数据迁移的停写、旧任务排空、切换和回滚步骤。

参考：[RabbitMQ Go 工作队列](https://www.rabbitmq.com/tutorials/tutorial-two-go)、[RabbitMQ quorum queue](https://www.rabbitmq.com/docs/quorum-queues)、[Redis Pub/Sub 交付语义](https://redis.io/docs/latest/manual/pubsub/)、[RunningHub 任务进度示例](https://www.runninghub.ai/runninghub-api-doc-en/doc-8287471)。
