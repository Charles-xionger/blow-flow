This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
pnpm dev:all
```

同时启动 Web、生成 worker（RunningHub 图片/视频）和助手 worker（规划并写画布），输出带进程前缀；任一进程退出则全部停止。只启动 `pnpm dev` 时，生成与助手任务会停在队列，界面上表现为发送后没有反应。

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

也可以在三个终端分别运行 `pnpm dev`、`pnpm generation:worker` 与 `pnpm agent:worker`。Web 和 worker 需从同一项目目录启动，使用相同的 `.env.local` 和数据库。配置 key 后需重启 worker。完整配置与恢复说明见 [Krea2 生成任务与恢复](docs/KREA2_GENERATION.md)。

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## 画布保存与测试

测试选择、最终回归时机和源码变更检测见 [测试约定](docs/agents/testing.md)。

画布编辑约 500ms 合并一次，先在 IndexedDB `ai-flow-canvas` 提交草稿和待同步请求，再通过 `/api/workflow` 写入 SQLite。顶部“已同步”表示当前修改已经获得服务端确认；本地写入失败时不会绕过本地存储直接上传。保存按钮和 Ctrl/Cmd+S 使用同一链路。

保存协议要求 `id`、`requestId`、`baseVersion` 和完整 `snapshot: { name, nodes, edges, viewport }`。新画布预期版本为 0；读取和列表返回 `version`，更新使用该版本。同请求重放不会重复递增版本；版本冲突返回 409，无版本写入返回 400。历史 SQLite 画布自动初始化为版本 1。

本轮实现任务 01 的在线保存基础。旧 `canvas-storage` 原文保留但尚未自动导入（任务 03）；刷新后的自动重试、完整冲突与删除保护、本地故障恢复入口分别由后续任务补齐。已有待同步草稿可恢复，并可点击保存再次尝试同步。

```bash
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

浏览器测试使用独立浏览器上下文、3217 端口、`.next-canvas-test` 构建目录及临时 SQLite，拒绝复用已运行的服务，不写入 `data/canvas.db`。覆盖真实编辑、IndexedDB、HTTP API、服务端读回和本地事务失败；快速测试另外覆盖版本冲突、幂等、SQL 回滚和合并时机。

## 创作助手后台服务

管理员配置 `GEMINI_API_KEY`，并在运行 Web 服务之外启动 `pnpm agent:worker`。两者必须使用同一个 `DATABASE_PATH`；关闭浏览器不会停止 worker。每项目同时一个任务，worker 最多并行处理八个项目。不要将 worker 放在请求结束即销毁的 serverless 生命周期内。

可用 `AGENT_CONFIG_PATH` 指向管理员维护的 JSON：

```json
{"models":[{"id":"gemini-flash","name":"Gemini Flash","modelId":"gemini-flash-latest","apiKeyEnv":"GEMINI_API_KEY"}]}
```

`baseUrl` 为可选的平台入口；密钥只通过服务端环境变量读取。客户端目录仅包含模型名称、ID 和是否已配置。用户在画布右侧“创作助手”发送消息、引用选中节点或上传 PNG/JPEG/WebP 参考图。问题可用选项或文本回答/修改，也可停止任务；等待不会超时变成同意。消息、工具身份与结果、问题和状态保存到 SQLite。引用项目图片仅从已有 OSS 源或内嵌图片读取，并转换为模型可理解的图像内容。

当前集成固定使用 `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 0.73.1、MCP SDK 1.32.2 和 TypeBox 0.34.52。Pi 上游已迁移到 [earendil-works/pi](https://github.com/earendil-works/pi/tree/main/packages/agent)，因此旧 scope 被标记 deprecated；此版本按实际安装的 README、类型和真实 Agent 循环验证，未来升级需重新验证 API。MCP 使用 SDK 的 `InMemoryTransport` 连接应用内 Client/Server，没有公开 MCP 网络端点。

快速测试通过可控供应商输出运行真实 Pi 与 MCP，另以真实 SQLite 验证任务行为；浏览器测试运行独立的受控模型 worker，不使用管理员 Gemini 或素材生成凭据。这些测试不代表 Gemini 线上理解参考图、技能选择和创作效果已验收。真实 Gemini 调用与付费图片/视频生成仍需人工验收。画布写入进入持久历史；生成须确认具体批次；关闭页面后后台继续，重开读取持久对话、等待事项及结果。


助手生成需要同时运行 `pnpm agent:worker` 与 `pnpm generation:worker`，与 Web 共用 SQLite 和管理员配置。生成 worker 负责供应商查询及产物保存；助手 worker 负责持久产物挂接与后续规划。助手 worker 使用 15 秒租约，重启后旧租约到期时，中断规划（包括等待生成结果的后续规划）显示“待继续”，用户点击“继续创作”后续行。等待回答或批准仍保持未决，用户回答即继续；已停止、完成或失败的任务不会自动重启。并行部署的 worker 不接管仍有有效租约的同项目任务。

已提交生成继续查询、保存并挂接到仍存在的目标，不等待用户继续规划；尚未提交的已批准操作在继续前保持排队，并在实际提交前再次检查批准和画布绑定。保存失败后自动重试已有产物最多三次（5、10、20 秒退避），仍失败则保留原因，可要求再次重试保存；任何保存重试都不重新生成。提交事实不明确仍显示待核实，不自动重付费。浏览器回归的独立测试控制端口为 3218，用于真实重启受控助手 worker，仅存在于测试启动脚本。
