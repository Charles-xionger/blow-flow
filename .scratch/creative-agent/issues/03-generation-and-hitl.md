# 03: 图片、视频生成与批次 HITL

**What to build:** 用户让助手准备一批图片或视频生成，查看方案并确认后，助手通过内部 MCP 调用已有生成服务，后台保存产物并写回画布。助手可使用前一步结果继续创作，用户可以修改要求、停止或选择重试失败项。

**Blocked by:** 02: Agent 编辑画布、参数修改与实时同步

Status: resolved

依据：[父规格](../spec.md)，ADR-0001、ADR-0002、ADR-0007、ADR-0008、ADR-0009。

- [x] MCP 支持发现已有可用图片/视频模型及能力、准备生成、执行获批生成、查询结果及将产物作为后续输入；复用现有后台任务服务，不另建供应商生成系统，也不要求迁移全部旧模型路径。
- [x] 校验实际模型支持的提示词、尺寸、时长、参考图/视频/音频及其顺序和有效性，沿用现有能力契约；模型不能通过自造参数绕过校验。
- [x] 生成前展示一批明确操作的内容、参考素材、数量和关键规格，用户可确认、通过对话修改或取消；不要求每次读取、选模型或内部工具调用单独审批，不强制完整参数编辑器。
- [x] 批准由应用持久记录并绑定实际生成要求，执行层检查调用是否在批准范围内；不能仅凭 Agent 传入已确认标记提交。未批准、取消或失效的操作不能发起生成。
- [x] 风格、参考素材、数量等要求改变时，暂停尚未提交的受影响项并重新确认；已提交任务不视为被撤回。实际参数因画布变化而改变时不得沿用不匹配的批准。
- [x] 批次可包含多项明确生成操作，重复确认、工具请求或网络响应丢失不会重复提交；各项执行及结果有可追溯身份。
- [x] 图片、视频生成在后台执行并保存原始产物，完成后由服务端将结果关联并写回画布、同步打开的页面；关闭页面不阻碍结果写回或后续步骤读取产物，消除原有浏览器驱动挂接依赖。
- [x] 目标节点已删除时不复活，结果仍保存在关联任务中并向用户说明。写回遵循同内容覆盖及无关编辑保留规则，历史回放不会重新调用模型。
- [x] Agent 可等待前一步产物后继续调用工具；是否暂停选图取决于任务意图，不固定角色图到视频流程。超出已批准范围的后续生成重新请求确认。
- [x] 等待批准期间关页不自动同意，重开仍能确认、修改或取消；用户补充要求能影响尚未提交的后续工作。
- [x] 停止阻止后续规划和工具提交，并取消本轮尚未提交供应商的任务；已提交任务继续跟踪、保存结果，已完成画布修改不自动回滚。验证停止与提交并发时不会越过停止边界继续发起新提交。
- [x] 一批部分失败保留成功结果并报告失败原因；重新生成须用户明确确认，不自动反复尝试或换模型。状态查询和重试保存已有产物可以自动进行。
- [x] 提交结果不明确时沿用待核实处理，不直接再次提交；成功但保存失败时仅重试产物保存，不重新生成。
- [x] 通过公开 Agent 任务入口和可控模型/供应商输入验证批准、失效、幂等、后台写回、连续执行、停止、部分失败和保存恢复；浏览器覆盖批次确认、修改、取消、关页重开及结果同步。
- [x] 完成类型检查、受影响代码 lint、完整快速测试及完整浏览器回归；自动化不调用真实付费图片/视频接口。真实图片、视频及参考效果、连续创作由用户人工验收，明确记录已完成与待验收场景，不混同替代服务测试。


## Comments

2026-11-04 — Ticket 03 implementation is complete on `ticket/creative-agent-03`; final integrated browser regression remains assigned to the integration owner after ticket 04/review.

- Added durable explicit generation batches and scoped questions with canonical actual-input permissions, ordered references, exact specification display, approval/modify/cancel, request identities, and project-local result summaries. New requirements revoke unsubmitted items; generation-affecting canvas edits invalidate their submission bindings. The paid-boundary transaction checks the persisted permission and task state after asynchronous preparation.
- Reused `GenerationService` / `GenerationWorker` for Krea2, H3, and a minimal adapter to the existing Gemini Nano Banana Pro image service, including ordered reference images. Gemini approval displays its actual ratio/size preset contract and states that output pixels are model-determined. Other legacy providers are not migrated, and existing manual model menus retain their contracts.
- Stopping cancels this run's queued/pre-submission requests without deleting or tombstoning the node. Submitted jobs retain tracking/storage. Planning completion with outstanding generation stays stoppable in a durable generation wait and resumes downstream after terminal results.
- The Agent worker attaches saved originals via `CanvasAgentService` receipts/history, including while pages are closed; deleted targets remain deleted. Successful siblings survive failure/uncertainty; save retries reuse successful output and never resubmit. Existing manual stale-result rules are unchanged.
- Red/green evidence includes missing approval implementation, missing Gemini adapter, own-output attachment incorrectly invalidating sibling approval, and planning returning too early to remain stoppable. Eight public Agent generation cases cover approval/idempotence, revocation/scoped stop, save recovery/attachment, image references, success+failure+uncertainty, stop/input-change races, closed-page continuation/deletion, and durable generation wait. Existing generation/H3/canvas cases also pass.
- Validation: `pnpm typecheck` and affected-file ESLint pass. Full fast suite: 256 passed, 0 failed (5.67 s). Final focused browser run (`agent-sidebar.spec.ts` + `agent-canvas.spec.ts`): 4 passed, 0 failed (46.5 s). Earlier focused runs exposed and fixed fixture preview/model-load readiness issues; these are not represented as full-browser passes. `NODE_OPTIONS=--no-experimental-webstorage` is required for Node 25; browser run uses the cached Inter response path supplied by integration.
- Actual Gemini/RunningHub paid generation, real image/video reference effects and real creative quality/continuous creation remain **not manually accepted**. Automated model/provider/storage boundaries are controlled; no real paid calls were made. Full browser regression is still pending at the integration boundary, so the final validation checkbox remains open.

## Answer

已合并到 `integration/creative-agent`，本票实现及自动化验证完成。最终类型检查、53 个受影响文件 lint、269 项快速测试及 125 项完整浏览器测试全部通过；审查修复和首轮失败后的完整重跑见 [最终验证](../implementation-results.md)。真实供应商与创作效果保持待人工验收，不纳入本次自动化通过声明。
