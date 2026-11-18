# 04: Redis 通知与 Go SSE 进度接口

**What to build:** 客户端只调用 Go API 即可订阅生成任务进度；多个 Go API 实例通过 Redis 收到状态变化并推送 SSE，断线或 Redis 故障后仍能从 PostgreSQL 补查最终状态。本票不接入前端页面。

**Blocked by:** 01: Go 生成任务与 RabbitMQ 基础闭环；03: 原任务进度跟踪与结果交付。

**Status:** ready-for-agent

## Context

遵循 ADR-0003、ADR-0016 和 ADR-0021。PostgreSQL 的状态和任务事件是权威来源；Redis Pub/Sub 仅用于跨实例唤醒，不保证离线消息回放。SSE 事件不得包含供应商密钥、鉴权地址或未授权的其他用户任务。

## Acceptance criteria

- [ ] Go API 提供任务快照和 SSE 订阅接口，订阅前验证资源所有者；事件包含稳定任务 ID、状态、阶段和版本／游标。
- [ ] 状态及任务事件提交数据库后才发布 Redis 通知；多个 Go API 实例上的订阅者可收到同一任务的变化。
- [ ] 首次连接、断线重连、通知重复或缺失时从 PostgreSQL 补齐最新状态；Redis 不可用时任务继续执行，SSE 以数据库补查恢复。
- [ ] 慢连接、客户端取消和服务端关闭不会无限占用 goroutine 或阻塞 Worker；通知不泄漏其他账户数据。
- [ ] 使用真实 PostgreSQL、Redis 和两个 Go API 实例的接口测试验证实时推送、断线补查、Redis 故障及权限隔离。
