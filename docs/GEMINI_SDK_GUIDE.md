# Gemini SDK 集成指南

使用 Google 官方 `@google/genai` SDK 集成 Gemini API。

## 快速开始

### 1. 安装依赖

```bash
pnpm add @google/genai
```

### 2. 配置 API Key

1. 访问 [Google AI Studio](https://aistudio.google.com/app/apikey) 获取 API Key
2. 创建 `.env.local` 文件：

```bash
GEMINI_API_KEY=your_api_key_here
```

3. 重启开发服务器

### 3. 测试接口

访问测试页面：http://localhost:3000/test-gemini

或使用 API：

```bash
curl -X POST http://localhost:3000/api/test/gemini \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3.8-flash",
    "prompt": "Explain how AI works in a few words"
  }'
```

## 可用模型

以下为 2026-11-03 核对的项目内置选项，来源：[Google 官方模型目录](https://ai.google.dev/gemini-api/docs/models)。

### 文本生成模型

| 模型名称               | Model ID                 | 特点               |
| ---------------------- | ------------------------ | ------------------ |
| Gemini 3.8 Flash       | `gemini-3.8-flash`       | 通用文本生成 |
| Gemini 4 Argon         | `gemini-4-argon`         | 复杂推理 |
| Gemini 3 Flash Preview | `gemini-3-flash-preview` | 保留的旧文本选项 |

### 图片生成模型

| 模型名称        | Model ID                     | 特点                   |
| --------------- | ---------------------------- | ---------------------- |
| Nano Banana 2.1 | `gemini-nano-banana-2.1` | 图片生成与编辑 |
| Nano Banana Pro | `gemini-3-pro-image` | 稳定版，专业图片生成 |
| Nano Banana 2 | `gemini-3.1-flash-image` | 图片生成与多图参考 |
| Nano Banana | `gemini-2.5-flash-image` | 保留旧项目使用的型号 |

### 视频生成模型

| 模型名称                 | Model ID                   | 特点     |
| ------------------------ | -------------------------- | -------- |
| Veo 3.1 Generate Preview | `veo-3.1-generate-preview` | 视频生成 |

## 使用示例

### 基础文本生成

```typescript
import { generateGeminiText } from "@/lib/ai-services/text/gemini";

const text = await generateGeminiText(
  "gemini-3.8-flash",
  "Explain how AI works",
);
console.log(text);
```

### 流式生成

```typescript
import { streamGeminiText } from "@/lib/ai-services/text/gemini";

await streamGeminiText("gemini-3.8-flash", "Write a story", (chunk) => {
  process.stdout.write(chunk);
});
```

## 下一步

### 图片生成（Nano Banana）

使用项目的图片生成服务：

```typescript
import { generateGeminiImage } from "@/lib/ai-services/image/gemini";

const image = await generateGeminiImage(
  "gemini-nano-banana-2.1", "A serene mountain landscape", "16:9", "2K",
);
```

### 多模态输入

支持文本 + 图片混合输入：

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const response = await ai.models.generateContent({
  model: "gemini-3.8-flash",
  contents: [
    { text: "What's in this image?" },
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: base64ImageData,
      },
    },
  ],
});
```

## 优势

✅ **简单易用** - 官方 SDK，无需手动构建请求  
✅ **类型安全** - 完整的 TypeScript 支持  
✅ **自动重试** - 内置错误处理和重试机制  
✅ **流式支持** - 原生支持流式响应  
✅ **统一接口** - 文本、图片、多模态统一 API

## 相关资源

- [Google GenAI SDK 文档](https://ai.google.dev/gemini-api/docs/quickstart)
- [获取 API Key](https://aistudio.google.com/app/apikey)
- [模型列表](https://ai.google.dev/gemini-api/docs/models/gemini)
- [定价说明](https://ai.google.dev/pricing)
