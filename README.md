This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

RunningHub 图片生成还需要在另一个终端持续运行后台任务进程：

```bash
pnpm generation:worker
```

仅启动 `pnpm dev` 会让任务停在本地队列，不会提交到 RunningHub。Web 和 worker 需从同一项目目录启动，使用相同的 `.env.local` 和数据库。配置 key 后需重启 worker。完整配置与恢复说明见 [Krea2 生成任务与恢复](docs/KREA2_GENERATION.md)。

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
