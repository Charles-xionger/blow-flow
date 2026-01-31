# Google Gemini 集成指南

本文档介绍如何配置和使用 Google Gemini 系列服务，包括文本生成、图片生成和视频生成。

## 功能特性

### 文本生成 (Gemini 3)

- ✅ Gemini 3 Pro - 最智能的推理模型
- ✅ Gemini 3 Flash - Pro级智能，Flash速度
- ✅ Gemini 2.5 Pro - 上一代旗舰模型
- ✅ 动态思考模式 (Dynamic Thinking)
- ✅ 100万 token 上下文窗口
- ✅ 使用 `@google/genai` SDK

### 图片生成 (Imagen 3)

- ✅ Imagen 3 标准版 - 高质量图片生成
- ✅ Imagen 3 Fast - 快速图片生成
- ✅ 多种宽高比支持 (1:1, 16:9, 9:16, 4:3, 3:4)
- ✅ 安全过滤和内容审核
- ✅ Base64 格式输出

### 视频生成 (Veo 3.1)

- ✅ Veo 3.1 Generate Preview - 最新视频生成模型
- ✅ 文本生成视频 (Text-to-Video)
- ✅ 图片生成视频 (Image-to-Video)

## 模型选择

### Gemini 3 文本模型

系统内置以下 Gemini 文本模型，无需在设置中配置，只需设置环境变量：

| 模型名称               | Model ID                 | 特点                       | 定价 (每百万token) |
| ---------------------- | ------------------------ | -------------------------- | ------------------ |
| Gemini 3 Pro Preview   | `gemini-3-pro-preview`   | 最智能，适合复杂推理任务   | $2 / $12           |
| Gemini 3 Flash Preview | `gemini-3-flash-preview` | Pro级智能，Flash速度和价格 | $0.50 / $3         |
| Gemini 2.5 Pro         | `gemini-2.5-pro`         | 上一代旗舰模型             | 详见定价页面       |

### Imagen 3 图片模型

系统提供两个 Imagen 模型：

| 模型名称             | Model ID                       | 特点                   |
| -------------------- | ------------------------------ | ---------------------- |
| Gemini Imagen 3      | `imagen-3.0-generate-001`      | 最高质量，生成速度较慢 |
| Gemini Imagen 3 Fast | `imagen-3.0-fast-generate-001` | 快速生成，质量稍低     |

### Veo 3.1 视频模型

| 模型名称                 | Model ID                   | 特点             |
| ------------------------ | -------------------------- | ---------------- |
| Veo 3.1 Generate Preview | `veo-3.1-generate-preview` | 最新视频生成模型 |

## 配置步骤

### 方式一：使用 Google GenAI SDK（推荐 - 用于文本和视频生成）

这是最简单的方式，适用于 Gemini 3 文本模型和 Veo 3.1 视频模型。

#### 1. 获取 API Key

1. 访问 [Google AI Studio](https://aistudio.google.com/apikey)
2. 点击 "Get API Key" 创建新的 API 密钥
3. 复制生成的 API Key

#### 2. 设置环境变量

在项目根目录创建或编辑 `.env.local` 文件：

```bash
# Google Gemini API Key
GOOGLE_API_KEY=your_api_key_here
# 或者
GEMINI_API_KEY=your_api_key_here
```

#### 3. 在前端选择模型

系统已内置 Gemini 3 文本模型，无需在设置中配置：

- **AI 分镜师节点**：可选择 Gemini 3 Pro Preview、Gemini 3 Flash Preview 或 Gemini 2.5 Pro
- **文生视频节点**：自动使用 Veo 3.1 Generate Preview
- **图生视频节点**：自动使用 Veo 3.1 Generate Preview

### 方式二：使用 Vertex AI（用于 Imagen 图片生成）

如果需要使用 Imagen 图片生成，需要配置 Vertex AI。

#### 1. 获取 Google Cloud API 密钥

1. 访问 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建或选择一个项目
3. 启用 **Vertex AI API**
4. 创建服务账号并下载 JSON 密钥文件
5. 或使用 OAuth 2.0 获取访问令牌

#### 2. 在系统中配置 Imagen 模型

打开 AI Flow 应用，点击右上角 **API 设置** 按钮：

##### 配置 Imagen 3（标准版）

- **模型名称**: Gemini Imagen 3
- **Model ID**: `imagen-3.0-generate-001`
- **Base URL**: `https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1`
- **API Key**: 你的 Bearer Token 或服务账号密钥
- **Endpoint**: `publishers/google/models/imagen-3.0-generate-001:predict`

##### 配置 Imagen 3 Fast（快速版）

- **模型名称**: Gemini Imagen 3 Fast
- **Model ID**: `imagen-3.0-fast-generate-001`
- **Base URL**: `https://us-central1-aiplatform.googleapis.com/v1/projects/YOUR_PROJECT_ID/locations/us-central1`
- **API Key**: 你的 Bearer Token 或服务账号密钥
- **Endpoint**: `publishers/google/models/imagen-3.0-fast-generate-001:predict`

#### 3. 替换 PROJECT_ID

在 Base URL 中，将 `YOUR_PROJECT_ID` 替换为你的 Google Cloud 项目 ID。

例如：

```
https://us-central1-aiplatform.googleapis.com/v1/projects/my-ai-project-123456/locations/us-central1
```

## 使用方式

### 使用 AI 分镜师生成分镜（文本生成）

1. 添加 **AI 分镜师** 节点到画布
2. 在下拉菜单中选择模型：
   - **Gemini 3 Pro Preview** - 最智能，适合复杂故事
   - **Gemini 3 Flash Preview** - 快速生成，性价比高
   - **Gemini 2.5 Pro** - 上一代旗舰模型
3. 输入故事或场景描述
4. 调整镜头数量（2-8个）
5. 点击"生成分镜"按钮
6. 生成后可以批量创建图片或视频节点

**SDK 实现示例**：

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "将这个故事拆分成5个镜头...",
});

console.log(response.text);
```

### 使用视频生成（Veo 3.1）

系统自动使用 Veo 3.1 模型，无需手动配置：

1. **文生视频**：添加文生视频节点，输入提示词
2. **图生视频**：添加图生视频节点，连接图片输入

**SDK 实现示例**：

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// 文本生成视频
const response = await ai.models.generateVideos({
  model: "veo-3.1-generate-preview",
  prompt: "A serene mountain landscape at sunset",
});

// 等待生成完成
await response.wait();

// 下载视频
const video = await ai.files.download(response.file.uri);
```

### 在文生图节点中使用 Imagen

1. 添加 **文生图** 节点到画布
2. 在节点配置中选择 **Gemini Imagen 3** 或 **Gemini Imagen 3 Fast**
3. 输入提示词（支持中英文）
4. 选择宽高比和分辨率
5. 点击生成按钮

### 支持的参数

- **提示词 (Prompt)**: 描述你想生成的图片内容
- **宽高比 (Aspect Ratio)**:
  - `1:1` - 正方形
  - `16:9` - 横向宽屏
  - `9:16` - 竖向宽屏
  - `4:3` - 横向标准
  - `3:4` - 竖向标准
- **负面提示词 (Negative Prompt)**: 不想在图片中出现的内容（可选）

## API 认证说明

### Google GenAI SDK（推荐）

**适用于**：Gemini 3 文本模型、Veo 3.1 视频模型

**优点**：

- ✅ 配置简单，只需一个 API Key
- ✅ 免费获取，在 AI Studio 直接生成
- ✅ 支持所有最新模型
- ✅ 自动处理认证和重试

**获取方式**：

1. 访问 https://aistudio.google.com/apikey
2. 点击 "Create API Key"
3. 复制并设置到环境变量

### Vertex AI（用于 Imagen）

**适用于**：Imagen 3 图片生成

Gemini Imagen 使用 Google Cloud 的认证系统，有两种方式：

### 方式 1: 使用 Bearer Token (推荐)

```bash
# 获取 Bearer Token
gcloud auth application-default print-access-token
```

将输出的 token 填入 API Key 字段。

**注意**: Bearer Token 会过期（通常 1 小时），需要定期更新。

### 方式 2: 使用服务账号密钥

1. 在 Google Cloud Console 创建服务账号
2. 下载 JSON 密钥文件
3. 使用密钥文件内容生成 JWT token
4. 将 JWT token 填入 API Key 字段

## 常见问题

### Q1: 如何选择使用哪个 Gemini 模型？

**文本生成（分镜）**：

- 简单任务或快速测试：**Gemini 3 Flash Preview**（性价比最高）
- 复杂推理任务：**Gemini 3 Pro Preview**（最智能）
- 稳定性优先：**Gemini 2.5 Pro**（上一代旗舰）

**图片生成**：

- 最高质量：**Imagen 3**
- 快速迭代：**Imagen 3 Fast**

**视频生成**：

- 自动使用 **Veo 3.1 Generate Preview**

### Q2: Google GenAI SDK 和 Vertex AI 有什么区别？

**Google GenAI SDK** (`@google/genai`):

- 简单易用，适合快速开发
- 免费获取 API Key
- 支持最新模型（Gemini 3、Veo 3.1）
- 适合文本和视频生成

**Vertex AI**:

- 需要 Google Cloud 项目
- 按使用量付费
- 主要用于 Imagen 图片生成
- 企业级功能和支持

### Q3: 为什么前端不需要配置 Gemini 文本模型？

系统已经在 `model-registry.ts` 中内置了 Gemini 3 系列模型的定义。只要设置了环境变量 `GOOGLE_API_KEY`，前端就可以直接选择使用，后端会自动调用 Google GenAI SDK。

### Q4: 提示 "API Key missing" 错误

**原因**: 未设置 Google API Key 环境变量

**解决方案**:

1. 在项目根目录创建 `.env.local` 文件
2. 添加 `GOOGLE_API_KEY=your_api_key_here`
3. 重启开发服务器

### Q5: 提示 "403 Forbidden" 错误（Vertex AI）

**原因**: Vertex AI API Key 无效或项目未启用 Vertex AI API

**解决方案**:

1. 确认已启用 Vertex AI API
2. 检查 Bearer Token 是否过期
3. 确认服务账号有相应权限

### Q6: 提示 "内容被过滤"

**原因**: 提示词包含不当内容，被安全过滤器拦截

**解决方案**:

1. 修改提示词，避免敏感内容
2. 使用更加中性的描述
3. 查看错误信息中的具体原因

### Q7: 生成速度较慢

**解决方案**:

1. 文本生成：使用 **Gemini 3 Flash Preview**
2. 图片生成：使用 **Imagen 3 Fast** 模型
3. 减小图片尺寸
4. 优化提示词长度

### Q8: 内容质量不理想

**解决方案**:

1. 文本生成：使用 **Gemini 3 Pro Preview**
2. 图片生成：使用 **Imagen 3** 标准版
3. 使用更详细的提示词
4. 添加风格描述（如 "photorealistic", "digital art" 等）
5. 使用负面提示词排除不想要的元素

## 定价说明

### Google GenAI SDK 定价

**Gemini 3 文本模型**（每百万 token）：

- **Gemini 3 Pro Preview**: 输入 $2 / 输出 $12（<200k tokens）
- **Gemini 3 Flash Preview**: 输入 $0.50 / 输出 $3（免费层可用）
- **Gemini 2.5 Pro**: 查看 [定价页面](https://ai.google.dev/pricing)

**Veo 3.1 视频生成**：

- 按视频生成次数计费
- 详见 [定价页面](https://ai.google.dev/pricing)

### Vertex AI 定价

**Google Imagen**（按生成的图片数量计费）：

- **Imagen 3**: $0.04 per image
- **Imagen 3 Fast**: $0.02 per image

详细定价请查看 [Google Cloud Pricing](https://cloud.google.com/vertex-ai/pricing)

## 技术细节

### Google GenAI SDK

**安装**：

```bash
npm install @google/genai
```

**基本用法**：

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

// 文本生成
const response = await ai.models.generateContent({
  model: "gemini-3-pro-preview",
  contents: "Your prompt here",
});

console.log(response.text);
```

**视频生成**：

```typescript
// 生成视频
const videoResponse = await ai.models.generateVideos({
  model: "veo-3.1-generate-preview",
  prompt: "A serene mountain landscape",
});

// 等待完成
await videoResponse.wait();

// 下载视频
const videoData = await ai.files.download(videoResponse.file.uri);
```

### Vertex AI Imagen API 请求格式

```json
{
  "instances": [
    {
      "prompt": "A serene mountain landscape at sunset"
    }
  ],
  "parameters": {
    "sampleCount": 1,
    "aspectRatio": "16:9",
    "addWatermark": false,
    "safetySetting": "block_some",
    "personGeneration": "allow_adult"
  }
}
```

### API 响应格式

```json
{
  "predictions": [
    {
      "bytesBase64Encoded": "iVBORw0KGgoAAAANS...",
      "mimeType": "image/png"
    }
  ],
  "metadata": {}
}
```

## 相关资源

### Google GenAI SDK

- [官方文档](https://ai.google.dev/gemini-api/docs)
- [Gemini 3 指南](https://ai.google.dev/gemini-api/docs/gemini-3)
- [快速开始](https://ai.google.dev/gemini-api/docs/quickstart)
- [定价信息](https://ai.google.dev/pricing)
- [GitHub - @google/genai](https://github.com/google/generative-ai-js)

### Vertex AI (Imagen)

- [Imagen API 文档](https://cloud.google.com/vertex-ai/docs/generative-ai/image/overview)
- [Vertex AI 控制台](https://console.cloud.google.com/vertex-ai)
- [Google Cloud 定价](https://cloud.google.com/vertex-ai/pricing)
- [安全设置说明](https://cloud.google.com/vertex-ai/docs/generative-ai/image/generate-images#safety-filter)

### 模型信息

- [Gemini 模型列表](https://ai.google.dev/gemini-api/docs/models/gemini)
- [Veo 视频生成](https://ai.google.dev/gemini-api/docs/veo)
- [Imagen 图片生成](https://cloud.google.com/vertex-ai/docs/generative-ai/image/overview)

## 更新日志

- **2026-01-31**: 更新文档，添加 Gemini 3 和新 SDK 支持
  - 新增 Google GenAI SDK (`@google/genai`) 使用说明
  - 添加 Gemini 3 Pro/Flash 模型说明
  - 添加 Veo 3.1 视频生成说明
  - 更新配置步骤和常见问题
- **2026-01-31**: 初始版本，支持 Imagen 3 和 Imagen 3 Fast
