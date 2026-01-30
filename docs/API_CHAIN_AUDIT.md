# API 链路完整性检查报告

生成日期：2026-01-30

## 执行摘要

### 🔴 关键问题

1. **图片上传链路不完整** - 没有服务端上传 API
2. **视频 URL 不持久** - 24小时后失效
3. **媒体文件管理缺失** - 数据库表存在但无 API

### 🟡 次要问题

1. 示例代码使用占位 URL（`example.com`）
2. 缺少文件大小和类型验证
3. 没有进度显示

### 🟢 良好实践

1. 数据库结构合理（`media_files` 表已定义）
2. API 缓存机制完善
3. 错误处理较完整

## 详细检查结果

### 1. 图片处理链路

#### 当前实现

\`\`\`
用户上传图片
↓
FileReader.readAsDataURL()
↓
Base64 字符串
↓
存储在前端 State
↓
❌ 没有持久化
\`\`\`

#### 问题

- ❌ Base64 字符串很大（1MB 图片 → 1.3MB Base64）
- ❌ 不持久化，刷新页面丢失
- ❌ 无法在不同设备间共享
- ❌ 传输效率低

#### 推荐方案

\`\`\`
用户上传图片
↓
FormData 上传到服务器
↓
/api/upload/image
↓
上传到 OSS
↓
返回永久 URL
↓
✅ 持久化存储
\`\`\`

### 2. 视频生成链路

#### 当前实现（阿里云万相）

\`\`\`
POST /api/generate/image-to-video
↓
调用阿里云 API
↓
轮询任务状态
↓
返回临时视频 URL
↓
⚠️ 24 小时后失效
\`\`\`

#### 问题

- ⚠️ 视频 URL 24 小时失效
- ❌ 用户无法长期保存
- ❌ 刷新页面后链接失效
- ❌ 无法分享或复用

#### 推荐方案

\`\`\`
POST /api/generate/image-to-video
↓
调用阿里云 API
↓
获取临时视频 URL
↓
下载视频文件
↓
上传到 OSS
↓
返回永久 URL
↓
✅ 永久可访问
\`\`\`

### 3. API 端点清单

| 端点                             | 方法       | 状态    | 说明             |
| -------------------------------- | ---------- | ------- | ---------------- |
| /api/generate/image              | POST       | ✅ 存在 | 图片生成         |
| /api/generate/video              | POST       | ✅ 存在 | 文生视频         |
| /api/generate/image-to-video     | POST       | ✅ 存在 | 图生视频         |
| /api/generate/image-to-image     | POST       | ✅ 存在 | 图生图           |
| /api/generate/start-end-to-video | POST       | ✅ 存在 | 首尾帧生视频     |
| /api/upload/image                | POST       | ❌ 缺失 | **图片上传**     |
| /api/upload/video                | POST       | ❌ 缺失 | 视频上传         |
| /api/media                       | GET        | ❌ 缺失 | **媒体文件列表** |
| /api/media/[id]                  | GET/DELETE | ❌ 缺失 | **媒体文件管理** |
| /api/workflow                    | GET/POST   | ✅ 存在 | 工作流管理       |
| /api/model-config                | GET/POST   | ✅ 存在 | 模型配置         |
| /api/cache                       | GET/DELETE | ✅ 存在 | 缓存管理         |

### 4. 数据流检查

#### 图片数据流

\`\`\`typescript
// 当前：Base64 方式
OriginalImageNode
→ FileReader.readAsDataURL()
→ data:image/png;base64,iVBORw0KG...（很长）
→ Store (imageSrc)
→ ❌ 不持久化

// 推荐：URL 方式
OriginalImageNode
→ FormData 上传
→ /api/upload/image
→ OSS URL
→ Store (imageSrc)
→ ✅ 永久可用
\`\`\`

#### 视频数据流

\`\`\`typescript
// 当前：临时 URL
ImageToVideoNode
→ /api/generate/image-to-video
→ 阿里云万相 API
→ https://dashscope-result-_.oss-_.aliyuncs.com/xxx.mp4?Expires=...
→ Store (videoSrc)
→ ⚠️ 24小时失效

// 推荐：持久化
ImageToVideoNode
→ /api/generate/image-to-video
→ 阿里云万相 API（临时 URL）
→ 下载视频
→ 上传到自己的 OSS
→ https://my-bucket.oss-cn-beijing.aliyuncs.com/videos/xxx.mp4
→ Store (videoSrc)
→ ✅ 永久可用
\`\`\`

### 5. 代码示例问题

#### 文档中的占位 URL

\`\`\`typescript
// ❌ 问题：文档使用占位 URL
{
inputImage: 'https://example.com/image.jpg',
prompt: '一只猫在草地上奔跑',
}

// ✅ 应该说明：
// 1. 这是示例 URL
// 2. 实际使用时需要先上传图片获取真实 URL
// 3. 或者提供完整的上传 → 生成流程
\`\`\`

#### 建议改进

\`\`\`typescript
// 完整示例
// Step 1: 上传图片
const formData = new FormData();
formData.append('file', imageFile);

const uploadRes = await fetch('/api/upload/image', {
method: 'POST',
body: formData,
});
const { data: { url: imageUrl } } = await uploadRes.json();

// Step 2: 生成视频
const videoRes = await fetch('/api/generate/image-to-video', {
method: 'POST',
body: JSON.stringify({
model: 'wan2.6-i2v-flash',
inputImage: imageUrl, // 使用真实上传的 URL
prompt: '一只猫在草地上奔跑',
}),
});
\`\`\`

## 优先级建议

### P0 - 必须修复（影响核心功能）

1. **实现图片上传 API**
   - 端点：`POST /api/upload/image`
   - 功能：接收图片文件，上传到 OSS，返回 URL
   - 预计工作量：4-6 小时
   - 文件：`app/api/upload/image/route.ts`

2. **实现视频持久化**
   - 修改：`app/api/generate/image-to-video/route.ts`
   - 功能：下载临时视频，上传到 OSS，返回永久 URL
   - 预计工作量：3-4 小时

3. **更新前端上传逻辑**
   - 修改：`components/nodes/OriginalImageNode.tsx`
   - 功能：使用 FormData 上传而非 Base64
   - 预计工作量：2-3 小时

### P1 - 重要（提升用户体验）

4. **添加媒体文件管理 API**
   - 端点：`GET/DELETE /api/media`
   - 功能：查看和管理已上传的媒体文件
   - 预计工作量：4-6 小时

5. **添加上传进度显示**
   - 功能：显示文件上传和视频生成进度
   - 预计工作量：3-4 小时

6. **更新文档和示例**
   - 修改示例代码使用真实 URL
   - 添加完整的使用流程说明
   - 预计工作量：2-3 小时

### P2 - 优化（锦上添花）

7. **实现图片压缩**
   - 功能：上传前压缩大图片
   - 预计工作量：4-6 小时

8. **添加断点续传**
   - 功能：大文件上传支持断点续传
   - 预计工作量：1-2 天

9. **实现媒体文件清理**
   - 功能：定期删除未使用的文件
   - 预计工作量：4-6 小时

## 技术债务

### 当前技术债务

1. **Base64 存储图片** - 效率低，内存占用大
2. **临时视频 URL** - 不可靠，用户体验差
3. **缺少文件管理** - 无法查看和清理文件
4. **示例代码不完整** - 可能误导用户

### 债务影响

- 🔴 用户体验：视频链接失效，图片刷新丢失
- 🟡 性能：Base64 传输慢，内存占用高
- 🟡 维护成本：缺少统一的媒体管理
- 🟢 安全性：文件验证不完整

### 建议偿还计划

1. 第 1 周：实现 P0 功能（图片上传、视频持久化）
2. 第 2 周：实现 P1 功能（媒体管理、进度显示）
3. 第 3-4 周：实现 P2 功能（优化和完善）

## 测试建议

### 功能测试

- [ ] 图片上传成功
- [ ] 图片 URL 可访问
- [ ] 视频生成成功
- [ ] 视频 URL 永久有效
- [ ] 刷新页面后媒体文件仍可访问

### 性能测试

- [ ] 上传 10MB 图片耗时
- [ ] 生成 10 秒视频耗时
- [ ] 100 个并发请求压力测试

### 安全测试

- [ ] 上传非图片文件被拒绝
- [ ] 上传超大文件被拒绝
- [ ] 恶意文件被检测

### 兼容性测试

- [ ] Chrome/Edge
- [ ] Firefox
- [ ] Safari
- [ ] 移动端浏览器

## 总结

### 关键发现

1. ⚠️ **API 链路基本完整，但缺少关键的媒体文件管理功能**
2. ❌ **图片和视频都没有持久化存储方案**
3. ⚠️ **文档示例使用占位 URL，可能误导用户**

### 行动建议

1. 🚨 **立即实施 OSS 存储方案**（参考 `OSS_STORAGE_SOLUTION.md`）
2. 📝 **更新文档和示例代码**
3. ✅ **实现 P0 优先级功能**

### 预期收益

- ✅ 媒体文件永久可访问
- ✅ 用户体验大幅提升
- ✅ 系统架构更专业
- ✅ 减少技术债务

---

**下一步**: 请查看 [`OSS_STORAGE_SOLUTION.md`](./OSS_STORAGE_SOLUTION.md) 和 [`OSS_IMPLEMENTATION_GUIDE.md`](./OSS_IMPLEMENTATION_GUIDE.md) 了解详细实施方案。
