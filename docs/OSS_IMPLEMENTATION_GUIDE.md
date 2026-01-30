# 快速实施 OSS 存储方案

## 立即可以做的改进（不需要 OSS）

### 1. 添加图片上传到临时目录

\`\`\`typescript
// app/api/upload/temp/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { nanoid } from 'nanoid';

export async function POST(request: NextRequest) {
try {
const formData = await request.formData();
const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file' },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // 保存到 public/uploads 目录
    const filename = \`\${Date.now()}-\${nanoid()}-\${file.name}\`;
    const filepath = join(process.cwd(), 'public', 'uploads', filename);
    await writeFile(filepath, buffer);

    // 返回可访问的 URL
    const url = \`/uploads/\${filename}\`;

    return NextResponse.json({
      success: true,
      data: { url },
    });

} catch (error) {
return NextResponse.json(
{ success: false, error: 'Upload failed' },
{ status: 500 }
);
}
}
\`\`\`

**优点**：

- ✅ 简单，不需要第三方服务
- ✅ 立即可用

**缺点**：

- ❌ 文件存储在服务器本地
- ❌ 分布式部署时有问题
- ❌ 需要手动清理文件

### 2. 修改前端使用 FormData

\`\`\`typescript
// components/nodes/OriginalImageNode.tsx
const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
const file = e.target.files?.[0];
if (!file) return;

updateNodeData(id, { isLoading: true });

try {
const formData = new FormData();
formData.append('file', file);

    const res = await fetch('/api/upload/temp', {
      method: 'POST',
      body: formData,
    });

    const result = await res.json();

    if (result.success) {
      updateNodeData(id, {
        imageSrc: result.data.url,
        isLoading: false,
      });
    }

} catch (error) {
updateNodeData(id, { error: '上传失败', isLoading: false });
}
};
\`\`\`

## 完整 OSS 方案实施清单

### Phase 1: 准备工作（1 天）

- [ ] 注册阿里云账号
- [ ] 创建 OSS Bucket
- [ ] 获取 AccessKey ID 和 Secret
- [ ] 配置 CORS 规则
- [ ] 配置环境变量

### Phase 2: 基础功能（2-3 天）

- [ ] 安装依赖：\`pnpm add ali-oss\`
- [ ] 创建 \`lib/storage/oss.ts\`
- [ ] 创建 \`app/api/upload/image/route.ts\`
- [ ] 创建 \`lib/db/media.ts\`
- [ ] 更新 \`OriginalImageNode.tsx\`

### Phase 3: 视频持久化（1-2 天）

- [ ] 更新 \`image-to-video/route.ts\`
- [ ] 实现视频下载和上传
- [ ] 测试端到端流程

### Phase 4: 优化和测试（1-2 天）

- [ ] 添加错误处理
- [ ] 实现进度显示
- [ ] 性能测试
- [ ] 安全审计

## 环境变量配置模板

\`\`\`bash

# .env.local

# ===== 阿里云 OSS 配置 =====

# OSS 地域（如：oss-cn-beijing, oss-cn-hangzhou）

ALIYUN_OSS_REGION=oss-cn-beijing

# OSS 访问密钥（从阿里云控制台获取）

ALIYUN_OSS_ACCESS_KEY_ID=your-access-key-id
ALIYUN_OSS_ACCESS_KEY_SECRET=your-access-key-secret

# OSS Bucket 名称

ALIYUN_OSS_BUCKET=ai-flow-media

# OSS 自定义域名（可选，用于加速访问）

# ALIYUN_OSS_DOMAIN=https://media.your-domain.com

# ===== 阿里云通义万相 API =====

ALIYUN_WANX_BASE_URL=https://dashscope.aliyuncs.com
ALIYUN_WANX_API_KEY=sk-your-wanx-api-key

# ===== 其他配置 =====

DATABASE_PATH=./data/workflows.db
NODE_ENV=development
\`\`\`

## OSS Bucket 配置指南

### 1. 创建 Bucket

\`\`\`bash

# 登录阿里云控制台

# https://oss.console.aliyun.com/

# 创建 Bucket 配置

- 名称：ai-flow-media
- 地域：华北2（北京）
- 读写权限：公共读（推荐）或私有
- 服务端加密：开启（可选）
  \`\`\`

### 2. 配置 CORS

在 Bucket 设置中添加 CORS 规则：

\`\`\`json
{
"allowedOrigins": ["*"],
"allowedMethods": ["GET", "POST", "PUT", "DELETE", "HEAD"],
"allowedHeaders": ["*"],
"exposeHeaders": ["ETag"],
"maxAgeSeconds": 3600
}
\`\`\`

### 3. 配置生命周期（可选）

自动删除临时文件：

\`\`\`
规则名称：delete-temp-files
前缀：temp/
过期时间：7 天
\`\`\`

## 测试清单

### 图片上传测试

\`\`\`bash

# 测试上传

curl -X POST http://localhost:3000/api/upload/image \\
-F "file=@test-image.jpg"

# 预期响应

{
"success": true,
"data": {
"id": "abc123",
"url": "https://ai-flow-media.oss-cn-beijing.aliyuncs.com/images/...",
"size": 123456,
"filename": "test-image.jpg"
}
}
\`\`\`

### 视频生成测试

\`\`\`bash

# 测试图生视频

curl -X POST http://localhost:3000/api/generate/image-to-video \\
-H "Content-Type: application/json" \\
-d '{
"model": "wan2.6-i2v-flash",
"inputImage": "https://ai-flow-media.oss-cn-beijing.aliyuncs.com/images/...",
"prompt": "测试视频",
"duration": 5
}'

# 预期响应

{
"success": true,
"data": "https://ai-flow-media.oss-cn-beijing.aliyuncs.com/videos/...",
"cached": false
}
\`\`\`

## 常见问题

### Q: OSS 费用会不会很高？

A: 对于个人或小型项目，成本很低：

- 存储 10GB：¥1.2/月
- 流量 5GB/月：¥2.5/月
- **总计约 ¥4/月**

### Q: 不用 OSS 可以吗？

A: 可以，但有限制：

- ✅ 开发环境：使用本地存储
- ⚠️ 生产环境：需要 OSS 或类似服务

### Q: 视频必须持久化吗？

A: 强烈建议：

- 万相视频 URL 24 小时过期
- 用户刷新页面后会丢失
- 无法分享或复用

### Q: 可以用其他 OSS 服务吗？

A: 可以，支持：

- 阿里云 OSS
- 腾讯云 COS
- AWS S3
- 七牛云 KODO
- 又拍云 USS

只需修改 \`lib/storage/oss.ts\` 的实现。

## 下一步行动

### 选项 1：快速开始（本地存储）

1. 创建 \`public/uploads\` 目录
2. 实现 \`/api/upload/temp\` 接口
3. 更新前端上传逻辑
4. ⏱️ 耗时：2-3 小时

### 选项 2：完整方案（OSS）

1. 配置阿里云 OSS
2. 按照 Phase 1-4 实施
3. 完整测试和部署
4. ⏱️ 耗时：5-7 天

### 选项 3：混合方案

1. 开发环境用本地存储
2. 生产环境用 OSS
3. 通过环境变量切换
4. ⏱️ 耗时：3-4 天

## 推荐方案

🎯 **推荐：混合方案**

理由：

- 开发体验好（无需配置 OSS）
- 生产环境专业（使用 OSS）
- 灵活可扩展

实现方式：
\`\`\`typescript
// lib/storage/index.ts
export function getStorageService() {
if (process.env.NODE_ENV === 'production' && process.env.ALIYUN_OSS_BUCKET) {
return require('./oss').default;
}
return require('./local').default;
}
\`\`\`
