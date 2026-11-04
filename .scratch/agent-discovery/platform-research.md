# 创作 Agent 的编排与确认边界

研究日期：2026-11-04。研究笔记，非票。仅采用官方产品文档；未登录实测。文档展示的场景不能推广成全部产品路径，未写确认也不等于没有确认。Firefly AI Assistant 官方仍标注 beta，因此这里比较的是公开交互设计，不是成熟度或可靠性排名。

## 官方证据对比

| 平台 | 编排、上下文与连续创作 | 澄清与 HITL 的明确证据 | 证据边界 |
| --- | --- | --- | --- |
| FLORA / FAUNA | Agent 能选模型、建连节点、改已有工作流，选择节点或 @ 引用提供上下文；上传参考图可变为源节点；可执行图像、视频、文本节点，一次最多 50 个。[FAUNA 文档](https://docs.flora.ai/editor/fauna) | 默认 Assist 在任何生成前展示待运行节点及预计用量并要求批准；Auto 明确自动执行、不暂停审批。确认针对拟运行节点的成本。[FAUNA 文档](https://docs.flora.ai/editor/fauna) | 官方支持对话迭代，但没有给出统一的“信息缺多少必须追问”规则。Auto 是明确证据，不能因此把其他平台的快速模式也视作免确认。 |
| Lovart | 自动选图像/视频模型；自由提示与预设 Skills 并存；Skills 缺信息时会追问。编辑生成新资产，原图保留。[How Lovart Works](https://www.lovart.ai/docs/getting-started/how-lovart-works) 上传参考文件进入对话上下文。[Adding References](https://www.lovart.art/docs/how-to-prompt/adding-references) | 入门图像示例为发送提示后开始生成；该教程没有描述单独的生成审批。[Design Your First Project](https://www.lovart.art/docs/getting-started/design-your-first-project) | 不能由入门示例断言所有图像/视频都不需确认。Thinking/Fast 区分深度推理与快速多方案探索，并非官方声明的审批策略。[Chat Tools](https://www.lovart.ai/docs/how-to-prompt/chat-tools) |
| Adobe Firefly AI Assistant | 根据意图决定步骤和工具，自动选模型（用户指定除外），通过连续对话修改结果。Skills 可显式或隐式触发，用户也可要求不用 Skill。[FAQ](https://helpx.adobe.com/firefly/web/firefly-ai-assistant/ai-assistant-faq.html) | 品牌教程：修图前审阅计划/预设并确认；批量 mockup 先看 pilot，再 Continue 生成剩余；产品视频先审阅图像分析并回答格式/风格问题，然后生成片段。[Build a brand](https://helpx.adobe.com/firefly/web/firefly-ai-assistant/build-a-brand.html) | 这是具体品牌流程中的确认点，不能推广成所有操作都审批；也没有足够证据认定每个视频片段逐次审批。 |

“参考图理解”也要区分层次：Lovart/FLORA 文档明确支持引用及作为生成输入，但这些页面不足以证明其理解质量；Adobe 教程明确出现可由用户审阅的 image analysis，也不等于所有请求都必须先生成一份分析报告。

## 对 ai-flow 的设计建议（推断，非平台事实）

最小边界可以是：**自由准备 → 必要时澄清 → 审阅本批生成 → 执行 → 看结果继续**。不需要把分析参考图、选模型、写提示词、建节点各自做成必须确认的页面。

1. **准备阶段允许 Agent 自主编排。** 读取参考、梳理意图、选工具、组织依赖应形成可见且可改的草稿。FLORA 的编排能力与运行审批分离，是最直接的设计依据。
2. **澄清只解决会改变交付物的歧义。** 例如参考图是要保留商品身份还是只借用风格；不要为了补满固定表格，重复询问已经给出的信息。此规则是建议，三家资料没有公开统一算法。
3. **一次确认一个明确的执行批次。** 展示用哪张参考、生成什么、数量、关键规格与预计用量；允许修改后直接生成。批次可含多个节点，不应自动等同于每次工具调用各确认一次。
4. **复杂批量用样张作为可选决策点。** 大批同风格图片可先生成少量样张，用户选定后扩展；这是从 Adobe pilot/Continue 流程借鉴，不必套到“给我一张图”的任务。
5. **连续执行需要有范围的授权。** 若产品坚持图片/视频生成前 HITL，可以批准一个有数量和费用范围的批次，执行时沿用该批准；超出范围再确认。若未来支持自动模式，应显式选择，参考 FLORA Assist/Auto。预算上限和授权失效规则是 ai-flow 的建议，并非本次资料证实的 FLORA 实现。
6. **结果继续作为上下文。** 用户选一张说“按这个再做三张”即可形成下一批；保留原结果与派生关系，降低探索失败的代价。不要每一轮都重新走完整需求采集。

这些证据支持“交互边界可以少而明确”；它们没有证明“完全没有确认就是行业惯例”，也没有证明 Agent 的内部规划可以完全不受运行时约束。
