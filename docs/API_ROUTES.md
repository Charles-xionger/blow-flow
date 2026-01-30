# API Routes 使用指南

## 环境配置

1. 复制环境变量模板：

```bash
cp .env.example .env.local
```

2. 编辑 `.env.local` 文件，填入实际的 API 配置：

```env
DEFAULT_BASE_URL=https://your-api-endpoint.com/v1
DEFAULT_API_KEY=your-actual-api-key
```

## API 端点列表

### 1. 图片生成 `/api/generate/image`

生成文本到图片

**请求示例：**

```bash
curl -X POST http://localhost:3000/api/generate/image \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a beautiful sunset over mountains",
    "modelKey": "flux",
    "count": 1
  }'
```

**响应格式：**

```json
{
  "results": [
    {
      "url": "https://example.com/image.jpg",
      "error": null
    }
  ]
}
```

### 2. 视频生成 `/api/generate/video`

生成文本到视频

**请求示例：**

```bash
curl -X POST http://localhost:3000/api/generate/video \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a cat playing with a ball",
    "modelKey": "kling",
    "count": 1
  }'
```

### 3. 图片到图片 `/api/generate/image-to-image`

基于输入图片生成新图片

**请求示例：**

```bash
curl -X POST http://localhost:3000/api/generate/image-to-image \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "make it oil painting style",
    "inputImage": "https://example.com/input.jpg",
    "modelKey": "flux",
    "count": 1
  }'
```

### 4. 图片到视频 `/api/generate/image-to-video`

将静态图片转换为动态视频

**请求示例：**

```bash
curl -X POST http://localhost:3000/api/generate/image-to-video \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "animate this image with gentle movements",
    "inputImage": "https://example.com/input.jpg",
    "modelKey": "kling",
    "count": 1
  }'
```

### 5. 首尾帧到视频 `/api/generate/start-end-to-video`

使用开始和结束帧生成视频

**请求示例：**

```bash
curl -X POST http://localhost:3000/api/generate/start-end-to-video \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "smooth transition between frames",
    "startImage": "https://example.com/start.jpg",
    "endImage": "https://example.com/end.jpg",
    "modelKey": "kling",
    "count": 1
  }'
```

### 6. 提示词优化 `/api/optimize`

使用 AI 优化提示词

**请求示例：**

```bash
curl -X POST http://localhost:3000/api/optimize \
  -H "Content-Type: application/json" \
  -d '{
    "originalPrompt": "cat",
    "task": "image"
  }'
```

**响应格式：**

```json
{
  "optimizedPrompt": "a photorealistic image of a fluffy orange tabby cat with bright green eyes..."
}
```

## 错误处理

所有 API 都遵循统一的错误响应格式：

```json
{
  "error": "错误信息描述"
}
```

常见错误码：

- `400`: 请求参数错误
- `500`: 服务器内部错误

## 在节点中集成

### 示例：TextToImageNode 调用图片生成 API

```typescript
const handleGenerate = async () => {
  setLoading(true);
  try {
    const response = await fetch("/api/generate/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: data.prompt,
        modelKey: data.selectedModel,
        count: 1,
      }),
    });

    if (!response.ok) {
      throw new Error("Generation failed");
    }

    const result = await response.json();
    if (result.results[0]?.url) {
      updateNodeData(id, {
        generatedImage: result.results[0].url,
        error: null,
      });
    } else if (result.results[0]?.error) {
      throw new Error(result.results[0].error);
    }
  } catch (err) {
    updateNodeData(id, {
      error: err instanceof Error ? err.message : "Unknown error",
    });
  } finally {
    setLoading(false);
  }
};
```

## 开发测试流程

1. **启动开发服务器：**

```bash
npm run dev
```

2. **测试单个端点：**
   使用上面的 curl 命令测试每个端点

3. **查看日志：**
   开发服务器会显示详细的请求日志和错误信息

4. **在浏览器中测试：**
   打开 http://localhost:3000，在节点中测试实际功能

## 生产部署注意事项

1. **环境变量：**
   - 确保在 Vercel/生产环境中设置所有必需的环境变量
   - 不要将 `.env.local` 提交到版本控制

2. **API 密钥安全：**
   - API 密钥只在服务器端使用，不会暴露给客户端
   - 定期轮换 API 密钥

3. **超时配置：**
   - 视频生成可能需要较长时间（最多 15 分钟）
   - 确保部署平台支持长时间运行的函数（Vercel Pro 支持 5 分钟）

4. **数据库集成：**
   - 后续将实现 SQLite 数据库存储模型配置
   - 参考 `05-SQLite存储.md` 文档

## TODO

当前实现使用环境变量存储模型配置。后续需要：

- [ ] 实现 `getModelConfig()` 从数据库读取配置
- [ ] 创建模型配置管理界面
- [ ] 添加请求日志和监控
- [ ] 实现缓存机制优化性能
