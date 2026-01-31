# AI 模型配置说明

本项目支持多种 AI 模型，分为两类：

## 1. Gemini 模型（自动配置）

这些模型使用 Google GenAI SDK，只需配置 `GEMINI_API_KEY` 环境变量即可使用，**无需在前端配置**。

### 文本模型

- **Gemini 2.5 Pro** (`gemini-2.5-pro`) - 高质量，推理能力强
- **Gemini 3 Flash Preview** (`gemini-3-flash-preview`) - 最新预览版，速度快
- **Gemini 3 Pro Preview** (`gemini-3-pro-preview`) - 最新预览版，高质量

### 图片模型

- **Nano Banana** (`gemini-2.5-flash-image`) - 快速图片生成
- **Nano Banana Pro** (`gemini-3-pro-image-preview`) - 高保真文本渲染，专业级

### 视频模型

- **Veo 3.1 Generate Preview** (`veo-3.1-generate-preview`) - 视频生成

### 配置方式

在 `.env.local` 中添加：

```bash
GEMINI_API_KEY=your_gemini_api_key_here
```

获取 API Key：https://aistudio.google.com/app/apikey

## 2. 其他模型（需要手动配置）

这些模型需要在前端 **API 设置** 中手动配置 Base URL、API Key 等信息。

### 图片模型

- **Banana Pro** - 图片生成
- **Flux 2** - 图片生成

### 视频模型

- **Sora 2** - 视频生成
- **Kling** - 视频生成
- **MiniMax** - 视频生成

### 配置方式

1. 点击右上角 **API 设置** 按钮
2. 添加模型配置
3. 填写 Base URL、API Key、Endpoint 等信息

## 添加自定义模型

### 方式 1：添加到内置列表（推荐）

编辑 `lib/model-registry.ts` 文件，在 `BUILTIN_MODELS` 中添加：

```typescript
"Your Model Name": {
  id: "your-model-id",
  name: "Your Model Name",
  category: "IMAGE" | "VIDEO" | "TEXT",
  defaultEndpoint: "/your/endpoint",
  provider: "gemini" | undefined, // gemini 表示使用 Gemini SDK
},
```

### 方式 2：通过前端添加

1. 打开 API 设置
2. 点击添加自定义模型
3. 填写模型信息
4. 保存到本地数据库

## 模型选择建议

### 文本生成

- **速度优先**：Gemini 3 Flash Preview
- **质量优先**：Gemini 2.5 Pro

### 图片生成

- **速度优先**：Nano Banana
- **质量优先**：Nano Banana Pro（支持高保真文本）

### 视频生成

- **推荐**：Veo 3.1 Generate Preview

## 注意事项

1. **Gemini 模型**无需前端配置，API Key 统一从环境变量读取
2. **其他模型**需要单独配置 API Key 和服务地址
3. 模型配置保存在本地 SQLite 数据库中
4. 建议将敏感信息（API Key）存储在 `.env.local` 中，不要提交到代码仓库

## 相关文档

- [Gemini SDK 使用指南](./GEMINI_SDK_GUIDE.md)
- [Google AI Studio](https://aistudio.google.com/)
- [Gemini API 文档](https://ai.google.dev/gemini-api/docs)
