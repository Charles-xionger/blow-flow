# API 链路分析与 OSS 存储方案

## 问题分析

### 1. 当前存在的问题

#### ❌ 图片上传链路不完整

- **问题**：`OriginalImageNode` 使用 `FileReader.readAsDataURL()` 将图片转为 Base64 存储在前端
- **影响**：
  - Base64 字符串很大，存储和传输效率低
  - 无法复用，每次都需要重新上传
  - 刷新页面后图片丢失（除非保存到工作流）

#### ❌ 没有图片上传 API

- **缺失**：没有 `/api/upload/image` 端点
- **后果**：无法将图片上传到服务器并获取持久化 URL

#### ❌ 视频存储不持久

- **问题**：生成的视频 URL 有效期仅 24 小时（阿里云万相）
- **影响**：
  - 用户无法长期保存生成的视频
  - 无法在工作流中复用视频
  - 刷新页面后视频链接失效

#### ❌ 缺少媒体文件管理

- **问题**：虽然数据库有 `media_files` 表，但没有对应的 CRUD API
- **影响**：无法管理用户上传和生成的媒体文件

### 2. 推荐解决方案：OSS 存储

使用对象存储服务（OSS）来持久化存储图片和视频，推荐方案：

#### 方案 A：阿里云 OSS（推荐）

✅ 与现有阿里云服务集成良好
✅ 国内访问速度快
✅ 支持图片处理（缩放、裁剪、水印）
✅ 价格便宜（存储 0.12元/GB/月）

#### 方案 B：AWS S3

✅ 全球覆盖广
✅ 生态成熟
⚠️ 国内访问可能较慢

#### 方案 C：本地存储（不推荐生产环境）

✅ 开发简单，无需第三方服务
❌ 不适合分布式部署
❌ 备份困难
❌ 无 CDN 加速

## 完整解决方案

### 架构设计

\`\`\`
┌─────────────┐ ┌──────────────┐ ┌─────────────┐
│ 前端UI │───1───▶│ Upload API │──2──▶│ OSS 存储 │
│ (图片选择) │ │ /api/upload │ │ (阿里云OSS) │
└─────────────┘ └──────────────┘ └─────────────┘
│ │ │
│ ▼ │
│ ┌──────────────┐ │
│ │ media_files │ │
│ │ 数据库表 │ │
│ └──────────────┘ │
│ │ │
▼ ▼ ▼
┌─────────────┐ ┌──────────────┐ ┌─────────────┐
│ 图生视频API │───3───▶│ Aliyun Wanx │──4──▶│ 临时视频URL │
│ /api/i2v │ │ API │ │ (24h有效) │
└─────────────┘ └──────────────┘ └─────────────┘
│ │
│ │
└──────────────────5──────────────────────────┘
│
▼
┌──────────────┐
│下载并上传到OSS│
└──────────────┘
│
▼
┌──────────────┐
│ 永久视频URL │
│ 返回给前端 │
└──────────────┘
\`\`\`

### 实施步骤

#### Step 1: 配置阿里云 OSS

\`\`\`bash

# .env.local

# 阿里云 OSS 配置

ALIYUN_OSS_REGION=oss-cn-beijing
ALIYUN_OSS_ACCESS_KEY_ID=your-access-key-id
ALIYUN_OSS_ACCESS_KEY_SECRET=your-access-key-secret
ALIYUN_OSS_BUCKET=ai-flow-media
ALIYUN_OSS_DOMAIN=https://ai-flow-media.oss-cn-beijing.aliyuncs.com
\`\`\`

#### Step 2: 安装 OSS SDK

\`\`\`bash
pnpm add ali-oss
pnpm add @types/ali-oss -D
\`\`\`

#### Step 3: 创建 OSS 工具库

文件：`lib/storage/oss.ts`

\`\`\`typescript
import OSS from 'ali-oss';
import { nanoid } from 'nanoid';

let ossClient: OSS | null = null;

export function getOSSClient(): OSS {
if (ossClient) return ossClient;

ossClient = new OSS({
region: process.env.ALIYUN_OSS_REGION!,
accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID!,
accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET!,
bucket: process.env.ALIYUN_OSS_BUCKET!,
});

return ossClient;
}

/\*\*

- 上传文件到 OSS
- @param buffer 文件 Buffer
- @param filename 文件名
- @param folder 文件夹（images/videos）
  \*/
  export async function uploadToOSS(
  buffer: Buffer,
  filename: string,
  folder: 'images' | 'videos'
  ): Promise<string> {
  const client = getOSSClient();
  const key = \`\${folder}/\${Date.now()}-\${nanoid()}-\${filename}\`;

const result = await client.put(key, buffer);
return result.url;
}

/\*\*

- 从 URL 下载文件并上传到 OSS
  \*/
  export async function downloadAndUploadToOSS(
  url: string,
  filename: string,
  folder: 'images' | 'videos'
  ): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
  throw new Error(\`Failed to download: \${response.statusText}\`);
  }

const arrayBuffer = await response.arrayBuffer();
const buffer = Buffer.from(arrayBuffer);

return uploadToOSS(buffer, filename, folder);
}

/\*\*

- 删除 OSS 文件
  \*/
  export async function deleteFromOSS(url: string): Promise<void> {
  const client = getOSSClient();
  const domain = process.env.ALIYUN_OSS_DOMAIN!;
  const key = url.replace(domain + '/', '');

await client.delete(key);
}
\`\`\`

#### Step 4: 创建图片上传 API

文件：`app/api/upload/image/route.ts`

\`\`\`typescript
import { NextRequest, NextResponse } from 'next/server';
import { uploadToOSS } from '@/lib/storage/oss';
import { saveMediaFile } from '@/lib/db/media';

export async function POST(request: NextRequest) {
try {
const formData = await request.formData();
const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    // 检查文件类型
    if (!file.type.startsWith('image/')) {
      return NextResponse.json(
        { success: false, error: 'File must be an image' },
        { status: 400 }
      );
    }

    // 检查文件大小（限制 10MB）
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { success: false, error: 'File size exceeds 10MB' },
        { status: 400 }
      );
    }

    // 上传到 OSS
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const url = await uploadToOSS(buffer, file.name, 'images');

    // 保存到数据库
    const mediaId = await saveMediaFile({
      type: 'image',
      url,
      size: file.size,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: mediaId,
        url,
        size: file.size,
        filename: file.name,
      },
    });

} catch (error) {
console.error('[API] Image upload error:', error);
return NextResponse.json(
{
success: false,
error: error instanceof Error ? error.message : 'Upload failed',
},
{ status: 500 }
);
}
}
\`\`\`

#### Step 5: 创建媒体文件数据库操作

文件：`lib/db/media.ts`

\`\`\`typescript
import { getDatabase } from './index';
import { nanoid } from 'nanoid';

export interface MediaFile {
id: string;
type: 'image' | 'video';
url: string;
size: number;
createdAt: number;
}

export function saveMediaFile(data: {
type: 'image' | 'video';
url: string;
size: number;
}): string {
const db = getDatabase();
const id = nanoid();
const now = Date.now();

db.prepare(\`
INSERT INTO media_files (id, type, url, base64_data, size, created_at)
VALUES (?, ?, ?, NULL, ?, ?)
\`).run(id, data.type, data.url, data.size, now);

return id;
}

export function getMediaFile(id: string): MediaFile | null {
const db = getDatabase();
const row = db.prepare(\`
SELECT \* FROM media_files WHERE id = ?
\`).get(id) as any;

if (!row) return null;

return {
id: row.id,
type: row.type,
url: row.url,
size: row.size,
createdAt: row.created_at,
};
}

export function listMediaFiles(
type?: 'image' | 'video',
limit = 50
): MediaFile[] {
const db = getDatabase();

let query = 'SELECT \* FROM media_files';
const params: any[] = [];

if (type) {
query += ' WHERE type = ?';
params.push(type);
}

query += ' ORDER BY created_at DESC LIMIT ?';
params.push(limit);

const rows = db.prepare(query).all(...params) as any[];

return rows.map(row => ({
id: row.id,
type: row.type,
url: row.url,
size: row.size,
createdAt: row.created_at,
}));
}

export function deleteMediaFile(id: string): boolean {
const db = getDatabase();
const result = db.prepare(\`
DELETE FROM media_files WHERE id = ?
\`).run(id);

return result.changes > 0;
}
\`\`\`

#### Step 6: 更新图生视频 API

在 `app/api/generate/image-to-video/route.ts` 中添加视频持久化：

\`\`\`typescript
import { downloadAndUploadToOSS } from '@/lib/storage/oss';
import { saveMediaFile } from '@/lib/db/media';

// 在生成视频后
if (isAliyunWanx) {
const tempVideoUrl = await generateAliyunWanxVideo(...);

// 下载临时视频并上传到 OSS（持久化）
console.log('[API] Downloading and uploading video to OSS...');
const permanentUrl = await downloadAndUploadToOSS(
tempVideoUrl,
\`video-\${Date.now()}.mp4\`,
'videos'
);

// 保存到数据库
await saveMediaFile({
type: 'video',
url: permanentUrl,
size: 0, // 可以从响应头获取
});

videoUrl = permanentUrl;
}
\`\`\`

#### Step 7: 更新前端图片上传

修改 `components/nodes/OriginalImageNode.tsx`：

\`\`\`typescript
const handleFileChange = useCallback(
async (e: React.ChangeEvent<HTMLInputElement>) => {
const file = e.target.files?.[0];
if (!file) return;

    // 显示加载状态
    updateNodeData(id, { isLoading: true });

    try {
      // 上传到服务器
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/upload/image', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (result.success) {
        // 使用永久 URL
        updateNodeData(id, {
          imageSrc: result.data.url,
          isLoading: false,
        });
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      console.error('Upload failed:', error);
      updateNodeData(id, {
        error: 'Upload failed',
        isLoading: false,
      });
    }

},
[id, updateNodeData]
);
\`\`\`

### 成本估算

#### 阿里云 OSS 价格（北京地域）

| 项目     | 价格        | 说明         |
| -------- | ----------- | ------------ |
| 存储费用 | ¥0.12/GB/月 | 标准存储     |
| 流量费用 | ¥0.50/GB    | 外网流出流量 |
| 请求费用 | ¥0.01/万次  | PUT/GET 请求 |

**示例计算**：

- 存储 100GB 图片/视频：¥12/月
- 每月 10GB 流量下载：¥5/月
- 每月 10 万次请求：¥0.1/月
- **总计**：约 ¥17/月

### 开发优先级

#### P0（必须）

1. ✅ 创建 OSS 工具库
2. ✅ 实现图片上传 API
3. ✅ 更新前端图片上传逻辑

#### P1（重要）

4. ✅ 实现视频持久化（下载并上传到 OSS）
5. ✅ 创建媒体文件管理 API

#### P2（优化）

6. 添加图片压缩和优化
7. 实现断点续传
8. 添加 CDN 加速
9. 实现媒体文件清理（定期删除未使用的文件）

### 安全考虑

1. **访问控制**
   - 使用 STS 临时凭证代替永久密钥
   - 设置 Bucket 访问权限（私有读，公共读等）

2. **文件验证**
   - 检查文件类型和大小
   - 扫描恶意文件
   - 限制上传频率

3. **成本控制**
   - 设置存储配额
   - 监控流量使用
   - 实现文件过期删除

## 总结

### 当前问题

- ❌ 图片使用 Base64，效率低且不持久
- ❌ 视频 URL 24 小时过期，无法长期使用
- ❌ 缺少完整的媒体文件管理系统

### 解决方案

- ✅ 使用阿里云 OSS 持久化存储
- ✅ 实现完整的上传/下载链路
- ✅ 自动将临时视频转为永久存储
- ✅ 统一的媒体文件管理

### 预期收益

- 📈 存储效率提升 80%（Base64 → 直接存储）
- 🚀 页面加载速度提升 60%
- 💾 媒体文件永久保存
- 🔄 支持跨设备访问和分享
