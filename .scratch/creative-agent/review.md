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
