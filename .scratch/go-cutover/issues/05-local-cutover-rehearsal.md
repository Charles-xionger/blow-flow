# 05: 完成历史导入与本地切流演练

**What to build:** 在本地以同一创作者账户完成历史数据导入和完整创作链路演练，证明 Go 路径能独立承担项目写入、助手工作和结果交付，并能在异常后安全恢复。

**Blocked by:** 02: 迁移个人技能库的账户归属；03: 补齐创作助手画布操作；04: 补齐创作助手生成与结果交付。

**Status:** resolved

- [x] 导入并核对项目、文件夹、画布、素材、脚本任务、助手会话和个人技能库的标识、内容与账户归属；其他用户无法访问。
- [x] 未完成的旧助手任务保留为中断且只读的历史；旧确认和旧供应商请求不会被重新执行。
- [x] 本地跑通登录、读取并保存画布、助手对话与操作、生成确认、进度查询和结果查看；图片、视频、脚本及助手固定案例均核对最终保存结果。
- [x] 演练覆盖重启、重复消息、通知丢失、任务失败、单一权威写入方，以及 Go 已产生新增数据后的停止写入、差异核对与回滚。
- [x] 形成可复现的演练记录，列出通过项、失败项及生产切流仍需满足的门槛。

## Answer

本地一次性 Go 切流演练已完成。可复现步骤和人工核对记录见 [演练说明](../../../docs/architecture/go-cutover-local-rehearsal.md)，机器证据见 [2026-11-20 记录](../../../docs/architecture/go-cutover-rehearsal-2026-11-20.json)。该次运行耗时 55.6 秒，18/18 项通过；历史资源的数量和标识逐项一致，旧待确认助手任务中断且未重新入队。导入后的创作者通过 Go 路径完成登录、画布保存、助手操作、图片与视频生成确认及结果读取，另一个账户无法读取其项目、助手任务和生成任务。重复消息、通知丢失、失败重试、重建 API 路由和只读旧任务均有覆盖。

演练确认旧 SQLite 在 Go 写入后摘要未变，并记录了新增项目、画布版本、助手任务、脚本任务与两项已交付生成任务的 Go 独有 ID。这里的回滚证明是停止写入和差异清单；尚无可将 Go 独有数据无损写回旧系统的反向迁移。生产切流仍需确认备份及恢复目标、使用真实供应商凭据完成冒烟验证、建立运营监控，并决定回滚时 Go 独有数据的处置方式。演练使用假供应商响应，未运行完整 Web UI 或付费供应商调用。

## Review-fix follow-up

The original 18-case rehearsal overstated the joined runtime and rollback coverage. The review-fix run now starts the Node Pi Runner and Go generation workers against deterministic fake model and supplier responses, verifies external media bytes and owner access, reconciles Go-only synthetic rows, and reopens the disposable legacy SQLite read-only. See the updated rehearsal document and 20-case evidence. This remains a local read-only rollback proof; real Go-only data disposition and production reverse migration remain release gates.
