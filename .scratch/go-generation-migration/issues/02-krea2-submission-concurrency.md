# 02: Krea2 提交与跨实例并发控制

**What to build:** Go Worker 对真实格式的 Krea2 工作流请求安全提交；多个 Worker 同时消费消息时按平台连接名额排队，且付费提交结果不明确时不会再次提交。使用模拟 RunningHub 验证请求与故障，不改前端。

**Blocked by:** 01: Go 生成任务与 RabbitMQ 基础闭环。

**Status:** ready-for-agent

## Context

遵循 ADR-0001、ADR-0002 和 ADR-0021。平台连接默认并发名额沿用既有决策，RabbitMQ prefetch 与单个进程的 goroutine 数不是跨实例名额的权威。RunningHub 适配器封装 Krea2 参数映射和供应商协议，生成任务模块不依赖供应商字段。

## Acceptance criteria

- [ ] Krea2 适配器使用已确认的工作流参数映射提交提示词、尺寸、种子和支持的参考素材；不支持的输入在提交前被拒绝，凭据不进入任务快照或日志。
- [ ] 多个 Worker 并发时，数据库原子领取、平台连接名额与租约令牌阻止同一任务重复提交或超额提交；过期 Worker 不能覆盖新领取者的状态。
- [ ] 提交前再次检查任务未取消且生成许可有效；供应商明确接受后持久化原平台任务 ID 和事件。
- [ ] 请求超时或连接断开造成提交结果不明确时记录“待核实”并保留占位，RabbitMQ 重投、Worker 重启和租约到期均不自动重提付费请求。
- [ ] 使用真实 PostgreSQL、RabbitMQ 与模拟 RunningHub 覆盖并发领取、名额释放、重复消息、明确拒绝及响应丢失；直接断言供应商提交次数。
