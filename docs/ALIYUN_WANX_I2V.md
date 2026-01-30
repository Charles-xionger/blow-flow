# 阿里云通义万相 wan2.6-i2v 模型集成指南

## 概述

wan2.6-i2v 是阿里云通义万相的图生视频模型，支持以下特性：

- **多镜头叙事**：支持生成包含多个镜头的视频
- **音频能力**：支持自动配音或传入自定义音频文件
- **高质量输出**：支持 720P、1080P 分辨率
- **灵活时长**：支持 2-15 秒视频生成

## 支持的模型

- **wan2.6-i2v-flash**（推荐）：极速版，速度更快
- **wan2.6-i2v**：标准版，质量更高
- **wan2.5-i2v-preview**：预览版
- **wan2.2-i2v-flash/plus**：旧版模型

## 配置步骤

### 1. 获取 API Key

访问 [阿里云百炼平台](https://bailian.console.aliyun.com/) 获取 API Key：

- 北京地域：https://bailian.console.aliyun.com/cn-beijing
- 新加坡地域：https://modelstudio.console.aliyun.com/ap-southeast-1

### 2. 配置环境变量

在 `.env.local` 文件中添加：

```bash
# 北京地域（推荐）
ALIYUN_WANX_BASE_URL=https://dashscope.aliyuncs.com
ALIYUN_WANX_API_KEY=sk-your-api-key-here

# 新加坡地域（如需要）
# ALIYUN_WANX_BASE_URL=https://dashscope-intl.aliyuncs.com
# ALIYUN_WANX_API_KEY=sk-your-singapore-api-key-here
```

⚠️ **注意**：北京和新加坡地域的 API Key 不同，不可混用。

### 3. 在画布中使用

1. 拖入"图生视频"节点
2. 上传或连接输入图像
3. 选择模型：`wan2.6-i2v-flash` 或 `wan2.6-i2v`
4. 配置参数：
   - **分辨率**：720P、1080P
   - **时长**：2-15 秒
   - **提示词优化**：自动改写提示词
   - **水印**：是否添加水印

## API 使用示例

### 基础调用

```typescript
const response = await fetch("/api/generate/image-to-video", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "wan2.6-i2v-flash",
    inputImage: "https://example.com/image.jpg",
    prompt: "一只猫在草地上奔跑",
    duration: 10,
    resolution: "720P",
    promptOptimize: true,
  }),
});

const result = await response.json();
console.log("Video URL:", result.data);
```

### 高级功能

#### 1. 自动配音

```typescript
{
  model: 'wan2.6-i2v-flash',
  inputImage: 'https://example.com/image.jpg',
  prompt: '一个人在唱歌',
  duration: 10,
  // 不传 audioUrl，模型会自动配音
}
```

#### 2. 自定义音频

```typescript
{
  model: 'wan2.6-i2v-flash',
  inputImage: 'https://example.com/image.jpg',
  prompt: '一个人在跳舞',
  audioUrl: 'https://example.com/music.mp3',
  duration: 10,
}
```

#### 3. 多镜头视频

```typescript
{
  model: 'wan2.6-i2v-flash',
  inputImage: 'https://example.com/image.jpg',
  prompt: '一个精彩的故事',
  shotType: 'multi', // 启用多镜头
  promptOptimize: true, // 必须启用
  duration: 10,
}
```

#### 4. 反向提示词

```typescript
{
  model: 'wan2.6-i2v-flash',
  inputImage: 'https://example.com/image.jpg',
  prompt: '美丽的风景',
  negativePrompt: '模糊,低质量,失真',
  duration: 10,
}
```

## 参数说明

| 参数           | 类型    | 默认值           | 说明                               |
| -------------- | ------- | ---------------- | ---------------------------------- |
| model          | string  | wan2.6-i2v-flash | 模型名称                           |
| inputImage     | string  | -                | 输入图像 URL（必填）               |
| prompt         | string  | -                | 文本提示词（可选，最长 1500 字符） |
| duration       | number  | 10               | 视频时长（2-15 秒）                |
| resolution     | string  | 720P             | 分辨率（720P、1080P）              |
| promptOptimize | boolean | false            | 是否启用提示词智能改写             |
| watermark      | boolean | false            | 是否添加水印                       |
| audioUrl       | string  | -                | 自定义音频 URL（可选）             |
| negativePrompt | string  | -                | 反向提示词（可选）                 |
| shotType       | string  | -                | 镜头类型（single、multi）          |

## 输入图像要求

支持三种方式：

1. **公网 URL**

   ```typescript
   inputImage: "https://example.com/image.jpg";
   ```

2. **Base64 编码**

   ```typescript
   inputImage: "data:image/png;base64,iVBORw0KGgo...";
   ```

3. **本地文件**（仅限 SDK）
   ```typescript
   inputImage: "file:///path/to/image.jpg";
   ```

支持的格式：JPG、PNG、WEBP
图像要求：建议长宽都在 128-2048 像素之间

## 计费说明

- 按成功生成的**视频秒数**计费
- 仅当任务成功（task_status=SUCCEEDED）时计费
- 失败或处理错误不产生费用
- 不同分辨率价格不同：1080P > 720P > 480P

查看详细价格：https://help.aliyun.com/zh/model-studio/models

## 使用限制

1. **时效限制**
   - task_id 有效期：24 小时
   - 视频 URL 有效期：24 小时
   - 建议立即下载并转存

2. **内容审核**
   - 输入内容和输出视频都会进行安全审核
   - 违规内容会返回错误

3. **频率限制**
   - 创建任务：QPS 限制，详见官方文档
   - 查询任务：默认 QPS 20

4. **网络访问**
   - 视频存储在阿里云 OSS
   - 如有安全策略限制，需将 OSS 域名加入白名单

## 常见问题

### Q: 如何生成特定宽高比的视频？

输出视频的宽高比由输入图像决定。模型会根据 resolution 参数将图像适配到合法分辨率（长宽必须能被 16 整除），可能存在微小偏差。

建议：使用与目标比例一致的输入图像，或对输出视频进行后处理裁剪。

### Q: 视频生成需要多长时间？

通常 1-5 分钟，具体取决于：

- 队列中的任务数量
- 选择的模型（flash 版本更快）
- 视频时长和分辨率

### Q: 如何处理超时？

默认轮询 10 分钟。如果超时：

1. 检查网络连接
2. 确认 API Key 正确
3. 查看控制台日志
4. 联系技术支持

### Q: 支持哪些音频格式？

支持 MP3、WAV 等常见格式，音频文件需要可公网访问。

## 相关链接

- [API 参考文档](https://help.aliyun.com/zh/model-studio/image-to-video-api-reference)
- [模型列表与价格](https://help.aliyun.com/zh/model-studio/models)
- [在线体验](https://tongyi.aliyun.com/wan/generate/video/image-to-video)
- [常见问题](https://help.aliyun.com/zh/model-studio/text-to-video-api-reference#c928ee689aw6l)

## 技术支持

如遇问题，请：

1. 查看控制台日志
2. 检查环境变量配置
3. 参考官方文档
4. 提交 Issue 到项目仓库
