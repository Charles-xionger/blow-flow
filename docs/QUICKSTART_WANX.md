# wan2.6-i2v 模型快速开始

## 1. 配置环境变量

创建 `.env.local` 文件：

```bash
ALIYUN_WANX_BASE_URL=https://dashscope.aliyuncs.com
ALIYUN_WANX_API_KEY=sk-your-api-key-here
```

## 2. 重启开发服务器

```bash
pnpm dev
```

## 3. 在画布中使用

### 方法一：通过 UI 创建节点

1. 从左侧工具栏拖入"图生视频"节点
2. 上传输入图像或连接"原始图像"节点
3. 在节点设置中：
   - 模型：选择 `wan2.6-i2v-flash` 或 `wan2.6-i2v`
   - 提示词：输入视频描述
   - 时长：2-15 秒
   - 分辨率：720P 或 1080P
4. 点击"生成"按钮

### 方法二：通过 API 调用

```typescript
// 在你的代码中
const response = await fetch("/api/generate/image-to-video", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "wan2.6-i2v-flash",
    inputImage: "https://example.com/image.jpg",
    prompt: "一只可爱的猫咪在草地上玩耍",
    duration: 10,
    resolution: "720P",
    promptOptimize: true,
  }),
});

const result = await response.json();

if (result.success) {
  console.log("视频 URL:", result.data);
} else {
  console.error("生成失败:", result.error);
}
```

## 4. 模型对比

| 模型             | 特点           | 推荐场景             |
| ---------------- | -------------- | -------------------- |
| wan2.6-i2v-flash | 速度快，成本低 | 快速预览、批量生成   |
| wan2.6-i2v       | 质量高，细节好 | 最终产出、高质量需求 |

## 5. 常见配置示例

### 基础视频生成

```json
{
  "model": "wan2.6-i2v-flash",
  "inputImage": "https://example.com/image.jpg",
  "prompt": "一个人在跑步",
  "duration": 10,
  "resolution": "720P"
}
```

### 带自定义音频

```json
{
  "model": "wan2.6-i2v-flash",
  "inputImage": "https://example.com/image.jpg",
  "prompt": "一个人在唱歌",
  "audioUrl": "https://example.com/music.mp3",
  "duration": 10
}
```

### 多镜头视频

```json
{
  "model": "wan2.6-i2v-flash",
  "inputImage": "https://example.com/image.jpg",
  "prompt": "一个精彩的故事，包含多个场景",
  "shotType": "multi",
  "promptOptimize": true,
  "duration": 15,
  "resolution": "1080P"
}
```

## 6. 注意事项

- ⏱️ 生成通常需要 1-5 分钟
- 📹 视频 URL 有效期 24 小时，请及时下载
- 💰 按视频秒数计费，分辨率越高价格越高
- 🔒 输入内容会经过安全审核
- 🌐 确保输入图像可公网访问

## 7. 故障排查

### API Key 错误

```
错误：API Key not configured for this model
解决：检查 .env.local 中的 ALIYUN_WANX_API_KEY 配置
```

### 任务超时

```
错误：Video generation timed out
解决：检查网络连接，稍后重试，或使用 flash 版本
```

### 内容审核失败

```
错误：DataInspectionFailed
解决：修改提示词或图像内容，确保符合内容规范
```

## 更多信息

详细文档：[docs/ALIYUN_WANX_I2V.md](./ALIYUN_WANX_I2V.md)
