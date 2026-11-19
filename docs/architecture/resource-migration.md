# 创作资源迁移到 Go

状态：Go API、PostgreSQL 模型与一次性迁移工具已实现；生产切换尚未执行。

## 领域边界

Go 的 `resource` 模块保存项目、文件夹、画布快照、版本化保存回执、删除节点记录和素材元数据。所有读写以已验证用户 ID 限定资源所有者；管理员角色不会自动获得个人创作资源的写权限。生成任务授权读取 `projects` 和 `media_assets`，不再使用测试授权表。项目移入回收站后不能接受新保存或新生成；已经提交的供应商任务仍可查询与交付。已上传素材有独立生命周期，项目删除后仍归原用户所有。

脚本任务创建结果节点与保存正文时，经 `resource/postgres.ScriptCanvas` 在任务事务内更新画布版本并写保存回执；脚本模块只保存任务、检查点与执行状态。脚本输入中的创作要求和参考素材须与已保存画布的节点、连线顺序和内容一致。

普通创作用户先由受控 CLI 创建并验证，使用 Go API 的密码和图片验证码登录。公开自助注册、邮箱验证与找回密码属于账户上线前置，尚未开放。Web 提供登录弹窗，通过 HttpOnly Cookie 保持 Go 会话；`GO_CUTOVER=1` 时，项目列表、画布读写、历史和 Agent 命令由 Next.js 路由转发到 Go，默认仍走旧路径。画布发送给 Agent 前必须确认已在 Go 中保存，避免助手读取过期快照。Go Agent 公开接口另需 `AGENT_GO_EXPERIMENTAL_COMMANDS=1` 和 Runner 密钥；生成审批、删除授权、技能和素材引用尚未具备完整对等能力，因此该开关仅供隔离的本地演练，不能作为生产切流完成的凭据。

本地演练在 Web 环境同时设置 `GO_CUTOVER=1` 和 `NEXT_PUBLIC_GO_CUTOVER=1`，设置 `GO_API_URL`，然后启动 Go API 与 Web。Go 账号由 `pnpm --filter @blow-flow/api creator:setup` 建立。生产前还需完成其他 Next.js 项目相关接口的归属切换、Go Agent 工具对等、数据导入验收和回滚演练，避免同一批项目在两套存储中发生分叉。

开发模式的 Go API、生成 Worker、脚本 Worker 和 Agent Dispatcher 启动命令会读取仓库根目录的 `.env.local`（原 Next.js 模型/供应商配置），再读取 `apps/api/.env.local`；shell 中显式传入的变量优先。独立 Node Agent Worker 沿用 Web 的同一套加载顺序。现有 `GEMINI_API_KEY`、`ARK_API_KEY`、`RUNNINGHUB_API_KEY` 与 `RUNNINGHUB_BASE_URL` 可直接复用，不复制密钥到源码或提交文件。数据库迁移、资源导入及生产 Go 二进制仍要求明确提供环境变量，避免隐式选择目标数据库。

## 一次性历史数据导入

1. 在停写窗口停止 Next.js 新项目保存、上传和新生成提交；等待已提交任务完成或确认其原平台任务 ID 已保留。备份 SQLite 文件、WAL/SHM 和 OSS 清单。
2. 确认 Go PostgreSQL 已完成 Goose 迁移，初始所有者账户为 `active`。用只读导出工具创建权限为 `0600` 的 JSON：

   ```sh
   python3 apps/api/scripts/export_legacy_resources.py --database data/canvas.db --output /secure/path/resources.json
   ```

3. 在 `apps/api` 目录预检，再向已备份的 PostgreSQL 目标库导入。`-oss-host` 必须是本项目受信任的 OSS 主机名，才能将画布里的旧素材 URL 索引为归属初始所有者的 `media_assets`；省略时仍保留画布内的 URL，但不创建独立素材记录。

   ```sh
   go run ./cmd/import-legacy-resources -file /secure/path/resources.json
   DATABASE_URL='postgres://...' go run ./cmd/import-legacy-resources -file /secure/path/resources.json -owner '<初始所有者 UUID>' -oss-host '<OSS 主机名>' -apply
   ```

4. 核对 `projects`、`project_folders`、`project_save_receipts`、`project_deleted_nodes`、`script_tasks`、`script_requests`、`agent_tasks`、`agent_messages`、`agent_legacy_command_receipts`、`agent_legacy_canvas_receipts`、`agent_legacy_task_snapshots`、`agent_legacy_generation_batches` 的行数及 ID 集合与导出文件一致；抽查项目画布内容、版本、回收站、素材链接、分镜检查点及助手消息。导入时旧的排队、运行中或等待回答的助手任务标为中断，但标记为只读历史，不能被 Go Runner 领取或继续；旧确认不能在 Go 中直接批准，原任务和生成批次只作为历史归档，不向模型或生成供应商重提。检查其他用户访问返回 404。导入遇到 ID 冲突会整体回滚，不覆盖既有项目。
5. 仅在验收通过后，把项目与素材的读写路由和生成任务调用层切换到 Go。保留旧数据库与对象清单以便回滚，不让 Next.js 和 Go 同时写同一批项目。旧任务的原平台任务 ID 只用于查询，不重新提交付费请求。

导出 JSON 包含 Prompt、画布内容和媒体 URL，只能放在受控位置，验收后删除。历史 `media_files` 中仅有 base64 的内容会作为 data URL 保存在素材记录中；真实 OSS 对象不在导入时复制。现有嵌入画布的 OSS 链接按准确主机名索引，不接受任意外部 URL 作为已上传素材。

## 回滚

切流前可直接放弃目标库导入并重试；切流后先停 Go 写入，核对新写项目和任务，再按备份恢复旧读写入口。发生新写时不能直接让旧 SQLite 覆盖 PostgreSQL；需要先导出差异或保留只读排障入口。账户和资源归属遵循 [ADR-0018](../adr/0018-do-not-build-platform-credits.md)；生成任务的消息与恢复规则遵循 [ADR-0021](../adr/0021-rabbitmq-redis-for-go-generation.md)。
