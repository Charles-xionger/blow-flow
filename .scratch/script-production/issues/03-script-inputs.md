# 03：参考输入与创作任务预设

Status: resolved

**What to build:** 用户将文本或图片连接到脚本节点，选择创作任务并调整指令；可在生成前确认全部参考并得到明确的输入校验。

**Blocked by:** [02：真实脚本后台生成与流式展示](02-script-streaming.md)

## Acceptance criteria

- [x] 提供自由创作、生成剧本、生成分镜和提取角色／场景／道具的任务预设；素材提取首阶段只生成文本。
- [x] 任务指令可编辑，任务与语言模型独立选择；最终生效的指令进入本次输入快照。
- [x] 上游文本和图片在控制台显示带编号的参考卡，支持节点引用，默认所有连入参考参与生成。
- [x] 生成前固定参考文本内容、图片原始素材身份和顺序；后续上游修改不改变本次输入，只提示参考已更新。
- [x] 视觉能力来自模型配置；不支持图片或参考不可读取时阻止调用并指出具体问题，不静默省略参考。
- [x] 未配置平台密钥或模型不可用时明确提示，不暴露凭据，不自动换模型。
- [x] 控制台展开、长文本编辑和视口边缘布局可用，拖动行为遵循现有节点约定。
- [x] 可以演示文本创意生成剧本，以及图片参考传给支持视觉的模型；单纯完善模型目录不算完成。

## Implementation context

复用既有提示词分段、节点引用和上游内容展开规则。后台任务只消费已固定的输入，不能在执行中重新读取不断变化的画布。

## Validation boundary

以公开服务行为和真实画布交互作为验收边界，遵循规格的 Testing Decisions。沿用用户“不运行测试”的要求，本任务清单不授权执行自动测试或真实付费模型联调。类型、lint 与静态检查可用于实施反馈；未执行项必须如实报告。

## Source

[第一阶段规格](../spec.md)；[任务总览](../tickets.md)。

## Answer

Implemented four editable task presets, independent model selection, numbered reference cards, @ node references, expanded input editing and viewport bounds. New requests freeze all connected expanded text, original image identities/order and effective instructions after autosave; pending retries retain the original snapshot. Later upstream edits show a reference-change notice.

The task service validates model configuration and explicit vision capability; the worker reads and decodes every original image before calling the shared text stream. Reference-specific failures block provider submission without dropping images or selecting another model. Images use the existing configured OSS reference boundary and are embedded from validated bytes for both Ark and Gemini.

Validation: TypeScript and affected-code ESLint checks; automated tests, browser interaction and paid-provider demonstrations intentionally not run under the user's restriction. The implemented demonstration path still requires configured credentials and manual end-to-end validation.
