# ComfyArt 画布实现调研

调研日期：2026-10-30。调研对象：本地 `/Users/jiangxinbo/Documents/github/ComfyArt`，Git HEAD 为 `13396a8`。项目声明版本为 1.1.0，画布依赖声明为 `tldraw ^5.5.2`，本地检查的 tldraw 源码版本为 5.5.2。

本次只读分析 ComfyArt 应用源码与本地依赖源码，未修改 ComfyArt，未启动浏览器、录制性能或执行大规模节点基准。因此下文说明的是代码机制，不能据此认定其达到特定 FPS、节点规模或内存上限。未发现适用于该项目的 AGENTS.md。

文中的 ComfyArt 应用链接相对本文件使用 `../../../github/ComfyArt/`，已核对其解析结果。源码行号以此次本地版本为准。

## 1. 结论及适用范围

ComfyArt 使用 tldraw 编辑器作为画布引擎，应用通过 Editor API 操作图形记录。它偏向图片、视频、文本、画板等创作白板；ai-flow 当前是 React Flow 驱动的节点连线工作流，两者交互模型不同。

最值得 ai-flow 迁移的机制是：

1. 区分文档数据、相机/选区等会话状态、任务进度与聊天状态。
2. 文档变更经过防抖才生成完整快照并保存，不让平移缩放触发文档保存。
3. 将图形外壳的几何更新与复杂内容渲染隔离，同时持续维护引擎中的实时坐标。
4. 按显示尺寸选择图片缩略图；视频采用封面、延迟加载和按需播放。
5. 批量操作通过统一编辑器接口执行，正确处理父子坐标、历史记录和依赖关系。

没有证据支持直接将 ComfyArt 描述为“CRDT 分块画布”“Agent 只输出拓扑”“流式更新不触发 React”或“仅挂载固定数量节点”。不建议为了模仿它立即更换 ai-flow 的画布库。

## 2. 应用架构和状态来源

依赖见 [package.json](../../../github/ComfyArt/package.json)，画布入口见 [App.tsx](../../../github/ComfyArt/src/App.tsx) 第 251 行。

```text
React 应用与工具面板
        │
        ├── useValue / atom：主题、面板、进度、聊天等派生状态
        │
        └── Editor API：创建、修改、选中、分组、布局
                │
                └── tldraw Store：图形、素材、绑定、文档和会话记录
                        ├── 画布引擎：交互、几何、空间索引、渲染
                        └── document 变更监听：防抖保存完整快照
```

- `src/App.tsx:94` 将 `shapeUtils`、工具列表等定义为模块级常量；组件映射也在组件外定义。
- `src/App.tsx:151` 通过 `onMount` 取得 Editor，注册画板及裁剪规则。
- `src/App.tsx:169` 加载项目，随后用 `loadSnapshot(editor.store, snap)` 恢复数据。
- `src/App.tsx:192` 启动自动保存。
- [GeneratorShape.tsx](../../../github/ComfyArt/src/shapes/GeneratorShape.tsx) 第 47 行通过 `BaseBoxShapeUtil` 定义自定义生成图形，包含属性校验、默认值、版本迁移、指示轮廓和内容组件。
- 同文件第 94 行按 job ID 从独立的 `progressAtom` 派生进度，第 96 行读取执行实例信息。进度更新无需每次改写整份画布文档。

这是一套由编辑器记录和细粒度响应状态共同支撑的结构，没有再用一个 React 状态数组包裹完整画布并在顶层订阅所有变化。

## 3. 拖拽、缩放与渲染隔离

### 3.1 高频交互仍实时更新引擎状态

ComfyArt 应用未自行实现节点拖拽，而是交给 tldraw 工具状态机。检查本地 tldraw 包的 `src/lib/tools/SelectTool/childStates/Translating.ts`：

- 第 128 行：`onPointerMove()` 调用 `updateShapes()`。
- 第 663 行：位置计算最终调用 `editor.updateShapes(...)`。

所以其行为不是“只移动 DOM，松手后才更新数据”。拖动过程中，编辑器状态持续维护最新位置，供几何、绑定、选区和分组逻辑使用。

### 3.2 外壳变换与业务内容分开处理

本地 `@tldraw/editor` 的实现：

| 文件与行号 | 机制 |
| --- | --- |
| `src/lib/components/default-components/DefaultCanvas.tsx:95` | `useQuickReactor` 响应相机变化，直接更新画布层 transform |
| `src/lib/components/Shape.tsx:65` | 响应式读取图形几何和尺寸，更新外壳样式 |
| `src/lib/components/Shape.tsx:81` | 从 Editor 读取页面坐标变换，再设置 DOM transform |
| `src/lib/components/Shape.tsx:248` | `InnerShape` 独立 memo，并通过状态跟踪读取业务内容依赖 |
| `src/lib/utils/areShapesContentEqual.ts:9` | 内容比较关注 props/meta 的引用，不将坐标变化视为内容变化 |

这里直接修改 DOM 是编辑器内部的渲染优化，状态与渲染由同一套引擎协调。ai-flow 不应在 React Flow 管理的外壳上另建一套绕过引擎的位置更新路径，否则连线、Handle、框选和分组可能使用旧坐标。

建议将设计原则表述为：**交互期间持续维护引擎几何一致性；无关节点及复杂业务内容不随位置变化更新；持久化与历史提交按操作边界合并。**

### 3.3 交互期间减少浮动 UI 工作

[selection.ts](../../../github/ComfyArt/src/ui/selection.ts) 第 8 行的 `useSelectionRect()` 只订阅选区相关派生状态，第 11 行在裁剪、缩放和拖动状态下返回空值，不展示依赖选区矩形的浮动工具栏。第 20 行的 `useOnlySelected()` 仅派生当前唯一选中且类型匹配的图形。

ai-flow 可以借鉴：拖动时暂停非必要浮层，工具栏订阅选中节点或选区摘要，避免订阅整个节点列表。

## 4. 持久化与多标签页保护

### 4.1 文档变更防抖保存

主要实现见 [autosave.ts](../../../github/ComfyArt/src/autosave.ts)。

| 行号 | 行为 |
| --- | --- |
| 9 | 保存延迟为 800ms |
| 11 | 独立维护 saved / pending / saving / error 状态 |
| 25 | 等待正在执行的保存请求结束 |
| 27 | 保存时才取得完整快照并提交 |
| 37 | 根据距离最后一次修改的时间继续等待或保存 |
| 42 | 监听 Store，范围限定为 document |
| 47 | 有未保存内容时通过 beforeunload 提示离开风险 |

相机属于 session scope，见本地 `@tldraw/tlschema/src/records/TLCamera.ts:176`。因此纯相机平移和缩放不会触发上述 document 监听。文档保存时的快照仍可以包含会话信息；“不触发保存”与“快照是否包含会话数据”是两回事。

### 4.2 仍然是全量快照保存

[projects.ts](../../../github/ComfyArt/src/projects.ts) 第 13 行对请求体进行 `JSON.stringify`，第 25 行向后端 PUT 完整 snapshot。[project_store.py](../../../github/ComfyArt/api/project_store.py) 第 45 行的保存逻辑将 snapshot 整体写入数据库，第 105 行保存历史版本。

这说明全量快照可以先通过降低频率避免进入交互热路径；是否改为增量保存，应由后续规模和实测决定。

### 4.3 保护范围和迁移注意事项

[App.tsx](../../../github/ComfyArt/src/App.tsx) 第 192 行向自动保存提供 `canSave`，第 203 行创建 BroadcastChannel，第 205 行收到同项目其他标签页的保存消息后标记当前页面 stale。

这是同浏览器标签页之间避免旧页面继续覆盖的保护，不是多设备实时协作或服务端并发控制。

迁移到 ai-flow 时还应补齐：

- 保存时记录 revision/dirtyVersion，旧快照保存成功后不能把更新的编辑标记为已保存。
- 按项目隔离保存队列，避免切换项目后异步回调更新错误的状态。
- 明确失败重试、手动 flush、关闭或崩溃时的可恢复边界。
- 防抖存在未持久化窗口，beforeunload 不能保证崩溃恢复，不能承诺零丢失。

## 5. 空间索引、裁剪及媒体资源分级

### 5.1 裁剪属于 tldraw 内核能力

本地 `@tldraw/editor/src/lib/editor/Editor.ts:397` 初始化 `SpatialIndexManager`。对应管理器的 `src/lib/editor/managers/SpatialIndexManager/SpatialIndexManager.ts:14` 引入 RBush，第 61 行开始通过 shape/binding 变更历史维护索引。

索引更新会考虑受影响图形的祖先、后代及绑定伙伴，避免只更新直接发生变更的图形而遗漏派生边界。源码也注明：若自定义几何读取了父子关系和绑定以外的其他图形，则这种额外依赖不在默认传播范围内。

`Editor.ts:5780` 的 `getCulledShapes()` 排除编辑中和选中的图形，并在集合内容未变时复用引用。

`DefaultCanvas.tsx:240` 使用集中式裁剪控制器；`src/lib/hooks/useShapeCulling.tsx:63` 更新已注册图形容器的 `display`。这条路径是可见性裁剪，并不能解读为只把固定数量记录传给编辑器或保证所有离屏 DOM 都卸载。

因此，ai-flow 若以后自建虚拟化，应分别定义“完整业务数据”“引擎所需几何/绑定数据”“实际可见内容”，并保留选中、编辑、拖动及依赖节点。不能简单截取前 100 个可见节点。

### 5.2 图片按显示尺寸选择资源

[App.tsx](../../../github/ComfyArt/src/App.tsx) 第 119 行定义素材服务，第 124 行的 resolver 根据缩放层级与 DPR 选择资源：

- 需要原图、非图片或缺失地址时使用原地址。
- SVG 根据显示尺寸栅格化。
- 普通非动画图片根据显示尺寸选择服务端缩略图。

这种资源分级直接减少图片解码和显存压力，比仅缩小 CSS 展示尺寸更完整。ai-flow 迁移时需明确缩略图生成、缓存、失败回退和导出原图路径。

### 5.3 视频按需播放

[VideoShape.tsx](../../../github/ComfyArt/src/shapes/VideoShape.tsx)：

- 第 16 行派生当前图形是否悬停。
- 第 17 行根据显示尺寸选择封面大小。
- 第 19–26 行仅在悬停或编辑时播放，其他时候暂停。
- 第 38 行使用封面，第 45 行设置 `preload="none"`。

这是 ai-flow 视频节点可优先采用的方案。当前证据不支持声称 ComfyArt 实现了统一的 `zoom < 0.3` 业务内容卸载规则。

## 6. 分组、布局和 Agent 接口

### 6.1 父子关系与布局批处理

[botLayout.ts](../../../github/ComfyArt/src/botLayout.ts) 第 166 行创建 frame，第 172 行通过 `reparentShapes` 设置子图形。第 183 行更新位置前使用 `getPointInParentSpace`，将页面坐标转换到父图形坐标。

[FrameToolbar.tsx](../../../github/ComfyArt/src/ui/FrameToolbar.tsx) 第 48 行实现画板内换行/网格排版；第 88 行注册规则，把需要重排的 frame 放入 Set，第 108 行通过 `queueMicrotask` 合并，第 93 行在 `editor.run(..., { history: 'ignore' })` 中执行。

这是基于 Editor 几何能力的本地布局。已检查的实现没有采用 Worker 或 ELK，也不能作为零 DOM 依赖无头布局内核的直接示例。

ai-flow 可迁移批量通知和坐标转换的思想，但必须为用户的一次操作、自动布局结果和撤销恢复明确历史边界。

### 6.2 Agent 通过命令处理器操作编辑器

[botLayout.ts](../../../github/ComfyArt/src/botLayout.ts) 第 88 行定义布局工具处理器，第 175 行的 `update_shapes` 使用 `editor.run` 合并批量更新。参数会转换成 Editor API 操作，而不是由模型直接操纵页面 DOM。

ComfyArt 允许 Agent 使用坐标：

- 第 40 行的 `describe()` 返回 x/y/width/height。
- 第 140 行的 `add_text` 和第 151 行的 `add_shape` 接受坐标。
- 第 24 行设定 `get_canvas` 的结果数量上限，第 99 行用 truncated 标记上下文截断；这只限制 Agent 上下文，不限制画布可见节点数量。

ai-flow 可以选择语义化拓扑接口，但应将其视为自身产品设计，而非 ComfyArt 已经证明的限制。接口仍需补齐节点类型、源/目标 Handle、批量引用、幂等、版本冲突及回滚语义。

### 6.3 流式输出有独立状态，但仍使用 React

[bot.ts](../../../github/ComfyArt/src/bot.ts) 第 218 行通过 `patchMessages` 更新聊天 Atom，第 255 行把流式文本追加到对应消息。[AgentPanel.tsx](../../../github/ComfyArt/src/ui/AgentPanel.tsx) 第 98 行用 `useValue(messagesAtom)` 订阅。

这里的隔离点是聊天状态不需要不断改写画布文档，并不是使用 DOM innerText 禁止所有 React 更新。ai-flow 的设计目标应是限制更新范围和合并更新频率，而非禁止必要的内容渲染。

## 7. 对 ai-flow 方案的建议

| 优先级 | 建议 | 验证重点 |
| --- | --- | --- |
| P0 | 分离文档、会话和任务状态，移除平移缩放时的全量持久化 | 连续平移不触发文档序列化；保存状态准确 |
| P0 | 缩小 Store 订阅范围，节点内容与位置更新隔离 | 拖动单节点时无关业务内容不更新；连线同步正确 |
| P1 | 图片分级缩略图、视频按需播放和延迟加载 | 解码、网络、内存及画面清晰度 |
| P1 | 交互中隐藏非必要浮动面板 | 输入焦点与操作恢复正确 |
| P2 | 统一命令入口，批量事务及父子坐标转换 | 批量失败、撤销、分组、项目切换 |
| 按需 | 空间索引与自定义裁剪 | 先实测现有引擎能力，再处理绑定和父子依赖 |
| 按需 | 增量持久化、多端协作 | 先定义同步协议及冲突规则，不以引入 CRDT 替代设计 |

推荐先保留 React Flow，验证现有数据规模下的优化收益。若未来确需替换引擎，应单独比较工作流连线语义、节点交互、素材能力、存储迁移和维护成本。ComfyArt 的实现不能代替 ai-flow 自身的性能录制与真实场景验收。

## 8. 依赖源码定位

下列路径是本次实际检查的本地依赖源码。它们属于安装产物，重新安装后路径可能变化，可按包名和文件名重新定位。

```text
ComfyArt/node_modules/.pnpm/
  @tldraw+editor@5.5.2_@floating-ui+dom@1.8.0_@types+react-dom@19.3.0_@types+react@19.3.0_cc00d92fe4d7163ec59f3088a2fb6abf/
    node_modules/@tldraw/editor/
      src/lib/components/Shape.tsx
      src/lib/components/default-components/DefaultCanvas.tsx
      src/lib/hooks/useShapeCulling.tsx
      src/lib/utils/areShapesContentEqual.ts
      src/lib/editor/Editor.ts
      src/lib/editor/managers/SpatialIndexManager/SpatialIndexManager.ts

其余文件可在 node_modules/.pnpm 中按以下后缀定位：
  node_modules/tldraw/src/lib/tools/SelectTool/childStates/Translating.ts
  node_modules/@tldraw/tlschema/src/records/TLCamera.ts
```
