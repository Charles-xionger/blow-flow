# Krea2 生成任务（工单 01）

新增模型 `runninghub-krea2` 使用独立任务接口；显示名称可更改，适配器固定为 `runninghub-workflow`。现有模型及 `/api/generate/*` 保持原行为。H3 尚未发布。

## 启动

在服务端 `.env.local` 配置（不要提交凭据）：

```dotenv
DATABASE_PATH=./data/canvas.db
RUNNINGHUB_BASE_URL=https://www.runninghub.ai
RUNNINGHUB_API_KEY=你的国际站密钥
OSS_REGION=oss-cn-hangzhou
OSS_BUCKET_NAME=你的Bucket
OSS_ACCESS_KEY_ID=你的OSS密钥ID
OSS_ACCESS_KEY_SECRET=你的OSS密钥
```

连接地址必须显式填写。空地址或空密钥时，公开目录显示未配置，拒绝创建任务。上面的国际站契约不能直接换成国内站地址混用。配置状态表示平台地址及密钥存在，不代表账号权限、余额或 OSS 连通性已验证。

```sh
pnpm install
pnpm dev                  # 生产：pnpm build && pnpm start
pnpm generation:worker    # 必须在另一个进程持续运行
```

Web 和 worker 必须使用相同的工作目录、数据库绝对路径和服务端环境。worker 使用 Node 22、项目 TypeScript 转译加载器及现有依赖；部署不要移除 TypeScript。用 systemd/容器进程管理器分别监督 Web 与 worker，给 worker 配置失败重启。SQLite 文件需要持久卷；不要跨机器通过网络文件系统共享 SQLite。退出时等待当前有界请求结束，强制退出后由持久化状态恢复。

启动时只新增 `generation_tasks`、`generation_diagnostics` 和队列索引，不重置旧表。任务保存请求标识、画布/节点关联、有效输入及种子、模型和连接配置快照、平台 ID、期限、生成与保存状态、平台结果及 OSS 结果。凭据来自环境变量，不进入快照。诊断响应独立保存在服务端并脱敏，公开响应不返回原始平台响应、种子、凭据或临时结果 URL。

## 配置目录和连接

默认目录见 `lib/generation/config.ts`，默认导出见 `config/workflows/krea2.json`。自定义配置文件可由以下命令生成后编辑：

```sh
node -r ./scripts/register-typescript.cjs -e 'console.log(JSON.stringify(require("./lib/generation/config.ts").defaultConfig, null, 2))' > /tmp/generation-config.json
```

设置 `GENERATION_CONFIG_PATH` 为该 JSON 的绝对路径。连接字段 `baseUrl` 填明确站点地址，`apiKeyEnv` 只填环境变量名称；多个模型可共用 `connectionId`。模型需要稳定 `id`、显示 `name`、`version`、显式 `adapter`、导出图及映射。修改模型时更新 `version` 并重启 worker。现有任务继续使用创建时的完整快照；更换账号时创建新连接 ID，保留旧任务使用的凭据环境变量。

每个连接默认 `concurrency: 1`。可调整并发、`requestTimeoutMs`（默认 30 秒）、`pollIntervalMs`（5 秒）、`queryTimeoutMs`（30 分钟）和 `maxQueryErrors`（3 次）。并发占位与认领在 SQLite IMMEDIATE 事务内完成；多进程 worker 不会重复提交同一任务。所有未明确结束的任务（包括待核实、等待超时）计入占位。提高并发应在所有进程使用相同配置后进行。

## API 和状态

- `GET /api/generation/models`：公开模型目录及能力。
- `POST /api/generation/tasks`：持久化后立即返回本地任务，后台独立执行。
- `GET /api/generation/tasks/:id`：读取本地任务状态和保存结果，不触发平台执行。

创建示例：

```json
{
  "requestId": "客户端生成并保存的UUID",
  "modelId": "runninghub-krea2",
  "canvasId": "画布标识",
  "nodeId": "节点标识",
  "input": { "prompt": "田园风景", "width": 1920, "height": 1080 }
}
```

同请求标识、相同输入返回同一任务；不同输入返回 409。新的明确生成使用新标识；相同提示词不复用缓存。参考图仅允许省略或空列表；未知参数（包括种子、数量、优化开关）被拒绝。

生成状态包括本地排队、提交中、平台处理中、待核实、等待超时、成功、失败；保存独立区分等待、保存中、已保存、失败。提交断线/超时或提交者崩溃不自动重提，并保留占位。运行中的已知平台 ID 由新 worker 继续查询。暂时性查询错误有限重试；业务错误或无法识别响应停止查询且保留占位。等待期限到达停止轮询且保留占位。平台成功即释放生成占位；下载或 OSS 失败不触发重新生成。

首次保存使用现有 OSS 配置，下载限时 30 秒、上传限时 60 秒，按本地任务 ID 写入 `images/generation/<id>/<index>.png`。文件 MIME 沿用下载响应。服务端不打印平台/OSS 原始错误。

本票支持前端保存任务关联与基本轮询；工单 02 负责完整恢复操作、继续查询和画布竞态，03 负责重试保存与转存恢复。不要手动将待核实任务改成排队以“修复”，这可能重复计费。

## 协议与尺寸核实依据

- [国际站高级工作流提交](https://www.runninghub.ai/runninghub-api-doc-en/api-425761093.md)：`POST /task/openapi/create`，body 含 apiKey、workflowId、workflow JSON 字符串及 nodeInfoList；Authorization 使用 Bearer。同文档正文要求 fieldValue 保持类型，而附带 schema 声明为 string；本实现按正文保留数字/布尔，并提交完整导出图以固定执行配置，真实联调需确认账号服务行为。
- [国际站工作流结果查询](https://www.runninghub.ai/runninghub-api-doc-en/api-425761034.md)：`POST /task/openapi/outputs`，taskId 以字符串发送；code 0 的 data 为输出列表，读取节点 103 的 fileUrl。
- [错误码](https://www.runninghub.ai/runninghub-api-doc-en/doc-8287467.md)：804 运行中、813 排队中、805 任务失败。其他查询业务错误不无限重试。数值形式 int64 taskId 在 JSON 数字解析前转成字符串，避免精度损失。
- [TTResolutionSelector 固定版本 b69cf75](https://github.com/AICoderTudou/ComfyUI-TT-Resolution_selector-Node/blob/b69cf75c2ce5f864e3db5301dba46a6b5eeaa8fb/nodes/resolution_selector.py)：自定义整数范围 64–8192，步长 1，直接返回宽高。
- [ComfyUI v0.25.0 EmptyLatentImage](https://github.com/comfyanonymous/ComfyUI/blob/v0.25.0/nodes.py)：按 `height // 8`、`width // 8` 分配 latent。本模型仅允许 8 的倍数，防止隐式截断；范围可由管理员缩小，不自动裁剪。

导出文件来自用户提供的 Krea2 API JSON（工作流 2109340746494357505），已复制到仓库；运行不依赖 Downloads。提示词 102.prompt、尺寸 10.custom_width/custom_height、10.use_custom_resolution=true、种子 97.seed；输出 103。完整导出保留权重、LoRA、采样与旁路连线，实际提示词及随机种子在提交时替换。

## 验证和人工验收

```sh
pnpm typecheck
node --test tests/generation.test.cjs
pnpm test
```

集成测试使用真实临时 SQLite 和模拟外部边界，不需要真实密钥。HTTP 场景需要允许监听本机临时端口。测试验证付费提交次数、类型映射、幂等、配置快照、串行占位、响应丢失、查询期限及保存失败。

人工 UI 验收前先停止同目录已有的 Next dev（避免 `.next/dev/lock` 冲突），再运行 `node tests/helpers/generation-demo.cjs` 并访问 `http://localhost:3101`。该演示使用独立临时数据库、模拟平台和模拟保存结果，绝不调用真实平台/OSS。退出用 Ctrl-C。创建“生图”节点，选择 Krea2，输入提示词与尺寸，检查任务阶段和模拟图片；再选择旧模型，检查其原参数控件仍正常。真实旧模型生成需要该模型的连接配置。

UI 交互验收按用户要求交由人工。本次未执行真实 Krea2 付费生成。真实联调待办：配置国际站账号与 OSS，确认工作流及权重权限，选定最小测试尺寸，运行一次生成，核对最终像素、提示词、仅一次计费提交及 OSS 可访问性；确认站点接受类型化 fieldValue 与完整 workflow。64–8192 是节点约束，不是所有尺寸均已验证可在当前显存档位运行。
