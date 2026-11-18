# 生成运营后台

`apps/admin` 是 monorepo 中独立的 Vite 应用，通过共享的 `@blow-flow/api-client` 调用 Go API。界面基于 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin) 的主题、侧栏/顶栏布局和 shadcn UI 基础组件改造；导入版本 `e16c87f213a5ba5e45964e9b67c792105ec74d26`，MIT 许可见 [LICENSE](LICENSE)。演示数据、Clerk 登录和与本产品无关的示例页没有导入。

当前使用的模板组件有 Button、Card、Badge、Input、Table；页面按总览、生成任务、供应商成本、用户账户、审计记录组织。总览的账户与审计卡片来自真实 API，最多展示当前请求的 20 条，不代表全站总数。用户页支持状态筛选、翻页和禁用账户；审计页支持翻页。生成任务和成本仍等待对应 Go 领域的权威接口。

## 本地运行

1. 在仓库根目录执行 `pnpm db:up` 和 `pnpm admin:setup`。后者会补齐本地 API/数据库默认地址，并生成强密码及签名密钥，写入忽略提交的 `apps/api/.env.local`；登录信息写入权限为 `0600` 的 `apps/api/.admin-login.local`。这些文件含敏感信息，仅用于本地开发。若旧 `ai-flow` PostgreSQL 已在运行，使用 `POSTGRES_VOLUME_NAME=blow-flow_postgres-data POSTGRES_PORT=15433 pnpm db:up`，再将 `apps/api/.env.local` 中的 `DATABASE_URL` 端口改为 `15433`，以免两个容器共用数据卷。
2. 在终端加载 API 环境变量，然后迁移并启动 Go API：

   ```sh
   set -a
   source apps/api/.env.local
   set +a
   pnpm db:migrate
   pnpm dev:api
   ```

3. 在另一终端运行 `pnpm dev:admin`，打开 `http://127.0.0.1:3218/`。密码见 `apps/api/.admin-login.local`；输入页面显示的图片验证码即可提交登录。

Admin 开发服务器把 `/v1` 代理到 `apps/admin/.env.local` 的 `API_URL`（默认 `127.0.0.1:8080`）。生产部署也须将同源 `/v1` 代理至 Go API。未完成本地管理员配置时，开发模式可使用 `?preview` 查看页面结构；此模式不请求管理接口，也不会进入生产构建。

登录前 Go API 会签发一次性四位图片验证码。登录令牌保存在浏览器 `sessionStorage`，有效期 15 分钟；退出会清除当前浏览器的令牌。Go API 在每次受保护请求中查询账户状态，禁用账户会立即失去 Go API 的访问权限；禁用用户要求最近 10 分钟内完成登录。现有 `apps/web` 生成链路尚未迁移到该授权边界。当前本地引导仅创建首位管理员，尚未提供公开注册或密码找回流程。

普通创作用户的注册属于 `apps/web` 的账户入口，不在管理员后台提供自行注册。开放注册前还需要完成邮箱验证、资源所有者迁移与授权隔离，以及产品文档要求的注册和生成安全门槛；否则新账户仍会访问现有固定本地身份的创作资源。
