# Spec review — 2d3af5f...993a489

Read-only source review; no tests, application execution, or provider calls performed. Findings below are static control/data-flow conclusions, not claims of reproduced browser or paid-provider behavior. Sources: feature spec and tickets 02–07, glossary, relevant ADRs including 0009/0011/0012. Ticket Answer claims were not treated as evidence.

## P1 — Protect indirect assistant mutations of published text

Location: `lib/agent/canvas.ts:80` (new safeguard), with lines 70–74, 92–96 and 128; `lib/canvas/prompt.ts:135–138`.

Spec `.scratch/script-production/spec.md:106`: “助手节点目录、创建和连接能力同步使用新类型和发布服务，沿用已确认的内容所有权与冲突保护。” Line 86: “更新目标前检查其相对上次发布的内容版本。已有人工修改时提示冲突”. ADR-0011 exempts connections on the premise that they do not change node content.

Trigger: a user publishes a script as text T, edits T manually, then an assistant task creates/uses another text S and issues `edit_canvas connect S → T` (T need not be referenced or granted). `unauthorizedUpdates` only examines explicit update operations. The new scriptSource guard likewise only runs in the update branch. The connect is accepted by the graph contract, then syncReferences appends `{ref:S}` to T's prompt. Expanded T and its existing downstream consumers now include S's text without publish_script, review of T's current text, or explicit publication confirmation. Disconnecting an existing referenced edge likewise rewrites T's prompt. This is an actual content mutation, not merely topology. It also remains possible to alter S later and change T's expanded content.

Fix: determine effective content mutations after reference synchronization, then enforce the published-target authorization/conflict boundary for those mutations. Preserve ordinary outgoing T → downstream connections and manual user edits. Do not simply prohibit every connection involving a published node. This is newly relevant to the added guard/publishing boundary even though general reference synchronization predates the diff.

## P2 — Keep local script edits across console lifecycle changes

Location: `components/nodes/shared/ScriptVersionPanel.tsx:15`, `components/nodes/ScriptNode.tsx:78`; supporting `components/nodes/NodeShell.tsx:27,49`.

Spec line 80: “编辑稿独立保存”; line 94: “宽输入区支持展开”; problem statement line 10: “刷新页面、服务中断或重新生成都不会悄悄覆盖已有作品”. Ticket 05 requires preserving edits and independently saving drafts.

Trigger: edit a completed script draft without clicking Save, then expand the console or select another node and return. Draft text and dirty state exist only in DraftEditor/ScriptVersionPanel useState. NodeShell unmounts the console upon deselection; inline-to-portal replacement unmounts it on expansion. Neither path saves nor warns. The remounted editor reads the previous server draft, silently discarding the user's work. The local dirty lock only blocks the version selector and does not protect these routine interactions. The same issue loses text retained after a draft conflict or failed save.

Fix: own pending edits outside the ephemeral console subtree, keyed by canvas/node/version (or explicitly save/guard before unmount and portal changes). Preserve unsaved text and its expected draft revision until successful save or explicit discard.

## Review limits

No additional confirmed bug found in the inspected task lease/stop fencing, SSE revision merge, completed-version publication check, publish receipt transaction, migration IDs and history rewriting. These remain unverified dynamically, not certified correct. No test nonexecution finding: the user explicitly forbids tests/provider calls. No verified unrelated scope creep reported.
