# Krea2 生成任务与恢复（工单 01–03）

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

启动时按需新增 `generation_tasks`、`generation_diagnostics`、`generation_deleted_nodes` 和队列索引，不重置旧表。任务保存请求标识、画布/节点关联、有效输入及种子、模型和连接配置快照、平台 ID、期限、生成与保存状态、平台结果及 OSS 结果。凭据来自环境变量，不进入快照。诊断响应独立保存在服务端并脱敏，公开响应不返回原始平台响应、种子、凭据或临时结果 URL。

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
- `POST /api/generation/tasks/:id/save`：针对原任务重试保存，只允许已有生成成功结果的任务；重复请求不会抢占正在执行的转存，已保存任务保持原样。
- `POST /api/generation/tasks/:id`：继续查询原任务，为超时或有平台 ID 的待核实任务设置新的查询期限。其他状态保持不变；无平台 ID 的待核实任务返回 409。
- `DELETE /api/generation/tasks`：body 为 `{ "canvasId": "...", "nodeId": "..." }`。原子取消该节点尚未认领的任务，记录删除标记以阻止迟到的创建请求；已提交任务继续查询和保存。

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

首次保存与恢复共用现有 OSS 配置。每个产物先检查稳定路径 `images/generation/<id>/<index>.png` 是否已有对象（HEAD 连接与响应各限时 15 秒），存在则直接记录其引用；不存在才下载（限时 30 秒）并上传（连接与响应各限时 60 秒）。OSS 账号需具备该路径的对象读取/HEAD 和写入权限，部署恢复时保留原 bucket/region。文件 MIME 沿用下载响应。服务端不打印平台/OSS 原始错误。

## 恢复、等待超时与删除

浏览器在创建请求发送前，将完整输入快照与请求标识同步写入 localStorage；写入失败时不提交。刷新或重新打开保存过的画布，会从本机记录找回最近一次任务。创建响应丢失时以同一请求标识重试公开创建接口，后端幂等返回已有任务。输入编辑不改变这份快照；明确失败后的“重新生成”使用新请求标识，旧任务仍保存在数据库。节点复制会清除任务关联；导入画布为节点和边分配新标识，保留已有图片但不共享源画布的任务。切回旧模型并开始生成时解除当前任务展示关联，保留后台历史记录。本机记录按稳定节点 ID 保存，草稿首次保存获得画布 ID 后仍可接回原任务；跨浏览器恢复需要保存后的画布本身含有任务关联。

重启 Web 与 `pnpm generation:worker` 时保留原数据库与环境配置。排队任务继续排队；已有平台 ID 的任务继续查询同一 ID；提交中断且结果未知的任务变为待核实并占用并发名额。恢复需等待旧租约到期（平台请求超时加 30 秒），不代表再次提交。生成成功且保存中的任务保留保存状态，保存租约过期后由 worker 自动接管未完成部分；保存租约为每个产物 240 秒，覆盖最长约 180 秒的网络阶段并留有余量，逐个续期，恢复不重新生成。

查询期限使用任务创建时连接快照中的 `queryTimeoutMs`。到期后 worker 停止平台轮询，显示“等待超时”；点击“继续查询原任务”从当前时间重新计算期限并清零查询错误计数，不创建付费任务。待核实但已有平台 ID 时也可继续查询；无平台 ID 时提示需要核实，继续保留占位。只有平台明确成功或失败才释放占位。不要手动将待核实任务改成排队以“修复”，这可能重复计费。

切换画布、路由和卸载组件只停止本地观察。明确删除节点才发出取消请求，删除与 worker 认领由数据库事务决定先后：已认领的任务不会报告为已取消。浏览器先保存取消请求，离线时保留，重新联网或打开画布后重试；服务器收到之前任务仍可能被认领。已提交任务始终继续执行并保存，迟到结果不会创建节点，也不会覆盖节点较新的任务。清除浏览器数据会移除本机恢复记录和未发送的取消请求。

## 保存失败与重试

生成成功之后，保存状态独立显示为等待保存、保存中、已保存或保存失败。保存失败不再占用平台生成并发名额。节点提供“重试保存（不重新生成）”：它仅将原任务的失败转存重新排队，从持久化的平台结果继续处理，保留已保存的产物引用，不重新调用平台生成接口。“重新生成”则创建独立任务，可能再次计费。

转存由同一个 `pnpm generation:worker` 进程执行，无需另启服务。中断恢复包括：上传前重试下载；上传已成功但数据库记录未写回时通过 OSS HEAD 找回对象；多个产物部分完成时跳过已有引用。认领和重试在数据库事务内执行，活跃保存租约不被重复点击抢占，旧执行者不能覆盖新执行者的任务记录。显式下载或 OSS 错误转为保存失败，等待用户重试；进程中断留下的未完成转存则在租约到期后自动接管。

平台临时 URL 返回 403/404/410 时显示“生成成功但结果保存失败：平台临时结果已过期或无法取回”；下载超时与 OSS 上传失败分别显示原因。若 OSS 尚无对象且平台文件已无法下载，重试保存也无法恢复文件；系统不承诺平台保留期限，不自动重新生成。用户可自行选择“重新生成”。平台 ID、原始结果和脱敏诊断留在服务端；公开任务仅返回保存状态、可展示错误与已保存的 OSS 引用。

## Krea2 节点与尺寸面板

文生图和图生图共用节点面板及组件样式，使用本项目深色主题和紫色选中态。面板位于预览框正下方，画布坐标宽度统一为 400、间距为 16，随节点一起缩放；不为 Krea2 使用独立的屏幕坐标控制台。提示词、尺寸摘要、模型选择和生成按钮共用布局，点击摘要展开相同的图像设置弹层。comfyArt 只作为按钮、画幅卡片、输入框等组件样式来源，复用样式的版权与 MIT 许可保留在 `THIRD_PARTY_NOTICES.md`。

所有生成图片节点按画幅使用相同的 320×320 预览限幅规则。旧画布中的固定节点样式仅在渲染时解除，避免真实预览与外层选框、连线和面板位置不一致，不改写已有生成像素。分组使用实际测量的节点大小。各模型保持自己的尺寸能力和接口参数：Krea2 使用实际宽高，其他文生图模型保留原有档位和画幅值，图生图保留 `1024x1024` 等分辨率参数；共享外观不代表共享模型能力。

尺寸档位是产品的像素预设，不是模型画质等级：1K、2K 分别以短边 1024、2048 为基准，长边按画幅计算，宽高按模型能力的步长四舍五入。Krea2 当前步长为 8，因此 2K + 16:9 的实际尺寸为 3640×2048。超出模型能力范围的档位或画幅组合禁用，不裁剪预设导致画幅变化。画幅包括 1:1、3:2、2:3、4:3、3:4、16:9、9:16、4:5、5:4、21:9。

新建节点默认生成尺寸保留为 1920×1080，摘要显示“自定义 · 16:9”。旧画布的宽高在打开面板时保持原值。自定义宽高在失焦或按 Enter 后对齐到允许范围内最近的步长，回显实际数值并提示调整；空值或非法输入恢复该字段上次有效值。节点标题和设置弹层显示最终生成像素，节点预览按画幅等比限制在 320×320 显示范围内；显示大小与实际生成像素独立。

档位、画幅和自定义输入最终仍提交现有的 `width` / `height`，不改变原请求恢复、继续查询、重试保存与重新生成的语义。旧模型仍使用原有参数和调用路径。

## 协议与尺寸核实依据

- [国际站高级工作流提交](https://www.runninghub.ai/runninghub-api-doc-en/api-425761093.md)：`POST /task/openapi/create`，body 含 apiKey、workflowId、workflow JSON 字符串及 nodeInfoList；Authorization 使用 Bearer。同文档正文要求 fieldValue 保持类型，而附带 schema 声明为 string；本实现按正文保留数字/布尔，并提交完整导出图以固定执行配置，真实联调需确认账号服务行为。
- [国际站工作流结果查询](https://www.runninghub.ai/runninghub-api-doc-en/api-425761034.md)：`POST /task/openapi/outputs`，taskId 以字符串发送；code 0 的 data 为输出列表，读取节点 103 的 fileUrl。
- [错误码](https://www.runninghub.ai/runninghub-api-doc-en/doc-8287467.md)：804 运行中、813 排队中、805 任务失败。500 等暂时性平台错误走有限重试，其他查询业务错误不无限重试。提交阶段仅明确的前置拒绝释放占位，500 或未知返回码保留占位。数值形式 int64 taskId 在 JSON 数字解析前转成字符串，避免精度损失。
- [TTResolutionSelector 固定版本 b69cf75](https://github.com/AICoderTudou/ComfyUI-TT-Resolution_selector-Node/blob/b69cf75c2ce5f864e3db5301dba46a6b5eeaa8fb/nodes/resolution_selector.py)：自定义整数范围 64–8192，步长 1，直接返回宽高。
- [ComfyUI v0.25.0 EmptyLatentImage](https://github.com/comfyanonymous/ComfyUI/blob/v0.25.0/nodes.py)：按 `height // 8`、`width // 8` 分配 latent。本模型仅允许 8 的倍数，防止隐式截断；范围可由管理员缩小，不自动裁剪。

导出文件来自用户提供的 Krea2 API JSON（工作流 2109340746494357505），已复制到仓库；运行不依赖 Downloads。提示词 102.prompt、尺寸 10.custom_width/custom_height、10.use_custom_resolution=true、种子 97.seed；输出 103。完整导出保留权重、LoRA、采样与旁路连线，实际提示词及随机种子在提交时替换。

## 验证和人工验收

```sh
pnpm typecheck
node --test tests/generation.test.cjs
node --test tests/artifact-recovery.test.cjs
node --test tests/image-dimensions.test.cjs
pnpm exec playwright test tests/browser/krea2-panel.spec.ts
pnpm test
pnpm test:browser
```

集成测试使用真实临时 SQLite 和模拟外部边界，不需要真实密钥。HTTP 场景需要允许监听本机临时端口。测试验证付费提交次数、类型映射、幂等、配置快照、串行占位、响应丢失、查询期限及保存失败；另通过 SIGKILL 独立 worker 进程、关闭并重开数据库，验证提交前、提交不明、取得平台 ID 和保存中的重启恢复。受控时间验证继续查询；画布公开操作验证刷新、切换、删除、复制及反序完成。产物测试使用真实临时 SQLite、模拟 HTTP 平台和 OSS，覆盖上传前、上传成功未记账、部分完成时杀掉进程后恢复，以及重复保存请求、下载超时、临时 URL 失效和旧任务迟到结果。

人工 UI 验收前先停止同目录已有的 Next dev（避免 `.next/dev/lock` 冲突），再运行 `node tests/helpers/generation-demo.cjs` 并访问 `http://localhost:3101`。该演示使用独立临时数据库、模拟平台和模拟保存结果，绝不调用真实平台/OSS。退出用 Ctrl-C。创建“生图”节点，选择 Krea2，输入提示词与尺寸，检查任务阶段和模拟图片；再选择旧模型，检查其原参数控件仍正常。真实旧模型生成需要该模型的连接配置。

尺寸面板已有真实浏览器自动化验收：验证档位/画幅与预览比例、通过真实画布 API 保存并刷新恢复、旧尺寸保留、自定义输入提交和提示、Escape 焦点返回，以及窄视口内的可操作性。生成参数在请求边界捕获，不调用真实付费平台。另独立检查了点击画布、Escape 和切换宽高字段时的输入提交。规范审查无硬性违规，重复档位类型建议已处理；规格审查无剩余发现。

2026-11-01 最终回归：`pnpm test` 109/109 通过，`pnpm test:browser` 38/38 通过，`pnpm typecheck`、修改文件 ESLint 和 `git diff --check` 通过。

2026-11-01 共享图片节点修正：移除仅 Krea2 使用的屏幕坐标面板，文生图与图生图统一节点内布局、显示尺寸和参数组件。回归复现了原面板 480 宽与其他节点不一致的问题，并验证 1 倍和 1.75 倍缩放下统一 400 宽、16 间距，旧固定外框不再影响实际预览。渲染转换按源节点引用缓存，拖动一个节点不会重新创建其他图片节点的渲染对象。两轴复审无剩余问题；`pnpm test` 111/111、`pnpm test:browser` 41/41、类型检查、修改文件 ESLint 通过。

本次未执行真实 Krea2 付费生成。真实联调待办：配置国际站账号与 OSS，确认工作流及权重权限，选定最小测试尺寸，运行一次生成，核对最终像素、提示词、仅一次计费提交及 OSS 可访问性；确认站点接受类型化 fieldValue 与完整 workflow。64–8192 是节点约束，不是所有尺寸均已验证可在当前显存档位运行。
