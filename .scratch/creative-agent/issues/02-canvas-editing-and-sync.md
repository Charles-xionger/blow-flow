# 02: Agent 编辑画布、参数修改与实时同步

**What to build:** 用户通过侧栏要求助手编辑节点、参数、连线或布局，后台执行后打开的画布同步更新数据与展示，关闭后重开仍一致。所有内容修改复用持久历史，用户可撤销、重做并追溯；内置技能产出可落到画布。

**Blocked by:** 01: Agent 侧栏、后台任务与 MCP 接入

Status: resolved

依据：[父规格](../spec.md)，ADR-0007、ADR-0009。

- [x] 扩展内部 MCP，支持节点与连线创建、读取、修改、移动和删除；工具参数验证目标存在性、当前项目归属及操作合法性，不允许模型绕过应用规则直接写原始存储。
- [x] 支持节点标题、文本、提示词、模型选择及该模型支持的生成参数修改；按当前模型能力校验值。涉及模型切换、连线兼容性和节点引用时，复用现有画布规则，不产生参数更新但引用关系失效的不一致状态。
- [x] 用户要求范围内的普通编辑直接执行；只有用户明确要求删除已有内容时直接删除，否则复用提问交互取得决定。生成参数编辑不等于批准发起生成。
- [x] 后台操作作用于最新项目内容并持久保存，不依赖打开的浏览器执行。浏览器打开时自动同步节点数据、参数控制台、连线与布局，不要求手动刷新；关闭后重开得到相同结果。
- [x] 后台修改与本地编辑同步时，只覆盖 Agent 要写入的同一内容，保留无关修改；不以旧整张画布快照替换最新内容，不取消保存版本检查，不将响应丢失误作重复执行理由。
- [x] 目标在执行期间已被删除时跳过写入并说明原因，不自动复活；保留现有人工生成任务过期结果保护。
- [x] 人工操作与 Agent 操作共用一套持久历史，一次完整创作步骤形成可撤销批次，内部变更可追溯。记录覆盖前的实际内容，撤销可恢复被覆盖内容；重复工具请求不重复修改或新增历史。
- [x] 撤销和重做跨刷新、关页及项目切换保持一致；任务进度、选择和视口不进入内容撤销栈，撤销/重做不提交生成。生成批准批次与撤销批次不强制一一对应。
- [x] 内置技能生成的剧本、分镜等可通过通用画布工具落为节点及连线，不将技能绑定为强制流水线。
- [x] 评估并接入适合当前画布的成熟布局方案，优先考虑 elkjs；Agent 描述布局意图，由确定性代码计算坐标，考虑节点尺寸、连线和分组。
- [x] 新增内容默认只布局新增节点，在相关节点附近寻找可用位置，不移动已有节点；明确要求整理才调整已有布局，指定选区时只整理选区。一次整理可整体撤销，不影响范围外内容。
- [x] 通过公开任务及画布接口验证写入、参数校验、批次历史、重复请求、同内容覆盖、无关编辑保留和删除目标；浏览器验证参数控制台实时更新、布局范围、实际节点尺寸、undo/redo、断网重开和项目切换。
- [x] 最终集成边界执行完整浏览器回归（由主 Agent 协调，在 02–04 集成后执行）；本票类型检查、受影响代码 lint、完整快速测试及定向浏览器验证已完成。真实供应商生成不属于本票验证前置条件。

## Comments

- 2026-11-04: Claimed on `ticket/creative-agent-02`, based on integration `7e0895d`. Tests use agreed public Agent task/canvas interfaces with real persistence and controlled model inputs; browser tests cover visible synchronization.

## Answer

Implemented server `CanvasAgentService.apply(projectId, identity, operations, label?)` and registered `edit_canvas`, `delete_canvas_nodes`, `layout_canvas`, `canvas_models` tools. The service applies intents to the latest project in an immediate transaction using `saveWorkflow`; durable tool receipts and one undo batch commit with the content. Absent targets are skipped, project tombstones reject writes, and all saved node removals now retain node tombstones so a later Agent create cannot reuse a deleted identity. Ordinary edits share generation content-version protection with the manual editor; deletions cancel eligible existing generation tasks through their public service.

Model-facing edits accept a restricted field set. Task-service dimensions/duration use actual model capabilities; configured existing text/image/video models remain discoverable/selectable, with their existing editor presets validated separately. Existing legacy preset controls are not represented as newly supported Agent generation backends. Model/type changes recheck compatibility and synchronize edges/references atomically. An explicit user command naming exact node IDs authorizes deletion once; otherwise a persisted question binds approval to the displayed node IDs. A model-provided confirmation boolean cannot authorize deletion, and a declined question preserves the targets.

ELK 0.12.1 provides deterministic layered layout. New nodes are placed near a connected existing node or a nearby existing anchor without moving existing content; collision checks include saved node dimensions. New groups lay out children bottom-up and grow to contain them. Existing layout scopes move selected roots only and preserve parent-relative positions; insufficient room inside an unchanged group is reported rather than silently resizing outside the scope.

Live reconciliation is part of the existing IndexedDB/autosave coordinator. It retains a confirmed server baseline and never replaces an uncertain pending request. After a definitive version rejection, or an idle remote update, remote history is evaluated on its original timeline and converted into stable-ID semantic changes. Those changes are recorded against the actual local state, preserving unrelated unsaved edits and making undo restore the overwritten local value. No array-index patch concatenation or whole-snapshot replacement is used. Local commit work and incoming reconciliation are serialized; edits arriving during IDB work are rebased before publication. Selection, viewport and open controls remain local. Unknown/unlogged remote changes retain the existing recovery fallback.

### Validation evidence

- `pnpm typecheck`: passed.
- Scoped ESLint covering all changed application/test files: passed (Node test entry points explicitly permit CommonJS imports).
- Full fast suite: **248/248 passed, 6.23 s**, with `NODE_OPTIONS=--no-experimental-webstorage`. Prior full run had 246/247: the existing performance network fixture handled only PUT; it now routes GET through the real workflow reader. The subsequent 247/247 and final 248/248 full runs passed.
- Public Agent task/canvas interfaces: **10 focused cases passed**. These cover durable step batching, tool dedupe, inverse history, live version rejection/rebase, unsaved unrelated edits, real deletion approval, node tombstones, valid/invalid model parameters, atomic reference updates and new group layout. SQLite and IndexedDB are real; model input is controlled and no paid calls are made.
- Browser: existing sidebar cases **2 passed** on the completed editing/layout implementation; the new Agent canvas case **1 passed, 19.1 s runner / 15.0 s case** after correcting the offline simulation. It checks a live custom-size console, persisted undo/redo, closed-page completion, layout scope, reopened nodes and IndexedDB restoration with workflow API requests unavailable. The app shell must still be reachable; no service worker/offline installation was added.
- Earlier browser runs found and fixed selection loss during incoming changes; later fixture corrections used exact button matching and retained the custom-size mode so dimension fields remain visible. The prior combined focused run was **3 passed, 38.8 s**; the final combined run had two passes and an offline app-shell navigation failure, followed by the corrected focused pass above. Full browser regression remains explicitly assigned to the final integration boundary.
- Font network is unavailable in this environment. Browser runs use actual cached Inter font files through `/tmp/ai-flow-cached-inter-unquoted.cjs`; this differs from the earlier Arial fallback. Quoted `url()` values in the initial cached response file were rejected by Turbopack; removing quotes made the cached files usable. No font/config workaround is committed.
- Real Gemini and paid image/video calls were not run; user acceptance remains separate.

- Final read-only review also normalized the confirmed baseline when adopting a recovery snapshot or restored project; typecheck, scoped lint and the full 248-case fast suite passed after that bookkeeping fix. The final full browser suite will cover those shared recovery paths.

## Answer

已合并到 `integration/creative-agent`，本票实现及自动化验证完成。最终类型检查、53 个受影响文件 lint、269 项快速测试及 125 项完整浏览器测试全部通过；审查修复和首轮失败后的完整重跑见 [最终验证](../implementation-results.md)。真实供应商与创作效果保持待人工验收，不纳入本次自动化通过声明。
