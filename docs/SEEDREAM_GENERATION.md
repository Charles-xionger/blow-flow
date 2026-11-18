# Seedream 5.5 与 5.0 Pro 官方生图

模型 `doubao-seedream-5-5-261028` 与 `doubao-seedream-5-0-pro-260628` 通过火山方舟官方 `POST https://ark.cn-beijing.volces.com/api/v3/images/generations` 接入持久化生成任务，覆盖画布文生图、图生图和创作助手。模型与参数依据：[官方 Seedream 5.5 教程](https://docs.volcengine.com/docs/ark/seedream-5-5?lang=zh)与[图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh)。

## 配置与运行

在服务端 `.env.local` 配置 `ARK_API_KEY`。Key 应有目标模型的调用权限，并且账号已开通该模型。继续使用项目现有 OSS 配置保存原始产物。Web 与 generation worker 必须使用相同数据库与环境；更改配置后重启这两个进程。

```sh
pnpm dev
# 另一个终端
pnpm generation:worker
```

默认连接名 `volcengine-ark`，并发为 5，与 RunningHub 的 5 个名额独立。IPM 是平台每分钟图片配额，不等于应用同时执行的任务数。连接配置位于 `lib/generation/seedream.ts`，可通过现有 `GENERATION_CONFIG_PATH` 覆盖；使用自定义配置文件时需将新连接和模型合入自己的目录。缺少 Key 时模型显示“未配置”。

## 输入与高级设置

两个模型每次生成一张图片，最多十张参考图。参考图片可连接画布节点或直接上传，按界面顺序发送，排序后提示词中的连接引用编号随之变化。项目目前接受 PNG、JPEG、WebP，每张不超过 30 MB；官方接口还支持其他格式，本次沿用项目原始素材上传格式。服务端在付费提交前校验图片内容、尺寸与透明通道。

尺寸提供 1K、1.5K、2K 和常用画幅，默认 2K。使用官方的像素预设，例如 1.5K / 16:9 为 2048×1152，2K / 16:9 为 2816×1584；不使用 Krea2 的短边换算。

高级设置按节点持久化，创作助手可通过 `input.imageOptions` 设置相同参数：

| 字段 | 取值 | 默认 |
| --- | --- | --- |
| `outputFormat` | `png`、`jpeg` | `png` |
| `promptOptimization` | 5.5：`standard`；5.0 Pro：`standard`、`fast` | `standard` |
| `watermark` | 布尔值，可见水印 | `false` |
| `background` | `opaque`、`transparent` | `opaque` |

5.5 可在文生图或图生图中原生生成透明 PNG；5.0 Pro 仍需要一张带透明通道的参考图。图层拆分、富文本 OCR、多轮精准编辑、坐标／框选／箭头局部编辑不在本次范围内。普通生图不发送组图、流式或联网参数，也不发送未声明支持的 seed。

## 封装与失败处理

`lib/generation/image-adapters.ts` 的 `generateImage(snapshot, input, io)` 是同步图片生成的统一函数，Gemini 和火山方舟各自实现适配器。函数返回原始图片地址数组；任务层负责授权、并发名额、状态、OSS 保存与仅重试保存。RunningHub 继续使用已有异步提交／查询协议。

适配器在付费调用前执行 `beforeSubmit`，由任务层再次核实所有权和生成授权。素材准备阶段续租，节点删除或授权失效后不会继续提交。官方请求使用独立网络传输，不继承 RunningHub 专用选路。

明确的鉴权、权限、参数或限流拒绝会结束任务并展示应用生成的错误说明，不展示可能含凭据的原始响应。网络断线、超时、5xx 或无法识别的返回仍记为待核实，不自动重发付费请求。官方文档未提供本接入可用的任务查询或幂等去重契约，不将同步调用包装成可恢复的远端查询。

请求超时初始设为 180 秒，是应用策略，不是官方 SLA。图片 URL 官方有效期为 24 小时，生成成功后立即转存 OSS；转存失败只重试保存原始产物，不重新生成。进程退出会等待已开始的操作结束；强制退出后沿用持久化任务的待核实规则。

## 验证边界

自动化测试替换官方平台与 OSS，覆盖请求参数、参考图、透明背景、错误分类、并发五个名额、转存重试、画布参数保存和助手确认。真实 Key、账号配额、平台权限及实际图片效果需配置凭据后联调；测试替身通过不代表已完成真实生成。

2026-11-06 最终验证：`pnpm typecheck`、改动文件 ESLint、`git diff --check` 通过；全量快测 `pnpm test` 291/291（25 秒），全量浏览器回归 `pnpm test:browser` 135/135（7.6 分钟）。先前一次运行遇到 Turbopack 缓存崩溃，另一次跨越电脑休眠而产生超时；重建测试缓存并以 `caffeinate -i` 保持测试期间唤醒后，在不改动应用源码的情况下完成全量浏览器验证。尚未执行真实付费生成。
