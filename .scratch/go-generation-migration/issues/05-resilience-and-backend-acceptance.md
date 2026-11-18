# 05: 生成链路熔断与后端故障验收

**What to build:** 运营人员通过 Go API 和监控指标识别队列积压、供应商故障及卡住任务；系统在异常时暂停新的付费提交，并安全恢复已经提交的任务。用接口与故障演练完成后端验收，前端改造和生产切换另行安排。

**Blocked by:** 02: Krea2 提交与跨实例并发控制；03: 原任务进度跟踪与结果交付；04: Redis 通知与 Go SSE 进度接口。

**Status:** ready-for-agent

## Context

遵循 ADR-0002、ADR-0016、ADR-0018、ADR-0021。熔断按平台连接和操作区分；提交熔断不得阻断已提交任务查询或结果保存。生产资源归属迁移、旧任务排空、切换和回滚仍是后续上线前置，不在本票实施。

## Acceptance criteria

- [ ] 供应商提交错误达到可配置阈值时暂停新提交，排队任务不被误判为失败；查询和保存继续，半开探测与恢复有明确状态和记录。
- [ ] 单用户、模型和平台连接的并发与排队限制可配置；超额请求和积压达到阈值时返回可辨识的 API 错误，不无限增长队列。
- [ ] 队列长度、最老等待时间、Worker 心跳、各阶段耗时、失败分类和待核实任务数可由 Go 管理接口或指标查看；敏感访问有审计。
- [ ] RabbitMQ 不可用时 outbox 留存，恢复后补发；Redis 不可用时任务仍落库并可查询；Worker 崩溃后租约回收不会重新提交状态不明的付费请求。
- [ ] 在真实 PostgreSQL、RabbitMQ、Redis 与模拟供应商环境中进行故障注入，覆盖重启、重复投递、熔断、积压、通知丢失及恢复；固定 Go API 契约供后续前端重构使用。

## Comments

- Implemented on `codex/go-generation-integration` in commits `573e6d5`; cross-ticket review fixes in `e7074f1`. Frontend and production cutover remain outside this effort.
