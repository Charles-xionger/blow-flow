# 画布 undo/redo 方案调研

调研日期：2026-11-03。状态：**提案，尚未选型**。仅比较一手文档所确认的能力，未做性能基准或集成验证。

## 已确定的边界

[ADR 0009](../adr/0009-agent-canvas-history-and-conflicts.md) 已确定先做人工画布 undo/redo 与操作记录，再接入创作助手（Agent）的 MCP；一次拖动、一次连续文字编辑、Agent 一次完整创作步骤分别构成撤销单位，批次内部仍逐条记录，每步状态持久化。后台结果与人工编辑冲突时由用户裁决。下面的库选择和存储建议没有改变这些决定。

## 候选方案

| 候选 | 官方确认的能力 | 本项目适用性与边界（评估） |
| --- | --- | --- |
| React Flow `useUndoRedo` 示例 | 官方展示节点、连线编辑的快照式 past/future 历史及快捷键，示例标注 xyflow Pro License。[官方示例](https://reactflow.dev/examples/interaction/undo-redo) | 可参考画布事件接入和交互；不能把示例视作已提供服务端持久日志、冲突处理和素材保留的产品。未取得或审查 Pro 源码。 |
| zundo `temporal` | Zustand 中间件；支持 `partialize`、`equality`、`diff`、历史长度限制、暂停/恢复、初始化 past/future 和 `wrapTemporal`。`handleSet` 可合并短时间内的变化。[维护者 README](https://github.com/charkour/zundo) | 现有 Zustand 的最短接入路线，适合原型或有界本地编辑历史。分组、服务端原子提交、版本冲突与操作身份仍由应用实现。不能把 debounce 当作可靠的创作步骤边界。 |
| Immer patches | `produceWithPatches` 返回新状态、正向和逆向 patches，`applyPatches` 用于应用；官方保证相同基底上的结果正确，不保证 patch 最小化。[官方文档](https://immerjs.github.io/immer/patches/) | 更适合作为应用自有持久操作记录的差异生成器；它不是完整 undo 产品，队列、分组、redo、持久化和冲突检查仍需实现。数组索引路径遇到并发插删时尤其不应直接重放。 |
| Yjs `UndoManager` | 基于共享类型的选择性撤销；支持 `trackedOrigins`、捕获时间窗、`stopCapturing()` 和栈项元数据。[官方文档](https://docs.yjs.dev/api/undo-manager) | 适合明确需要多人实时协同的后续阶段。需迁移画布权威数据模型；自动合并不能代替 ADR 0009 的人工裁决。不能仅因未来存在 Agent 就引入 CRDT。 |

## 编辑历史不等于持久操作记录

zundo 的源代码在撤销时恢复已保存状态，新编辑时清空 future 栈；其 `onSave` 在捕获新历史时调用，undo/redo 路径没有调用该回调。因此只给 `onSave` 加数据库写入，不会自动得到完整审计日志。[实现源码](https://github.com/charkour/zundo/blob/main/src/temporal.ts)

Yjs 的 `y-indexeddb` 保存、恢复文档更新。[离线持久化文档](https://docs.yjs.dev/getting-started/allowing-offline-editing) 这与恢复 UndoManager 栈、Agent 步骤状态、用户冲突裁决记录是不同要求；以上文档没有承诺自动完成后三者，不能将文档恢复等同于历史恢复。

**应用层建议，尚未决定：** 将项目当前状态、可撤销批次以及持久操作记录区分建模。每条记录保存项目 ID、操作 ID、操作者、批次/步骤 ID、基准版本、变更范围、正逆差异或必要快照、提交结果和时间；Agent 步骤另存执行状态及关联生成任务 ID。持久提交需将画布变更与操作记录一起提交，操作 ID 支持重试去重。刷新恢复时同时核对版本、历史位置和未完成步骤，不能仅恢复 Zustand 内存对象。

## 必须由应用定义的语义

以下是从现有 ADR 推导的设计建议，而非上述库的保证：

- **操作边界：** 拖动开始/结束明确捕获一次；连续文字编辑在失焦、切换目标或明确提交时收束；Agent 完整步骤绑定批次 ID。选择状态、测量信息、预览加载状态与后台轮询不应进入可撤销创作内容。
- **冲突：** 提交及撤销前校验受影响节点/字段的预期版本或值；不相交变更可保留，相同内容已改动则暂停并记录用户裁决，禁止整张旧快照覆盖新编辑。依赖冲突部分的后续步骤如何暂停和恢复仍需设计，遵循 [ADR 0009](../adr/0009-agent-canvas-history-and-conflicts.md)。
- **生成副作用：** 撤销画布引用不应隐式撤销付费生成；redo 建议重新应用已有结果引用，不重新提交生成。尚未提交和已提交任务分别按 [ADR 0002](../adr/0002-persistent-generation-tasks.md) 处理，迟到结果不能复活已删除节点。
- **素材：** 历史保存稳定的原始素材身份与版本引用，不内嵌大文件、临时平台 URL 或画布预览图。只要可撤销历史或生成任务仍引用素材，就需要明确的保留策略；期限、清理条件、缺失素材时行为尚待决定。预览图可重建，不能替代原素材，遵循 [ADR 0006](../adr/0006-canvas-preview-cache.md)。
- **结构完整性：** 删除节点及关联连线、节点引用转普通文本应纳入同一撤销单位；恢复需验证提示词分段与节点身份，遵循 [ADR 0005](../adr/0005-prompt-segments.md)。永久删除后的最小项目删除标识必须保持，undo 不能绕开 [ADR 0004](../adr/0004-project-trash-tombstones.md)。

## 建议推进顺序

建议优先验证 **统一编辑入口 + 应用持久操作记录 + Immer 正逆 patches**。理由是本项目已经要求跨刷新步骤状态与人工冲突裁决，单纯快照栈无法覆盖主要边界。若先做低成本交互验证，可用 zundo，但应放在同一编辑入口之后；不要让 zundo 与持久记录各自决定历史顺序。该选择仍是提案，需通过小范围实现确认成本。

先验证拖动合并、连续文字编辑、删除带连线/节点引用的节点、撤销后新编辑使 redo 失效、刷新恢复历史、并发改同字段的拒绝覆盖、媒体引用恢复和后台结果迟到。通过后再让 Agent MCP 调用同一入口；持久步骤状态不能留到 MCP 接入后补做。当前没有足够证据建议直接迁移 Yjs。
