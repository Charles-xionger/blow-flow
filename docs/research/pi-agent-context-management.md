# PI Agent 0.73.1 context management research

Research date: 2026-11-18. Status: **architecture recommendation; no application code changed**. Sources are the installed packages and the official upstream repository at the exact `v0.73.1` commit (`781152fc24841dc54b22284514604048ebe5e2c9`).

## Executive conclusion

`@mariozechner/pi-agent-core` 0.73.1 does **not** contain a built-in context-management or compaction plugin. It provides the seams on which an application can build one:

- `transformContext(messages, signal)` creates a non-destructive message projection immediately before every model call;
- `convertToLlm(messages)` converts or filters application-specific messages after that projection;
- `beforeToolCall` / `afterToolCall` can gate tools or replace their returned content;
- the low-level loop has `shouldStopAfterTurn`, but the 0.73.1 `Agent` constructor does not expose it;
- `@mariozechner/pi-ai` supplies model `contextWindow`, response `Usage`, and `isContextOverflow()`; it does not export a general production tokenizer or context compactor.

The automatic compaction users associate with Pi lives in the separate `@mariozechner/pi-coding-agent` package. That package is not installed here. Its implementation is coupled to its own append-only JSONL session tree, extension runtime, retry manager, coding tools, and coding-specific summary format. It is a valuable primary-source design reference, not a plugin to attach to this application's `Agent` instance.

For the 创作助手, keep the durable product conversation and tool/task facts lossless, and build a separate, replaceable **derived LLM context** from checkpoints plus a recent window. Use `transformContext` only for request-time projection; perform checkpoint creation, database writes, retry policy, and overflow recovery in an application-owned context service around the Pi runtime.

## What is installed

The web app pins both `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` to exactly `0.73.1` ([package.json](../../apps/web/package.json)); the lockfile resolves core against `pi-ai` 0.73.1 and marks both old-scope packages deprecated in favor of `@earendil-works/*` ([lockfile](../../pnpm-lock.yaml#L1150-L1158), [resolved dependency](../../pnpm-lock.yaml#L7164-L7192)). The official [`v0.73.1` release](https://github.com/earendil-works/pi/releases/tag/v0.73.1) is commit `781152f`, and all three upstream packages—agent core, AI, and coding agent—have version 0.73.1 at that tag ([core package](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/package.json), [AI package](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/package.json), [coding-agent package](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/package.json)).

`@mariozechner/pi-coding-agent` is not in this repository's dependencies or lockfile. Do not import examples from current `main` and assume they match 0.73.1; pin source links and any compatibility tests to the tag above.

## Exact core interfaces and constraints

### Message pipeline

Core documents and implements this order:

```text
AgentMessage[]
  -> transformContext()       // optional, application-level projection
  -> convertToLlm()           // required by low-level loop; default in Agent
  -> pi-ai Message[]
  -> provider
```

The exact 0.73.1 interfaces are in [`AgentLoopConfig`](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/types.ts#L115-L247):

```ts
convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
transformContext?: (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;
```

Both callbacks have a documented **must not throw or reject** contract; a safe fallback must be returned. Core invokes `transformContext` immediately before each model request, then invokes `convertToLlm`, and uses their result only to construct that request ([loop source](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/agent-loop.ts#L248-L285)). It does not replace `context.messages` or `agent.state.messages`. This makes the hook suitable for reversible pruning, summary injection, image filtering, and external-context injection—but not, on its own, durable compaction.

The stateful `Agent` accepts both callbacks in `AgentOptions`, copies arrays assigned to `state.messages`, and otherwise owns the live transcript ([Agent source](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/agent.ts#L64-L110)). In this repository, a new `Agent` is created for each worker run, so its state is ephemeral anyway ([runtime](../../apps/web/lib/agent/runtime.ts#L17-L35)).

### Hooks are not a compaction plugin API

`beforeToolCall` can block a call. `afterToolCall` can replace `content`, `details`, `isError`, and `terminate`; replacements are field-level, not deep merges ([types](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/types.ts#L41-L100)). If `afterToolCall` truncates a result, the truncated result is what core emits and retains. Therefore the application must first persist the full authoritative result outside core if it wants lossless audit/recovery plus a smaller LLM projection.

The low-level `AgentLoopConfig` also has `shouldStopAfterTurn`, called after the assistant and tool results complete and before another model call ([types](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/types.ts#L178-L188), [loop](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/agent-loop.ts#L216-L230)). In 0.73.1 it is **not** an `AgentOptions` field and the `Agent` wrapper does not pass one. The existing `new Agent(...)` integration cannot use it without switching to the low-level loop or changing/upgrading core.

### Token and overflow support

Every Pi model has `contextWindow` and `maxTokens`; each assistant response has:

```ts
usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { ... };
};
```

See the official [`Model` and `Usage` definitions](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/types.ts). `pi-ai` exports [`isContextOverflow(message, contextWindow?)`](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/ai/src/utils/overflow.ts#L69-L153). It recognizes provider error strings, successful responses whose input usage exceeds the window, and a zero-output length stop that fills at least 99% of the window. Its own documentation warns that custom providers and silent truncation may escape detection.

There is no exported general tokenizer in `pi-ai` 0.73.1. Its character-based estimator is internal to the faux test provider. Context planning therefore must prefer measured provider usage and treat local estimates as conservative heuristics, especially for images and provider-specific tool serialization.

### Stream failure contract

The `StreamFn` contract says request/model/runtime failures must be encoded as stream events and a final assistant message with `stopReason: "error"` or `"aborted"`; it says the function must not throw/reject ([core type](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/agent/src/types.ts#L15-L26)). The current runtime wrapper can throw `Task paused`, and its tests deliberately inject throwing test streams ([runtime](../../apps/web/lib/agent/runtime.ts#L34-L35), [fixture](../../apps/web/tests/fixtures/agent-runtime.ts)). This is separate from compaction, but any retry refactor should normalize failures at the runtime boundary rather than depend on thrown streams.

## What `pi-coding-agent` actually implements

The official 0.73.1 [compaction documentation](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/docs/compaction.md) and source show an application layer around core:

1. It persists every session entry to an append-only JSONL tree.
2. A `CompactionEntry` stores a summary, `firstKeptEntryId`, `tokensBefore`, optional details, and its position in the tree.
3. Rebuilding context emits the newest summary first, then messages from `firstKeptEntryId`, then messages after the checkpoint. Raw earlier entries remain in the session file ([session projection](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/session-manager.ts#L310-L420)).
4. The default threshold is `contextTokens > contextWindow - reserveTokens`; defaults are `reserveTokens = 16,384` and `keepRecentTokens = 20,000` ([source](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/compaction/compaction.ts#L115-L221)).
5. It walks backward to retain a recent budget, never cuts at a tool-result entry, and can summarize the prefix of an exceptionally large single turn separately ([cut point](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/compaction/compaction.ts#L292-L448), [split-turn compaction](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/compaction/compaction.ts#L640-L839)).
6. Repeated compaction merges the previous summary with new history. Its coding-oriented prompt preserves goals, constraints, progress, decisions, next steps, critical context, and cumulative read/modified file lists.
7. Before summarization, it serializes messages as quoted transcript text, discards image bytes, and truncates each tool result to 2,000 characters ([serializer](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/compaction/utils.ts#L84-L170)).
8. It detects overflow with `isContextOverflow`, compacts, removes the error only from active model context, and automatically retries once. Ordinary transient errors use a separate bounded exponential retry path ([overflow flow](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/agent-session.ts#L1751-L2020), [retry flow](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/agent-session.ts#L2406-L2506)).

The coding agent also has an **extension** API, not a generic package plugin. Its `context` event is connected to core's `transformContext`; extensions receive a deep copy and can return a modified message array ([extension wiring](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/sdk.ts#L320-L376), [runner](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/extensions/runner.ts#L858-L888)). `session_before_compact` can cancel or replace the generated checkpoint, and `session_compact` observes the saved entry ([extension types](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/extensions/types.ts#L535-L549)). Those events exist only when using the coding-agent runtime.

The companion root exports selected compaction functions (`compact`, `generateSummary`, `calculateContextTokens`, `estimateTokens`, `findCutPoint`, and `shouldCompact`) and session types, but it does **not** root-export implementation pieces such as `prepareCompaction`, `estimateContextTokens`, `CompactionPreparation`, or the event-result types ([root exports](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/index.ts#L27-L49)). Its manifest advertises a `./hooks` subpath, while the tagged source contains no corresponding `src/core/hooks`; do not treat that subpath as the compaction extension API ([package exports](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/package.json#L12-L25)). The documented customization surface is `pi.on(...)` inside the coding-agent extension host.

Adopting the package would also introduce its session manager, settings, auth, tools, extension system, and CLI dependency graph. Its token heuristic is approximately characters/4 and assigns 1,200 tokens to images only in some message roles; it is not reliable enough for this image-heavy product ([estimator](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/src/core/compaction/compaction.ts#L228-L290)). Reimplement the small domain-neutral algorithms locally, with attribution, rather than making the coding-agent CLI the owner of application state.

## Current repository behavior and gaps

### Durable state today

- `agent_messages` durably stores only the product-level `{ role, text, references, createdAt }` form ([types](../../apps/web/lib/agent/types.ts#L2-L17), [service](../../apps/web/lib/agent/service.ts#L86-L91)). It does not store native Pi assistant content blocks, thinking, tool calls, tool results, usage, stop reasons, or provider response IDs.
- Tool calls and results are durable in `AgentTask.steps`, with call identity, replay rules, and recovery handling ([types](../../apps/web/lib/agent/types.ts#L26-L46), [execution](../../apps/web/lib/agent/service.ts#L177-L220)). This is authoritative application state and must never be replaced by an LLM summary, consistent with [ADR-0008](../adr/0008-platform-managed-background-agent.md) and [ADR-0009](../adr/0009-agent-canvas-history-and-conflicts.md).
- Each run loads all project messages, not only the current task, creates a fresh Pi `Agent`, converts both user and assistant product messages into Pi **user** messages, and prefixes past assistant text with `此前助手回复：` ([service](../../apps/web/lib/agent/service.ts#L223-L252), [runtime](../../apps/web/lib/agent/runtime.ts#L36-L67)). Previous native tool-call/result adjacency is therefore not reconstructed.
- The entire current task's `steps` and question are prepended as one JSON string on every run ([runtime](../../apps/web/lib/agent/runtime.ts#L63-L67)). That string can become the largest context item.
- Every historical reference is resolved again. Image-capable models receive resized JPEG bytes for every resolvable historical image; deleted nodes become text, and non-image models receive a limitation notice ([runtime](../../apps/web/lib/agent/runtime.ts#L36-L46), [reference resolution](../../apps/web/lib/agent/references.ts#L5-L41)). This is the most immediate context-growth and repeated-network-cost risk.
- The runtime has no `transformContext`, checkpoint, preflight budget, overflow recovery, or transient retry policy. An assistant error is thrown from the event subscriber and marks the application task failed ([runtime](../../apps/web/lib/agent/runtime.ts#L48-L68), [service failure](../../apps/web/lib/agent/service.ts#L264-L274)).
- Tracing already records per-call measured usage and scrubs image bytes/credentials ([tracing](../../apps/web/lib/agent/tracing.ts#L33-L45), [usage](../../apps/web/lib/agent/tracing.ts#L83-L110)). It does not record context selection, checkpoint, pruning, overflow, or retry decisions.

### Domain constraints

The architecture must preserve existing decisions:

- Agent steps and waiting state remain durable outside model context ([ADR-0008](../adr/0008-platform-managed-background-agent.md)).
- Context reconstruction cannot use an old canvas snapshot to overwrite unrelated current state ([ADR-0009](../adr/0009-agent-canvas-history-and-conflicts.md)).
- Skills remain progressively loaded rather than copied wholesale into every prompt ([ADR-0010](../adr/0010-progressively-loaded-creative-skills.md)).
- A summary is never evidence of edit permission, deletion intent, or generation approval; those remain authoritative task/question/scope records under [ADR-0011](../adr/0011-agent-preserves-existing-content.md).

`GLOSSARY.md` does not yet define “raw conversation”, “LLM context projection”, or “context checkpoint”. Before implementation hardens public/domain names, resolve those terms through the domain-modeling process.

## Recommended architecture

### 1. Separate immutable facts from replaceable projections

Use three conceptual layers:

| Layer | Purpose | Retention / authority |
| --- | --- | --- |
| Raw conversation ledger | Product messages, native model outcomes, tool call/result references, usage, errors, reference provenance | Append-only and authoritative for audit/recovery; never deleted by compaction |
| Application state | Tasks, steps, questions/approvals, generation batches, current canvas | Existing authoritative tables and services; always loaded directly, never inferred from summary |
| Derived LLM context | Checkpoint summary + recent raw entries + current authoritative state projection | Rebuildable, versioned, model-specific, safe to replace |

Do not mutate existing `agent_messages` in place. Add append-only context entries or companion columns/tables keyed by stable entry IDs. A practical checkpoint record needs at least:

```text
id, project_id, through_entry_id, first_kept_entry_id,
summary_text, summary_schema_version, prompt_version,
summary_model_id, source_digest, tokens_before,
created_at, status, failure_reason
```

Store ranges by entry identity, not row offsets. Persist source digests so a retry cannot attach a summary to a different raw prefix. Keep summary generation idempotent. Checkpoints are derived data: they may be regenerated or superseded without changing conversation history.

For native model/tool details, either add `agent_context_entries` with typed JSON payloads or add a dedicated append-only model-event table. Keep large tool payloads and media in their existing durable stores; context entries should reference them by step/call/asset ID and carry a compact textual projection.

### 2. Build one application-owned context assembler

Create a service boundary such as `AgentContextAssembler.build(projectId, taskId, model, policy)`. It should:

1. load the newest valid checkpoint;
2. load raw entries after its boundary and enough earlier recent entries to satisfy the keep budget;
3. load current task/question/approval facts from `AgentService` as a structured, bounded message;
4. project tool results according to per-tool policies;
5. decide which referenced images need pixels and which need metadata only;
6. return Pi `AgentMessage[]` plus a `ContextBuildReport` for tracing/tests.

Pass the assembled recent transcript as `initialState.messages` and use `agent.prompt()` only for the truly new user/continuation message, or continue using a prompt array but ensure messages are not duplicated. Add `transformContext` as a final, pure safety layer that can apply the same deterministic projection before every tool-loop model call. On error it must return the unmodified safe input and record a diagnostic; it must not throw.

Do not generate summaries inside `transformContext`: it can run before every tool turn, its contract forbids rejection, and durable writes there complicate retries. Generate/checkpoint before a run or after a completed turn under an application lease, then let the hook read the saved projection.

### 3. Prune tool results by semantics, not arbitrary age

Keep assistant tool calls and their result messages structurally paired. Never retain an orphaned tool result or a call whose required result was removed. Suggested projections:

- canvas reads: stable IDs, node types/names, selected relevant fields, version, and “N omitted”; do not repeat full canvas JSON after a newer read;
- create/edit/delete: operation ID, target IDs, changed fields, committed version, and failure/reconciliation status;
- generation: batch/task IDs, requested specification, provider state, saved artifact IDs/URLs, partial failures, and approval identity;
- errors: exact redacted error, attempted arguments, and whether retry/reconciliation remains allowed;
- verbose diagnostic output: head/tail plus byte/character count and a durable result reference.

Persist the full result first. The MCP adapter may then return a bounded result to Pi, or `afterToolCall` may replace content, but neither path may destroy the stored authoritative result. Give every projection a schema/version and per-tool maximum; avoid one global character truncation that could remove a required generated asset ID.

### 4. Use checkpoint summaries, not rolling destructive summaries

Adopt the strong parts of the companion design:

- trigger proactively at `measured_or_estimated_context > contextWindow - reserve`;
- keep a recent window and summarize only the prefix;
- cut at product/agent turn boundaries, never inside a tool call/result pair;
- if one turn alone exceeds the budget, separately summarize its prefix and keep the suffix;
- merge the previous checkpoint with newly summarized history;
- keep the full raw history.

Use a creative-domain summary schema rather than the coding-agent's file list:

```text
Goal and requested deliverables
Creative constraints and preferences
Confirmed decisions
Canvas changes already committed (node/operation IDs)
References and identity cues (asset IDs; no binary data)
Generation approvals and batches (authoritative IDs/status only)
Open questions / waiting state
Failed or uncertain operations requiring reconciliation
Next safe action
```

The summary prompt must state that quoted conversation/tool content is untrusted data and must not override system instructions. Validate the output shape and maximum length before saving. If summary creation fails, keep the prior checkpoint and build a smaller deterministic recent context; never mark raw history compacted without a valid saved checkpoint.

Choose reserve and keep budgets per model. Start with conservative ratios plus absolute caps (for example, reserve at least the model's configured output allowance and a safety margin), then tune using measured usage. Do not blindly copy 16,384/20,000 across Gemini and Ark models. Include system prompt and tool-definition overhead in the safety margin.

### 5. Treat images and references as assets, not transcript bytes

For raw history, persist immutable reference provenance: asset ID/version or content digest, original message ID, node ID/name/type snapshot, MIME type, and availability. Store media once in asset storage; do not duplicate base64 in checkpoints or trace payloads.

For derived context:

- always include compact reference metadata and user-provided identity/relationship text;
- include image pixels for the current message's explicit references by default;
- include older pixels only when still required for the current request or a tool explicitly asks for visual comparison;
- deduplicate identical assets by stable identity/digest;
- cap image count and total decoded pixels/bytes before provider serialization;
- replace omitted/deleted/unavailable images with explicit text placeholders and provenance;
- optionally persist a model-generated visual caption as derived metadata, with model/version/source digest, but never claim it is the original fact.

The summary model should receive textual metadata/captions, not historical image bytes. This avoids repeatedly downloading and resizing every old reference on every run.

### 6. Separate overflow recovery from transient retry

At each completed assistant message:

1. persist the raw outcome and usage;
2. if `isContextOverflow(message, model.contextWindow)` is true, do not use the ordinary retry budget;
3. create or advance one checkpoint, rebuild context, remove the overflow error only from the **derived retry input**, and retry once;
4. if overflow repeats, stop with a specific operator/user outcome rather than loop;
5. for rate limit, overload, connection, and 5xx failures, use a separate small exponential retry budget with abortable waits and idempotency checks;
6. never repeat a non-idempotent application tool merely because a provider call was retried—the existing persisted step reconciliation remains authoritative.

Persist retry attempt, reason, source run ID, checkpoint ID, and outcome. Honor task stop/lease loss during summary generation and backoff. A summary request should have its own retry budget and must not consume or duplicate a user-visible generation approval.

### 7. Add observability without exporting media or secrets

Extend the existing run/generation trace with scrubbed attributes or events:

- context policy/schema version;
- raw entry/message count and derived count;
- checkpoint ID and summarized-through/first-kept IDs (hashed if necessary);
- model context window, reserve, preflight estimate, last measured input/cache/total, and utilization ratio;
- characters/bytes removed per tool and the projection reason;
- references seen, images included, deduplicated, metadata-only, unavailable, and total resized bytes (never bytes themselves);
- compaction trigger (`threshold`, `overflow`, `manual/backfill`), duration, summary model, tokens, and failure;
- retry class/attempt/delay and whether the retry used a new checkpoint;
- fallback path when a transform/checkpoint fails.

Trace summary generation as its own model observation linked to the agent run. Preserve current `scrub()` behavior and do not attach raw tool payloads, complete summaries containing sensitive user content, credentials, or base64 merely for debugging.

## Staged delivery and migration

### Stage 0 — measurement only

- Add a read-only context-build report around the current history conversion.
- Record measured Pi usage already available in tracing, approximate serialized text/tool/reference sizes, image counts, and model windows.
- Run in shadow mode; do not change provider input.

This establishes real thresholds and identifies whether historical images, `task.steps`, or canvas results dominate.

### Stage 1 — deterministic projection

- Introduce the context assembler and per-tool compact result projectors.
- Send old references as metadata-only and current explicit references with pixels.
- Keep all raw database records unchanged.
- Feature-flag the derived input and compare shadow reports before rollout.

### Stage 2 — durable checkpoints

- Add append-only checkpoint/context-entry schema and idempotent migrations.
- Generate checkpoints between runs or after settled turns, using a versioned creative summary schema.
- Rebuild `summary + recent window + authoritative task state` and add `transformContext` as final safety projection.
- Lazy-create the first checkpoint for an old long conversation; no eager rewrite of existing messages is required.

### Stage 3 — recovery policy

- Add proactive thresholding, one compact-and-retry overflow recovery, and separate bounded transient retries.
- Fence all waits/model calls with the current task run ID, worker lease, and abort signal.
- Surface a specific context-recovery failure separately from platform-configuration failure.

### Stage 4 — migration hardening

- Normalize future inline image references to durable assets plus digests; optionally backfill oversized inline data in small batches with a recoverable migration.
- Add checkpoint supersession/backfill tooling and retention rules for derived data.
- Only after behavior is stable, evaluate the scope migration from `@mariozechner/*` to `@earendil-works/*` as a separate dependency change.

## Validation plan

Per [testing guidance](../agents/testing.md), documentation-only validation is sufficient for this research file. The eventual implementation should add:

### Unit tests

- projection is chronological and deterministic;
- a tool call and its results are kept/pruned as a valid group;
- latest explicit user message and current authoritative task/question facts always survive;
- a checkpoint covers exactly its source range/digest and repeated creation is idempotent;
- repeated checkpoints merge prior summary plus new prefix without losing active constraints;
- tool-specific projections retain operation, node, batch, artifact, error, and reconciliation IDs;
- transform failure returns a safe fallback and never rejects;
- estimator accounts for system/tool overhead and images conservatively;
- references deduplicate by asset/digest, current pixels remain, historical pixels become metadata, and deleted assets are explicit;
- no base64 or credential-like values enter checkpoint/tracing payloads;
- summary prompt injection inside old tool/user content is treated as quoted data.

### Service/runtime integration tests

- reopen the database and reconstruct the same derived context from raw history plus checkpoint;
- cross a small fake context threshold, checkpoint once, and continue with the correct recent window;
- simulate a Pi overflow assistant message, compact and retry exactly once, while retaining the raw error;
- repeated overflow stops; rate-limit/5xx follows the separate bounded retry path;
- summary failure retains the previous valid checkpoint and uses deterministic fallback;
- a stop or lost lease aborts summary/backoff and prevents a stale checkpoint from attaching;
- pending steering messages arriving during checkpoint/retry are neither lost nor duplicated;
- non-idempotent completed steps are not re-executed after context rebuild;
- measured usage, checkpoint/pruning/image/retry trace fields are emitted and media/credentials remain scrubbed.

Use Pi's controlled/faux event streams for these cases rather than real provider credentials. Extend the existing real-core runtime and tracing fixtures; browser coverage is needed only if checkpoint/retry state becomes visible or interactive.

## Version recommendation

Keep `pi-agent-core` and `pi-ai` pinned together at 0.73.1 during the first context-management stages. Do not add a floating `@mariozechner/pi-coding-agent` dependency merely to obtain compaction: its own dependency ranges are caret ranges and its runtime owns much more than this application needs. If selected algorithms are adapted, pin links/tests to the 0.73.1 commit and cover the exact behavior locally.

Treat migration to `@earendil-works/*` as a separate change. Upgrade the core and AI packages as one tested set; if the coding-agent package is ever used, align all three versions. Re-run type-level compatibility for `AgentOptions`, `AgentEvent`, `StreamFn`, `Usage`, `Model.contextWindow`, and `isContextOverflow`, plus the full runtime/tracing tests. The installed lockfile's deprecation notice and the 0.73.1 release's package-scope migration support are evidence to plan that move, not evidence that the new scope is API-identical at an arbitrary later version.

## Recommended decision

Proceed with an application-owned context assembler and append-only checkpoint table. First remove historical image bytes and bound tool/state projections; those changes address the largest known risks without lossy summarization. Then add versioned creative checkpoints and overflow recovery. Use Pi core's `transformContext`, usage events, model metadata, and overflow helper as integration seams—not as a presumed compaction plugin—and keep all permissions, task steps, generation approvals, and canvas truth outside derived model context.
