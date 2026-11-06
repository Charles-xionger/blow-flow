# 确定脚本节点与制作台的交互布局

Status: needs-triage

## Question

比较脚本节点的浮动控制台、右侧面板和专注编辑工作台，确定从参考内容、脚本生成与发布到制作台素材和分镜管理的布局。

## Primary source

- 原型分支：`prototype/script-desk`（从 `2d3af5f` 建立，与主工作区未提交改动隔离）。
- 原型目录：`components/canvas/script-prototype/`。
- 本地 worktree：`/Users/jiangxinbo/Documents/workspace/ai-flow-script-prototype`。
- 启动：在 worktree 中运行 `pnpm prototype:script`。
- 地址：<http://localhost:3218/canvas?prototype=script-desk&variant=A>，支持 `variant=B` 和 `variant=C`。
- 设计依据：`docs/adr/0012-production-desk-shares-canvas-content.md`（主工作区）。

## Demonstrated behavior

模拟流式生成、粒子动画、停止与上一版、编辑与发布文本、制作台分类、批量生图状态、单项设置、关联素材、分镜生成路径、差异确认、移除条目保留素材。底部切换布局，左下角可查看内存状态。

所有生成与差异都是固定示例，图片是 SVG 占位，视频是结果占位；无付费模型、项目写入或刷新恢复。画布节点位置固定，音频上传与初步观看不属于本轮原型。

## Verdict

用户已选择方案 A（画布＋下方浮动控制台），控制台布局参考用户提供的 LibTV 截图：宽幅深灰圆角面板、顶部参考素材缩略卡、中央大输入区、左下模型选择、右下发送图标，任务和指令采用紧凑入口。B/C 留在原型分支作为对比来源，默认隐藏对比栏；原型未合入生产代码。后续实现须重写为正式组件并落实后台任务、数据同步、素材存储与真实生成能力。
