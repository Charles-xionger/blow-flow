# 01: Go 生成任务与 RabbitMQ 基础闭环

**What to build:** 已认证的用户通过 Go API 发起一项 Krea2 生图任务并立即取得任务 ID；任务保存在 PostgreSQL，经 RabbitMQ 交给独立 Go Worker，使用模拟供应商完成一次可查询的生成。此票只通过 API 与逻辑测试验收，不修改前端，也不切换现有 Next.js 任务。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

## Context

遵循 ADR-0002、ADR-0016、ADR-0018、ADR-0021 和 Go 生成链路迁移设计。任务、输入快照、任务事件和 outbox 以 PostgreSQL 为权威；RabbitMQ 消息只携带定位信息。Go 当前尚未接管生产项目与素材归属，本票使用受控测试资源验证账户、项目和参考素材的所有权检查；生产切换不属于本票。

## Acceptance criteria

- [ ] API 校验身份、资源所有者、Krea2 模型能力和输入，创建任务后立即返回任务 ID；任务查询只对资源所有者及授权管理员开放，敏感输入和供应商密钥不出现在公开响应中。
- [ ] 相同幂等键和相同输入返回同一任务；相同键和不同输入明确冲突，并发请求不会创建多个任务。
- [ ] 任务、当前状态、不可变任务事件与 outbox 在同一 PostgreSQL 事务中创建；事务失败不留下孤立任务或消息。
- [ ] Outbox 发布器以发布确认向持久化 RabbitMQ 队列发送任务 ID；发布失败可补发，重复投递不会重复执行已领取或已完成任务。
- [ ] 独立 Go Worker 使用模拟供应商完成任务；HTTP 请求结束或 Go API 重启不影响任务执行。API 能查询排队、执行与完成状态。
- [ ] 尚未提交供应商的任务可取消；取消后即使收到迟到消息也不会执行。任务创建、查询、取消和 RabbitMQ 闭环有接口及真实 PostgreSQL／RabbitMQ 集成测试。

## Comments

- Implemented on `codex/go-generation-integration` in commits `5fe3ac0`; cross-ticket review fixes in `e7074f1`. Frontend and production cutover remain outside this effort.
