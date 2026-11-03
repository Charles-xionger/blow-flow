# AI 模型配置说明

本项目支持多种 AI 模型，分为两类：

## 1. Gemini 模型（自动配置）

这些模型使用 Google GenAI SDK，只需配置 `GEMINI_API_KEY` 环境变量即可使用，**无需在前端配置**。

文本和图片目录于 2026-11-03 按 [Google 官方模型目录](https://ai.google.dev/gemini-api/docs/models) 更新。以下是本项目内置的选项，并非 Google 的完整模型清单。

### 文本模型

- **Gemini 3.8 Flash** (`gemini-3.8-flash`) - 通用文本生成，分镜自动选择时使用
- **Gemini 4 Argon** (`gemini-4-argon`) - 复杂推理
- **Gemini 3.5 Flash-Lite** (`gemini-3.5-flash-lite`) - 低延迟、低成本
- **Gemini 3 Flash Preview** (`gemini-3-flash-preview`) - 保留的旧文本选项
- **Gemini 3.1 Flash-Lite** (`gemini-3.1-flash-lite`) - 低成本的旧文本选项

旧项目中的 Gemini 3 Flash Preview 保持原型号。已从目录移除的 Gemini 2.5 Pro 和已停用的 Gemini 3 Pro Preview 在文本选择器中显示为 Gemini 3.8 Flash，保存的项目数据不作批量改写。

### 图片模型

- **Nano Banana 2.1** (`gemini-nano-banana-2.1`) - 新版图片生成与编辑
- **Nano Banana Pro** (`gemini-3-pro-image`) - 稳定版，专业图片生成
- **Nano Banana 2** (`gemini-3.1-flash-image`) - 图片生成与多图参考
- **Nano Banana** (`gemini-2.5-flash-image`) - 保留旧项目使用的型号

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

- **通用任务**：Gemini 3.8 Flash
- **复杂推理**：Gemini 4 Argon
- **成本优先**：Gemini 3.5 Flash-Lite

### 图片生成

- **通用生成与编辑**：Nano Banana 2.1
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
