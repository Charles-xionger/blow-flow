# ComfyArt Agent 本地源码调查

调查日期：2026-11-04。本地目录 `/Users/jiangxinbo/Documents/github/comfyArt`，HEAD `13396a8`。以下为静态源码结论，未运行应用或调用生成模型。

## 已有能力

- 自由工具编排：系统指令提供看画布、列模型、生成与编辑素材、等待生成、布局、技能和提问等工具，并要求多步任务维护计划，不规定剧本到分镜的固定流程。[源码](</Users/jiangxinbo/Documents/github/comfyArt/bot/guide.py>)
- 参考上下文：发送选中素材、上传素材、参考画框及品牌素材；工具可以读取画布真实像素。可把图片提供给模型理解，但不能据此保证识别准确。[发送入口](</Users/jiangxinbo/Documents/github/comfyArt/src/agent.ts>)、[画布工具](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp_tools/canvas.py>)
- 需求提问：`ask_user` 支持选项和自由文本，问题消息保存到聊天记录，等待用户回答。[实现](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp_tools/bot_tools.py:52>)
- 执行确认：聊天支持 `auto`/`ask`，新聊天默认 `auto`；`ask` 模式下，带 approval 的生成工具在执行前展示运行、总是运行、取消。它与主动澄清工具分开实现。[默认模式](</Users/jiangxinbo/Documents/github/comfyArt/api/chat_store.py:51>)、[确认入口](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp_tools/bot_tools.py:70>)
- 参数：工具公开 JSON inputSchema；浏览器生成处理器额外检查模型、参考图能力、参考模式、比例等，部分参数采用默认值或裁剪。MCP 分发入口未见统一 JSON Schema 运行时校验，不能把公开 schema 等同于完整校验。[定义](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp_tools/canvas.py>)、[分发](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp.py:66>)、[执行](</Users/jiangxinbo/Documents/github/comfyArt/src/botCommands.ts:108>)
- 连续生成：生成立即返回 ID，`wait_generation` 等待结果并返回素材 URL 与形状 ID，供后续工具使用。[实现](</Users/jiangxinbo/Documents/github/comfyArt/src/botCommands.ts>)

## 与 ai-flow 目标的差距

- 画布工具由打开的浏览器标签页执行，没有标签页会超时；不能直接满足 ADR-0008 的关闭页面继续执行。[协议说明](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp.py:17>)
- 等待问题的 Future、待处理问题和已回答运行批准存在进程内字典；聊天消息持久化不能证明等待状态支持进程重启恢复。[状态](</Users/jiangxinbo/Documents/github/comfyArt/api/bot_asks.py:12>)
- 运行确认显示动作与最多 80 字符的提示词；超时后批准匹配使用聊天 ID 与动作文案，而不是完整参数快照。可以借鉴轻交互，但不能声称它严格绑定了所有生成参数。[确认调用](</Users/jiangxinbo/Documents/github/comfyArt/api/mcp_tools/canvas.py:23>)、[批准匹配](</Users/jiangxinbo/Documents/github/comfyArt/api/bot_asks.py:83>)
- 已接多种 CLI Agent 和本地兼容接口，此调查未发现采用 Pi 内核。[官方仓库内指南](</Users/jiangxinbo/Documents/github/comfyArt/docs-site/zh/guides/agent.mdx>)

## 对 ai-flow 的建议（尚未确认）

保持 Agent 自由组合工具：先理解用户给的文字、图片及画布，再仅对关键歧义提问。采用通用提问与轻量执行确认，不强制所有任务经过角色表、分镜表或参数编辑器。确认绑定实际调用参数、后台步骤持久化、结果写回与冲突保护由应用实现。是否允许一次确认一组明确生成任务，仍需用户决定。
