# 11: 删除旧外壳和旧面板

**What to build:** 所有节点迁移完成后，移除旧外壳、旧控制面板、不再使用的共享组件、图片悬浮操作按钮和只为字符串提示词存在的路径。分组继续保持现有形式。用户可见的行为不变，只留下一条通用路径。

**Blocked by:** 04, 05, 06, 07, 08, 09, 10

**Status:** ready-for-agent

- [x] 旧外壳和不再使用的面板、样式、组件已删除，没有任何节点引用它们
- [x] 读取旧字符串提示词时转为单个文本段的行为仍然保留
- [x] 分组外观和行为不变
- [x] 类型检查和 lint 通过
- [x] `pnpm test` 和 `pnpm test:browser` 全量通过
- [x] 在真实画布上手动走通：连接素材、`@` 引用、运行、断线、保存后重新打开

## Comments

- 删除：`BaseNodeWrapper`、`ImageGenerationPanel`、`MediaPreview`、`NodeInput`、`NodeSelect`、`components/ui/textarea`、图片悬浮操作组件 `ImageWithActions`，以及 `BaseNode` 里拖动时隐藏旧面板的样式、`ImageGeneration.module.css` 里只给旧面板用的规则。
- 改名：`VideoGenerationPanel` → `TaskVideoNode`（图生视频走生成任务模型时的节点）；`components/ui/image-with-actions` → `components/ui/media-actions`（只剩预览、保存为角色对话框和下载）。
- “AI 生成提示词”写入提示词时改为分段结构。读取旧字符串仍由 `promptSegments` 转为单个文本段，已有测试覆盖。
- 手动走查（独立测试服务器、真实浏览器、不拦截请求）：拖线连接角色和文本节点 → 自动插入文本引用 → `@` 引用图片1 → 运行发送“黄昏的花园，参考图片1”和 1 张图（测试服务器没有模型配置，接口返回 404，错误显示在节点控制台）→ 从连接层断开文本节点，引用变成“@场景” → 重新打开后内容和连线不变。
- `components/ui/loading.tsx` 早已没有引用，但不属于节点外壳，本票没有删除。
