# 04: 服务重启恢复与连续创作收口

**What to build:** 后台服务重启后，用户重新进入项目可恢复消息、步骤及待处理事项，并主动继续中断的创作；已提交的图片、视频任务继续查询而不重复生成。完成首版跨断网、关页、重启、停止和项目切换的连续创作行为。

**Blocked by:** 03: 图片、视频生成与批次 HITL

Status: resolved

依据：[父规格](../spec.md)，ADR-0002、ADR-0008、ADR-0009。

- [x] 服务重启后从持久记录恢复消息、步骤、工具结果、生成关联、批准及等待事项，不依赖旧进程内存或客户端缓存才能解释任务状态。
- [x] 中断的 Agent 任务显示待继续，由用户触发；等待回答或批准的事项保持未决，不因重启自动同意。停止或已结束的任务不自动重启。
- [x] 用户继续后基于已有步骤结果和最新项目状态续行，不重复已完成画布修改、历史记录或生成提交；重复点击继续、请求响应丢失及进程中断不能创建同项目并行任务。
- [x] 已提交图片、视频任务自动恢复查询和产物保存，不等待用户继续 Agent，也不以重新生成替代恢复。产物挂接去重，已删除目标不复活。
- [x] 已批准但未提交的操作只有在 Agent 继续且批准仍匹配时才执行；等待期间新要求或参数变化按原规则重新确认，不能使用过期批准。
- [x] 恢复后新消息仍用于调整当前任务；任务停止仍阻止后续调用及未提交生成，不丢失已提交任务结果或已完成画布内容。
- [x] 用户可清楚区分执行中、等待回答、等待批准、待继续、完成、停止和失败，并查看关联结果或原因；同项目单任务及跨项目隔离在恢复后保持。
- [x] 验证服务重启发生在工具调用前后、画布写回前后、等待批准、生成已提交及产物保存阶段时，不静默重复副作用或遗失已确认结果；提交事实不明确时继续核实而不盲目重试。
- [ ] 完成自由创作组合场景：参考图理解与提问、技能按需使用、节点与参数修改、局部布局、批次批准、图片/视频连续执行、部分失败与确认重试、停止及历史回放；不要求模型每次选择完全一致的内部步骤。
- [x] 浏览器组合覆盖关页重开、断网恢复、服务重启继续和快速项目切换；确认打开画布实时同步，未打开画布后台执行，不串项目、不覆盖无关编辑。
- [x] 按父规格逐项核对首版行为与明确排除项，修复集成缺口，不把首版恢复扩展为任意步骤全自动续跑、外部 MCP 或多 Agent 并发协作。
- [x] 完成类型检查、受影响代码 lint、完整快速测试及完整浏览器回归，验证期间保持应用、测试、配置和环境不变；全量结果与失败后定向复测分别报告。真实供应商生成仍由用户人工验收，保留可执行场景与实际验收状态，不自动发起付费调用。

## Comments

2026-11-04 — Implemented on `ticket/creative-agent-04`; integration review and final full browser regression remain assigned to the integration owner. The ticket remains claimed until that boundary is complete.

- Durable worker leases/run identities fence planning, tool entry, transactional canvas writes and late results. Only expired owners are interrupted; live workers and different projects retain their work. Explicit continue reuses the task and request receipt; post-restart answers resume pending questions/approvals without a redundant continue.
- Restarted planning, including `awaitingGeneration`, requires user continue. Approved queued generation stays queued while its old owner is interrupted/expired; it does not become cancelled merely because of restart. Paid-boundary checks run again after asynchronous preparation. Already-submitted generation queries/saves/attaches independently.
- Continued runs reconcile interrupted idempotent tools using existing durable receipts before presenting history to the model. A real child process is killed after a real canvas commit and before Agent tool-result persistence; continuation keeps the exact original canvas history and one undo entry. Unknown non-idempotent tool outcomes remain explicitly failed for inspection rather than poisoning all continuation.
- Fixed real Pi provider errors being swallowed and persisted as completed. Real Pi/MCP tests cover both thrown providers and streamed error messages. MCP schemas now validate at the public tool boundary; model-provided confirmation flags cannot authorize deletes/generation. New requirements replace pending generic questions instead of leaving the task waiting indefinitely.
- Saved-output transfer failures automatically retry existing results with persisted bounded backoff (three attempts); no new paid request is created. Image-to-video integration obtains the first saved artifact through the public Agent service, prepares a separate approved video request using it as a reference, then attaches both outputs.
- Red/green evidence: real Pi failure initially completed; killed worker initially remained running; expired approval initially submitted without continue; interrupted tool initially reached planning still running; save failure initially never retried; replacing a question initially stayed waiting; unknown tool parameters initially executed. Each now has passing public-boundary coverage with real persistence and controlled external inputs.
- Validation on completed source: typecheck and affected-file ESLint pass. Full fast suite: **266 passed, 0 failed, 8.06 seconds**. Focused browser `agent-sidebar.spec.ts` + `agent-canvas.spec.ts`: **5 passed, 0 failed, 59.5 seconds**, with the source guard enabled. These cover actual fixture-worker kill/restart, continue UI, persisted progress, offline/reload, close/reopen, approval/modify/cancel, project switching, canvas sync/layout/history. An initial focused restart test incorrectly closed an auto-open sidebar after reload; the corrected focused reruns passed. This is not a full-browser result.
- Final **full browser suite remains pending after mandatory integration code review and fixes**. Node 25 runs used `NODE_OPTIONS=--no-experimental-webstorage`; browser runs used `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/ai-flow-cached-inter-unquoted.cjs` (actual cached Inter).
- Parent spec audit: public controlled integration covers task persistence, tools/skills/reference loading, ordinary edits/history/deletion, concurrent editor reconciliation, exact batch approval, invalidation, stopped/submitted boundaries, partial failures, image/video dependencies and restart semantics. External MCP, uploaded/executed skills, automatic arbitrary planning restart, extra provider migrations and same-project multi-Agent execution remain excluded.

## Manual acceptance — not performed

No real paid provider calls were made. The following scenarios are executable by the user but **not accepted** by these controlled tests:

1. Configure Gemini and OSS, run Web plus both workers against one database; reference a real image and request a freeform creative change. Confirm visual understanding, only necessary clarifications and optional script/storyboard skill choice.
2. Approve a real image batch, close the page, reopen and inspect actual saved image quality/references. Request a follow-up video using that saved image; inspect a new approval and the real video/reference effect.
3. Change a pending proposal, cancel another, and stop while a batch is partly submitted. Confirm unpaid items stop and already-submitted results remain available; retry only selected failed output after a fresh approval.
4. Kill/restart the Agent worker during planning and during generation tracking. After the lease expires, confirm “待继续”; observe submitted results saving without clicking continue, then continue planning once. Repeat while awaiting a question/approval and verify it remains unanswered.
5. Edit an unrelated node while the assistant works, switch projects and return; inspect same-content override history, unrelated edits, deleted-target behavior and undo/redo without paid calls.

## Answer

已合并到 `integration/creative-agent`，本票实现及自动化验证完成。最终类型检查、53 个受影响文件 lint、269 项快速测试及 125 项完整浏览器测试全部通过；审查修复和首轮失败后的完整重跑见 [最终验证](../implementation-results.md)。真实供应商与创作效果保持待人工验收，不纳入本次自动化通过声明。
