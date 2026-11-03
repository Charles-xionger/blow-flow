# 持续拖动性能实现与验证

实施依据：[performance-design.md](./performance-design.md)。本次使用的测试边界是设计中约定的预览链路、素材订阅和浏览器交互；原图始终留在项目与生成输入中。

## 实现

- `GET /api/canvas-preview?src=…` 为应用 OSS 图片生成派生预览；历史内嵌图片通过 `POST /api/canvas-preview` 的纯文本请求体处理，避免 URL 长度限制。
- Sharp 直接依赖固定为 0.34.5；首帧、自动方向、最长边 1024、不放大小图，输出带透明通道的 WebP（quality 82）。[Sharp 构造参数](https://sharp.pixelplumbing.com/api-constructor/)与[尺寸接口](https://sharp.pixelplumbing.com/api-resize/)说明对应的边界。
- 预览覆盖原图节点、生成图片节点、角色节点、上游缩略图、提示词引用缩略图、H3 素材区和保存为角色对话框。完整查看与下载仍接收原图，生成参数不改变。
- 换图使用独立的预览状态；失败不自动请求原图，提供重试与主动查看。固定节点框和缩略图容器避免加载状态改变几何。
- H3 只订阅上游素材的 ID、名称、类型、URL 与连线顺序。节点内容的 memo 比较忽略 xyflow 外壳使用的绝对坐标，仍传递选中、拖动、数据、尺寸及其他属性变化；控制台的挂载与隐藏语义保持。

## 来源与资源边界

盘点本地现存项目后，图片 URL 均属于应用配置的 OSS；同时代码中的历史生成器可能返回内嵌图片或厂商 URL。支持当前 OSS 的公开 HTTPS 地址及内嵌 PNG/JPEG/WebP/GIF/AVIF。未经确认的厂商地址、其他 bucket、本地路径、blob URL、SVG、带 query/hash 或用户凭据的 URL 显示错误状态。服务器不跟随重定向，也不把环境变量扩展为任意主机白名单。

缓存为每个应用进程的内存 LRU，可重启清除，不写项目、数据库或 OSS。键包含预览规格与源身份；远端每次请求都用 ETag（或 Last-Modified）条件读取，没有版本标识则重新下载并比对内容摘要。返回浏览器 `private, no-cache`，在重新请求时验证版本，不把外部同址素材视为永久不变。已经显示的图片不会主动轮询源内容。

资源参数：原素材最多 30 MiB、80 MP；下载 15 秒、Sharp 转换 10 秒；最多 2 个并行读取/转换、32 个在途键，排队源字符串估算最多 128 MiB；输出缓存最多 64 MiB/256 条。达到边界返回可重试错误，不缓存失败。最大输入的原生解码内存高于压缩文件体积，部署应预留至少约 2 GiB 进程内存并按素材负载调低并发/像素限额；当前真实夹具为约 16 MP，不能当作 80 MP 容量压力测试。

## 可重放性能测量

`scripts/canvas-performance.cjs` 读取 `CANVAS_PERF_PROJECT` 指向的项目快照，临时数据库隔离写入，去除可恢复的生成身份，并拦截生成/恢复接口。原项目不修改。原始快照、PNG 和原始 trace 位于被 git 忽略的 `measurements/`；报告只记录聚合指标。

```sh
NEXT_PUBLIC_CANVAS_PERF_EXPERIMENT=1 NEXT_TEST_DIST=.next-canvas-perf pnpm build
CANVAS_PERF_PROJECT=.scratch/canvas-drag-performance/measurements/source-project.json node scripts/canvas-performance.cjs
```

仅显式开启实验的构建支持 `preview=0` / `subscriptions=0` 对照；普通构建没有自动原图回退开关。基线是在同一构建中恢复原图展示和完整节点订阅/位置更新的控制配置，不宣称它是历史版本的逐字节重放。

有界面 Chromium，固定 1728×1117、DPR 1、保存的画布缩放 1.065807，使用真实 3456×4608 PNG（20,026,250 字节）。真实项目包含 4 个节点、原图连接两个 H3 节点。拖动路径为 120 个位置、约 4 秒闭环；覆盖按下、持续移动、松手，以及未选中/已选中两种状态。

每个独立冷态样本重启服务器并新建浏览器上下文；冷态在初次图片加载期间开始交互。热态等待图片已生成并被浏览器加载后，保持同一页面重复动作。首次预览响应等待单独记录，不混入热态结论。每种配置每种选中状态重复三次。

帧证据取 Chromium 的 `Display::FrameDisplayed`，长任务取交互标记范围内 renderer 主线程的 `RunTask > 50ms`；图片解码使用 `Decode Image`，提交等待使用 `LayerTreeHost::WaitForCommitCompletion`，避免重复累加包含关系的事件。H3 内容更新通过仅实验构建启用的 effect 标记计数。鼠标采样率不作为 FPS。

## 验证结果

待最终测量与审查完成后写入。
