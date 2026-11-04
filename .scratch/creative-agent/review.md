# Creative Agent integration review and fixes

Reviewed baseline: `6de46868a592d000fb8dcaf43f5d9f1705eff434` (`integration/creative-agent`). Fix branch: `ticket/creative-agent-review-fixes`. Review axes remain separate; controlled tests do not constitute manual provider acceptance.

## Standards

- **P1 — ADR-0002 late output ordering: fixed.** Two approved generations for the same target could complete in reverse order and the older result replaced the newest display. Reconciliation now checks persistent task creation order within the same immediate transaction as attachment, including newer manual requests through `GenerationService`. Obsolete results remain in their task artifacts with an explanatory note; they add no canvas mutation/history. The red test demonstrated the old image replacing the new image and an extra history entry; green coverage includes reverse completion, failed-save retry, repeated reconciliation, and a newer manual task. The partial-success test now distinguishes retained earlier artifacts from the latest-task display. Agent same-content edit policy and existing manual stale-result checks remain intact. Legacy browser-only generators were not migrated into persistent tasks.
- **Architecture judgment — shared permission/lease boundary: addressed.** `GenerationPermissions` owns approval persistence, exact-input authorization and matching binding advancement. `generationOwnerState` owns interpretation of Agent task/worker leases. Callers share the existing database connection and transaction: approving plus queueing, attaching plus advancing bindings, and checking the paid boundary remain atomic. Agent generation tools no longer directly query/update permission rows; the generation service no longer interprets Agent task/worker tables. Existing stop, lease expiry, restart, sibling approval and asynchronous preparation races pass through public service tests.

## Spec

- **P1 — deleted historical reference poisons later tasks: fixed.** Real Pi regression finishes a task referring to `hero`, deletes that node through the public canvas service, then starts unrelated work. Previously the next task failed before the controlled model ran. Persisted message conversion now explicitly describes an unavailable historical node and proceeds. New messages referencing an absent node still fail validation; direct reference tools remain strict. Request replay checks run before current-node validation so a lost-response retry retains its identity.
- **P2 — uploaded image unavailable as a generation reference: fixed.** The sidebar now uses existing `/api/upload/image` storage to preserve original bytes and persists the returned URL/object key in the conversation. Planning receives reusable asset metadata alongside a separately downsampled vision image. Upload failures are shown and sending waits for upload completion. A controlled real-Pi/MCP test uploads an original 2048×1700 transparent PNG unchanged, prepares an image and H3 video batch referencing the original URL, approves it, and reopens the service to verify both requests and stable reference identity. The browser case verifies original multipart bytes and persisted URL/object key after reload. Storage HTTP/provider boundaries are controlled; application task, approval and persistence paths are real.

## Validation on completed source

- `pnpm typecheck`: passed.
- Scoped ESLint across all changed application/test/fixture files: passed.
- Focused public suites (`agent*`, `generation*`, `h3*`): **93 passed, 0 failed, 5.55 s**.
- Focused browser `tests/browser/agent-sidebar.spec.ts`: **4 passed, 0 failed, 49.6 s**; source guard enabled, sources unchanged during run.
- `git diff --check`: passed.
- Node 25 used `NODE_OPTIONS=--no-experimental-webstorage`; browser used `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/ai-flow-cached-inter-unquoted.cjs`. Local dependency clone required rebuilding `better-sqlite3` for Node 25.
- Final full fast suite and full browser regression remain assigned to the integration owner after merging these fixes. These focused passes are not reported as final full-suite passes.

## Manual acceptance — pending

No real paid model/image/video calls were made. Real Gemini visual interpretation and freeform skill/tool choices, actual OSS upload, image/video generation quality and reference effects, and continuous creative results remain for user acceptance using the scenarios in ticket 04. These review fixes do not change that status.

## Supplemental integration regression repair

The integration owner's first full browser run on `eff80a7` completed with **123 passed, 2 failed, 6.8 minutes**. Both failures were independent human-client conflict recovery (choose server / choose copy); this was not a full pass. Read-only diagnosis during that run found idle polling had already replaced the local project title with another human client's rename, because automatic Agent reconciliation accepted all logged operations.

- Added optional `source: 'agent'` history provenance at the public Agent canvas writer and preserved it when reconciling operations. Existing histories remain valid; absent provenance is conservatively treated as non-Agent. Human undo/redo does not inherit Agent authority.
- Automatic reconciliation now requires every unseen operation in the remote delta to be Agent-originated. Human-only and mixed deltas leave the local baseline intact during idle polling and enter the existing conflict/copy recovery path after a rejected save. Common-baseline/content validation remains required. The incoming-work serializer consumes its bookkeeping rejection while callers still receive the actual failure, preventing an unhandled promise rejection during this intentional refusal.
- Red/green public autosave regression reproduced the unexpected remote rename, then verified idle preservation and durable conflict recovery for both human-only and mixed deltas. Existing Agent merge tests still verify unrelated local edits, exact inverse undo and retained provenance.
- Completed-source validation: typecheck and scoped lint passed; **187 related Agent/canvas fast tests passed, 4.42 s**; affected browser consistency + Agent canvas files **9 passed, 0 failed, 52.8 s**, including both originally failed cases and live Agent synchronization. Source guard remained enabled; sources were frozen during checks. `git diff --check` passed.
- The integration owner must rerun full fast and full browser validation after this shared persistence fix. No final full-suite pass is claimed here. Manual provider acceptance remains pending.

## Final integration validation

补充修复合并后，类型检查和全部 53 个受影响文件 ESLint 通过；完整快速测试 269/269（8.06 秒）、完整浏览器 125/125（5.8 分钟）通过，源码检测通过。此前全量 123/125 的失败及定向复测记录保留如上。两个审查轴均已只读复核原发现得到修复。详见 [implementation-results.md](implementation-results.md)。
