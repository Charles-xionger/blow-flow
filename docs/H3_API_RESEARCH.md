# H3 生成工作流 API 与参考素材契约调研

核实日期：2026-11-01。本文记录接入事实与待验证项，不表示已向 RunningHub 提交或执行生成任务。

后续材料更新：用户已确认全部交互选择，并提供桌面上的 `H3无损融合单采【官方满血API画布级本地流】_api (1).json`。新版增加了 `185 / VHS_LoadVideo`、`182–184 / LoadAudio` 和更多图片连接，已保存为仓库 `config/workflows/h3.json`。以下“原 JSON”章节保留调研时下载目录旧版的事实；最终实现以桌面新版为准，见 [H3 接入说明](H3_GENERATION.md)。

## 证据边界

本地源文件为 `/Users/jiangxinbo/Downloads/H3无损融合单采【官方满血API画布级本地流】_api.json`。节点 136 声明 `comfy-core` 版本 `0.33.0`；本文已读取官方 **v0.33.0 标签源码**，不是以最新 master 推定旧版本行为。文件元信息不等于远端实例的实际安装版本，仍需 RunningHub 实测确认。

[用户工作流页面](https://www.runninghub.ai/zh-cn/workflow/2116745173157138433?source=workspace) 的匿名 HTTP 请求返回 401，网页工具也未能读取，因此本文没有独立确认该 ID 当前保存的图是否与本地文件一致。

主要来源：

- [ComfyUI v0.33.0：H3 节点源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_minimax_h3.py)
- [ComfyUI v0.33.0：视频加载与拆分节点](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_video.py)
- [ComfyUI v0.33.0：音频加载节点](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_audio.py)
- [VideoHelperSuite：与本地输出节点元信息相同提交的加载节点](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/4ee72c065db22c9d96c2427954dc69e7b908444b/videohelpersuite/load_video_nodes.py)
- [VideoHelperSuite：同一提交的节点名称映射](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/4ee72c065db22c9d96c2427954dc69e7b908444b/videohelpersuite/nodes.py)

## 原 JSON 当前启用的能力

本地节点 `136` 是 `MiniMaxH3ReferenceToVideo`。当前只连接两张参考图：`ref_images.ref_image_0 → ["199", 0]`、`ref_images.ref_image_1 → ["188", 0]`。这表示示例只用了两张图，不表示节点上限是两张图。当前没有连接参考视频、视频声音或独立参考音频。

同一节点已经连接文本编码器 `232`、视频 VAE `234`、音频 VAE `235`；提示词来自 `238`，尺寸来自 `228`，帧数来自 `224`。最终 `148 / VHS_VideoCombine` 接收 `122` 的视频帧及 `121` 的生成音频，以 24 fps 保存 H.264 MP4。参考音频用于引导生成，最终声音来自音频解码节点；不能将参考音频直接拼到输出视为等价实现。

另两份本地文件 `Minimax_H3_R2v.json`、`Minimax_H3_R2v_api (1).json` 使用相同类型的节点，连接三张图，也没有提供视频或参考音频加载示例。

## 动态参考字段与类型

下表的数量上限来自 v0.33.0 `MiniMaxH3ReferenceToVideo.define_schema()`。API 格式使用**零起始、扁平点分键**，不是嵌套 `ref_images` 对象；原导出 JSON 已直接体现点分格式。官方仓库的 [API 格式问题澄清](https://github.com/Comfy-Org/ComfyUI/issues/15667) 进一步确认嵌套写法会导致引用被忽略。

| 参考素材 | API `inputs` 中的键 | 输入类型 | 数量 |
| --- | --- | --- | --- |
| 图片 | `ref_images.ref_image_0` … `ref_images.ref_image_8` | `IMAGE` | 0–9 |
| 视频 | `ref_videos.ref_video_0` … `ref_videos.ref_video_2` | `IMAGE`，表示连续视频帧 | 0–3 |
| 视频配对声音 | `ref_video_audios.ref_video_audio_0` … `ref_video_audios.ref_video_audio_2` | `AUDIO` | 0–3，按视频索引配对 |
| 独立音频 | `ref_audios.ref_audio_0` … `ref_audios.ref_audio_2` | `AUDIO` | 0–3 |

这些参考组均为可选。v0.33.0 的 `clip`、`vae`、`audio_vae` 是必需输入；不要将当前 master 将 VAE 改为可选的定义套到本地版本。输出 0 是正向 `CONDITIONING`，输出 1 是联合音视频 `LATENT`。源码该节点未见“所有类型合计最多 12 个”的检查，不能从第三方介绍自行加上该限制；平台或模型是否另有限制仍需验证。[H3 v0.33.0 源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_minimax_h3.py)

## 加载节点与 24 fps

图片使用 `LoadImage.inputs.image`，输出 0 接到参考图片字段。独立音频使用 `LoadAudio.inputs.audio`，输出 0 接到参考音频字段。音频在内存中的类型包含 `waveform` 和 `sample_rate`；H3 会按音频 VAE 的采样率重采样，默认回退值为 32000 Hz。不要把文件 URL 字符串直接写进 `ref_audios.ref_audio_0`，该端口需要加载节点的类型化输出。[音频加载源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_audio.py)、[H3 编码源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_minimax_h3.py)

核心视频节点的连接方式是 `LoadVideo.inputs.file` → 输出 0 `VIDEO` → `GetVideoComponents.inputs.video`。拆分节点的输出 0 是 `IMAGE` 帧序列、输出 1 是 `AUDIO`、输出 2 是源 fps。H3 视频参考输入只收帧序列，**不会读取源 fps 或自动将 30 fps 转为 24 fps**。核心拆分节点也没有重采样参数；因此此路径应先将素材规范化为 24 fps。[视频节点源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_video.py)

另一条有源码依据的路径是 VideoHelperSuite 的 `VHS_LoadVideo`，它支持 `force_rate: 24`。其输出 0 是图像/潜变量、输出 1 是帧数、输出 2 是音频；本用途不连接可选 `vae`，使输出保持 `IMAGE`。本地已有该插件的输出节点，但这不足以证明远端加载节点可正常访问上传素材，需实测。[同版本加载节点定义](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/4ee72c065db22c9d96c2427954dc69e7b908444b/videohelpersuite/load_video_nodes.py)、[节点名称映射](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/4ee72c065db22c9d96c2427954dc69e7b908444b/videohelpersuite/nodes.py)

## 时长、尺寸与参考音频的实际约束

- 输出 `length` 单位是帧。节点字段声明范围 5–3600、步长 17；源码将实际帧数向上对齐到 `17k + 5`，以 24 fps 计算音视频时长。源码提示训练范围约 124–362 帧，不能把字段允许输入的 3600 帧宣称为已验证的长视频能力。
- 参考视频工具提示为 24 fps、2–15 秒。执行逻辑最低接受 5 帧，先截断到本次输出帧数，再向下裁到 `17k + 5`；低于 5 帧报错。工具提示的推荐范围与执行器硬限制应分别表述。
- 此节点音频编码函数未检查独立参考音频或配对声音的最短/最长秒数，也没有将配对声音自动裁到视频参考裁剪后的长度。前处理需保持配对片段同步，不能宣称存在已核实的 15 秒音频硬上限。
- `width`、`height` 字段步长 32；默认 1344×768。`ref_image_size="match"` 按生成像素面积等比缩小参考图，不主动放大；`"max"` 按短边 2048 的规则缩小，可能增加参考 token 及耗时。此处不是原工作流 `ResolutionSelector` 的完整计算规则。

以上均来自 [v0.33.0 H3 的 schema、`temporal_shape()`、`execute()` 与 `_encode_ref_audio()`](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_minimax_h3.py)。节点源码的范围不是显存、运行耗时或 RunningHub 平台成功执行的保证。

## 提示词标签与顺序

提示词使用 `<Picture 1>`、`<Video 1>`、`<Audio 1>` 等**从 1 开始编号**的标签；这与零开始的 API 字段后缀不同。H3 依次处理图片、视频、独立音频；带声音的视频先给声音分配一个 `<Audio j>`，再给视频分配 `<Video k>`。因此存在一个带声音的视频时，第一条独立音频是 `<Audio 2>`。声音端口通过相同数字后缀与视频匹配，孤立的 `ref_video_audio_N` 没有相应视频就不会被此循环消费。[H3 源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_minimax_h3.py)

后端应按用户确定的同类素材顺序连续生成键，提示词标签与该顺序共同保存到任务输入快照。不要将原图的参考素材保留成用户未提供时的默认素材。

## 可审阅的 API JSON 扩展示例

以下是原创的**局部图替换示意**：保留原图其他节点，替换节点 136 并添加示例加载节点。文件名占位符应替换为上传后经平台确认可用的文件标识；不是可直接发送的完整 RunningHub HTTP 请求，也未运行验证。视频示例假设上传前已规范化为 24 fps。

本示例直接给 `136.inputs.prompt` 赋值。另一种方式是保留原来的 `["238", 0]` 连线，更新 `238.inputs.value`；两者二选一。若已改为直接赋值，再更新 238 不会改变该节点收到的提示词。

```json
{
  "300": {"class_type": "LoadImage", "inputs": {"image": "<uploaded-image-file>"}},
  "310": {"class_type": "LoadVideo", "inputs": {"file": "<uploaded-24fps-video-file>"}},
  "311": {"class_type": "GetVideoComponents", "inputs": {"video": ["310", 0]}},
  "320": {"class_type": "LoadAudio", "inputs": {"audio": "<uploaded-audio-file>"}},
  "136": {
    "class_type": "MiniMaxH3ReferenceToVideo",
    "inputs": {
      "clip": ["232", 0],
      "vae": ["234", 0],
      "audio_vae": ["235", 0],
      "prompt": "保持 <Picture 1> 的人物特征，参考 <Video 1> 的动作。参考 <Audio 1> 的环境声音和 <Audio 2> 的音色。",
      "width": ["228", 0],
      "height": ["228", 1],
      "length": ["224", 1],
      "ref_image_size": "match",
      "ref_images.ref_image_0": ["300", 0],
      "ref_videos.ref_video_0": ["311", 0],
      "ref_video_audios.ref_video_audio_0": ["311", 1],
      "ref_audios.ref_audio_0": ["320", 0]
    }
  }
}
```

若视频没有声音，或用户不使用其声音，不添加 `ref_video_audios.ref_video_audio_0`；此时第一条独立音频变为 `<Audio 1>`，提示词也应随之对应。

使用 VHS 重采样的替代加载节点如下；将节点 136 的视频连接改为 `["310", 0]`，配对声音连接改为 `["310", 2]`，不再使用 311。此示例的 `frame_load_cap: 0` 表示不在加载器中限制帧数，正式接入应按已确认的素材范围处理长视频，避免先加载整段再裁剪。

```json
{
  "310": {
    "class_type": "VHS_LoadVideo",
    "inputs": {
      "video": "<uploaded-video-file>",
      "force_rate": 24,
      "custom_width": 0,
      "custom_height": 0,
      "frame_load_cap": 0,
      "skip_first_frames": 0,
      "select_every_nth": 1
    }
  }
}
```

增加图片时为每张图创建单独加载节点并依次连接到 `ref_images.ref_image_1` 至 `_8`；视频与独立音频同理，分别最多到 `_2`。未使用的参考输入直接省略。

## RunningHub 上传与提交协议

官方现有协议可用于构造以下流程；本文未实际上传或提交：

1. 使用 `POST /task/openapi/upload`，multipart 字段为 `apiKey`、`file`、`fileType=input`，文档示例同时带 `Authorization: Bearer ...`。成功后检查 `code === 0` 并读取 `data.fileName`；它是平台内部文件标识，写入加载节点的 `image`、`file`、`video` 或 `audio` 字段，不能据此自行拼接公开预览 URL。文档列出 JPG、PNG、JPEG、WEBP；MP3、WAV、FLAC；MP4、AVI、MOV、MKV。正文写 30 MB，但错误示例仍残留 10 MB，实际大小限制未实测。[官方上传接口](https://www.runninghub.ai/runninghub-api-doc-en/api-425761099)
2. 从本地完整图深拷贝，移除原示例参考连接，按当前参考素材及其顺序添加加载节点和点分字段。数值、布尔值保持原生类型。使用 `POST /task/openapi/create`，传入 `workflowId`、`apiKey` 与 **JSON 字符串类型**的 `workflow`；官方高级调用文档说明该字段覆盖 workflowId 对应图，因而可以表达新增节点和连接。`nodeInfoList` 用于按字段覆盖，不能只凭修改现有图片文件名来实现新增的视频/音频节点。[官方高级调用接口](https://www.runninghub.ai/runninghub-api-doc-en/api-425761093)
3. 保存返回的 `taskId`，检查节点验证信息，再通过任务输出接口查询状态和产物。仅运行完成事件不足以确定最终产物，仍须确认结果列表中的文件地址；一个图可以有多个保存节点。查询与恢复不重新提交图。[官方完整集成示例](https://www.runninghub.ai/runninghub-api-doc-en/doc-8287472)、[官方任务进度示例](https://www.runninghub.ai/runninghub-api-doc-en/doc-8287471)

请求体结构示意如下。`buildReferenceGraph`、`submit` 和 `persistTaskId` 为说明步骤的伪函数，不是已实现或已实测的 SDK：

```js
const graph = buildReferenceGraph(structuredClone(template), uploadedReferences);
const request = {
  apiKey: serverSideApiKey,
  workflowId: "2116745173157138433",
  workflow: JSON.stringify(graph),
  nodeInfoList: []
};
const response = await submit("/task/openapi/create", request);
// 检查响应与节点错误；确认成功后持久化平台任务 ID，再查询同一任务。
await persistTaskId(response.data.taskId);
```

平台凭据只在后端使用。由于尚未远端运行，上述协议文档支持不等于本地完整图已通过平台节点/模型/文件校验。

RunningHub 通用素材说明中使用的 `LoadVideo.video` 字段不能直接套到此处核心节点：已核实的 ComfyUI v0.33.0 `LoadVideo` 实际字段为 `file`，`VHS_LoadVideo` 的字段才是 `video`。加载节点类名、字段与输出索引应以所用节点版本源码或远端实际 schema 为准。[核心视频源码](https://github.com/Comfy-Org/ComfyUI/blob/v0.33.0/comfy_extras/nodes_video.py)、[VHS 加载源码](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite/blob/4ee72c065db22c9d96c2427954dc69e7b908444b/videohelpersuite/load_video_nodes.py)

## 仍需远端验证

1. 指定 workflow ID 当前图与本地导出的对应关系、远端 ComfyUI/插件版本，以及平台对完整图的接受方式。
2. 图片、视频、音频上传返回值能否被各加载节点直接读取，尤其含目录的文件标识。
3. 无声音视频、带声音视频、独立参考音频及混合参考任务；24 fps 规范化后声音与画面是否同步。
4. 最大参考数量、素材体积/时长、不同生成尺寸在目标实例上的实际可运行范围。本文不以源码 schema 替代这些验证。
