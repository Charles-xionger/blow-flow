This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
pnpm dev:all
```

同时启动 Web、生成 worker（图片/视频）、助手 worker（规划并写画布）和脚本 worker（流式文本），输出带进程前缀；任一进程退出则全部停止。只启动 `pnpm dev` 时，生成、助手与脚本任务会停在队列，界面上表现为发送后没有反应。

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

也可以在四个终端分别运行 `pnpm dev`、`pnpm generation:worker`、`pnpm agent:worker` 与 `pnpm script:worker`。Web 和 worker 需从同一项目目录启动，使用相同的 `.env.local` 和数据库。配置 key 后需重启 worker。完整配置与恢复说明见 [Krea2 生成任务与恢复](docs/KREA2_GENERATION.md)。

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

本地追踪：运行 `scripts/setup-langfuse.sh`，按提示用 Docker 启动 Langfuse（网页 http://localhost:3100，避开 Web 的 3000），并把 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` 写入 `.env.local`。部署文件与生成的密钥在已忽略的 `.langfuse/`，可重复运行。agent worker 启动时读到这三个变量即开启追踪（启动日志会显示），每次任务运行在 Langfuse 记为一条 trace：会话为项目 ID，包含每轮模型调用（输入、输出、用量）、工具调用的参数与结果、失败原因；参考图只记录摘要，凭据已打码。未配置时追踪关闭，失败原因仍输出在 agent worker 终端。

内置 Ark 语言模型为 `deepseek-v4-pro-ga-260813`（DeepSeek V4 Pro）和 `doubao-seed-2-1-pro-260915`（Doubao Seed 2.1 Pro），均使用 `https://ark.cn-beijing.volces.com/api/v3/responses` 和服务端 `ARK_API_KEY`，与 Seedream 共用密钥。配置后重启 Web 与 agent worker，即可在创作助手和脚本节点中选择。助手使用流式 Responses 与现有 MCP 工具；DeepSeek 默认启用 `web_search`（`max_keyword: 3`），图片分析请选择豆包。脚本生成不启用联网搜索；自动选择在配置 Ark 密钥时优先使用 Ark。提示词生成在配置 Ark 密钥后自动选择 Ark（有图片时使用豆包），可通过请求字段 `textModel` 指定模型，图片上下文作为 `input_image` 传入。

如果设置了 `AGENT_CONFIG_PATH`，文件中的模型列表会替换内置助手列表；请将需要的 Ark 模型加入其中。例如：

```json
{"models":[
  {"id":"deepseek-v4-pro-ga-260813","name":"DeepSeek V4 Pro","modelId":"deepseek-v4-pro-ga-260813","provider":"ark","apiKeyEnv":"ARK_API_KEY","webSearch":true},
  {"id":"doubao-seed-2-1-pro-260915","name":"Doubao Seed 2.1 Pro","modelId":"doubao-seed-2-1-pro-260915","provider":"ark","apiKeyEnv":"ARK_API_KEY"}
]}
```

分镜和提示词生成统一调用 `lib/ai-services/text/index.ts` 的 `generateText`，业务路由不判断厂商；通用层按模型注册配置选择适配器并注入连接参数。

Ark 的 `baseUrl` 如覆盖，应包含 `/api/v3`，不包含 `/responses`。Pi 中配置的是保守的应用上下文与输出预算，费用元数据暂为零，不代表平台免费；实际用量与费用以方舟账单为准。协议参考：[Responses API](https://docs.volcengine.com/docs/ark/create-model-responses-api)、[联网搜索](https://docs.volcengine.com/docs/ark/web-search)。

可用 `AGENT_CONFIG_PATH` 指向管理员维护的 JSON：

```json
{"models":[{"id":"gemini-flash","name":"Gemini Flash","modelId":"gemini-flash-latest","apiKeyEnv":"GEMINI_API_KEY"}]}
```

`baseUrl` 为可选的平台入口；密钥只通过服务端环境变量读取。客户端目录仅包含模型名称、ID 和是否已配置。用户在画布右侧“创作助手”发送消息、引用选中节点或上传 PNG/JPEG/WebP 参考图。问题可用选项或文本回答/修改，也可停止任务；等待不会超时变成同意。消息、工具身份与结果、问题和状态保存到 SQLite。引用项目图片仅从已有 OSS 源或内嵌图片读取，并转换为模型可理解的图像内容。

当前集成固定使用 `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 0.73.1、MCP SDK 1.32.2 和 TypeBox 0.34.52。Pi 上游已迁移到 [earendil-works/pi](https://github.com/earendil-works/pi/tree/main/packages/agent)，因此旧 scope 被标记 deprecated；此版本按实际安装的 README、类型和真实 Agent 循环验证，未来升级需重新验证 API。MCP 使用 SDK 的 `InMemoryTransport` 连接应用内 Client/Server，没有公开 MCP 网络端点。

快速测试通过可控供应商输出运行真实 Pi 与 MCP，另以真实 SQLite 验证任务行为；浏览器测试运行独立的受控模型 worker，不使用管理员 Gemini 或素材生成凭据。这些测试不代表 Gemini 线上理解参考图、技能选择和创作效果已验收。真实 Gemini 调用与付费图片/视频生成仍需人工验收。画布写入进入持久历史；生成须确认具体批次；关闭页面后后台继续，重开读取持久对话、等待事项及结果。


助手生成需要同时运行 `pnpm agent:worker` 与 `pnpm generation:worker`，与 Web 共用 SQLite 和管理员配置。生成 worker 负责供应商查询及产物保存；助手 worker 负责持久产物挂接与后续规划。助手 worker 使用 15 秒租约，重启后旧租约到期时，中断规划（包括等待生成结果的后续规划）显示“待继续”，用户点击“继续创作”后续行。等待回答或批准仍保持未决，用户回答即继续；已停止、完成或失败的任务不会自动重启。并行部署的 worker 不接管仍有有效租约的同项目任务。

已提交生成继续查询、保存并挂接到仍存在的目标，不等待用户继续规划；尚未提交的已批准操作在继续前保持排队，并在实际提交前再次检查批准和画布绑定。保存失败后自动重试已有产物最多三次（5、10、20 秒退避），仍失败则保留原因，可要求再次重试保存；任何保存重试都不重新生成。提交事实不明确仍显示待核实，不自动重付费。浏览器回归的独立测试控制端口为 3218，用于真实重启受控助手 worker，仅存在于测试启动脚本。

### 脚本后台生成

脚本节点只配置输入，点击生成立即创建相连的文本节点并在其中流式展示正文，不需要发布或历史版本管理。通过 `/api/script/tasks` 提交幂等请求，独立的 `pnpm script:worker` 调用通用 `streamText` 模型适配层。配置服务端 `ARK_API_KEY`，或已有 Gemini 服务端密钥后重启 worker。`pnpm dev:all` 包含此 worker；生产环境也需持续运行它，并与 Web 共用 `DATABASE_PATH`。`SCRIPT_CONCURRENCY` 控制脚本任务并发上限（默认 5，范围 1–20）。

SQLite 保存输入快照、任务身份、正文和修订号；页面经每画布一条 SSE 接收已持久化正文，连接失败时每 10 秒查询。关闭页面不会停止后台生成；执行进程丢失后租约过期，worker 将任务标记中断并保留正文，不重新调用供应商。脚本任务不写回整张画布，也不复活删除的节点。尚未提交的已删除节点任务不会调用模型。

脚本旧项目升级、助手发布与人工联调步骤见 [脚本创作与迁移](docs/SCRIPT_CREATION.md)。
