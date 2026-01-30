# SQLite 数据存储使用指南

## 概述

已实现 SQLite 数据库存储，包括工作流、模型配置、API 缓存等功能。

## 数据库结构

### 表说明

1. **workflows** - 存储工作流数据
   - id: 工作流唯一标识
   - name: 工作流名称
   - data: JSON 格式的节点和连线数据
   - created_at/updated_at: 时间戳

2. **model_configs** - 存储模型配置
   - model_name: 模型名称（主键）
   - base_url: API 基础 URL
   - api_key: API 密钥
   - model_id: 模型 ID
   - endpoint: 主端点
   - query_endpoint: 查询端点（可选）
   - download_endpoint: 下载端点（可选）

3. **api_cache** - 存储 API 调用缓存
   - cache_key: 缓存键（SHA256 哈希）
   - model_name: 模型名称
   - prompt: 提示词
   - params: 请求参数（JSON）
   - result: 缓存结果（JSON）
   - expires_at: 过期时间

4. **media_files** - 存储媒体文件元数据
   - id: 文件 ID
   - type: 文件类型（image/video）
   - url: 远程 URL
   - base64_data: Base64 数据（可选）
   - size: 文件大小

## API 端点

### 工作流管理

#### 获取所有工作流

```bash
GET /api/workflow
```

**响应：**

```json
{
  "success": true,
  "data": [
    {
      "id": "workflow-123",
      "name": "我的工作流",
      "nodes": [...],
      "edges": [...],
      "viewport": {...},
      "createdAt": 1234567890,
      "updatedAt": 1234567890
    }
  ]
}
```

#### 获取单个工作流

```bash
GET /api/workflow/{id}
```

#### 创建工作流

```bash
POST /api/workflow
Content-Type: application/json

{
  "name": "新工作流",
  "nodes": [],
  "edges": [],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

#### 更新工作流

```bash
PUT /api/workflow/{id}
Content-Type: application/json

{
  "name": "更新后的名称",
  "nodes": [...],
  "edges": [...]
}
```

#### 删除工作流

```bash
DELETE /api/workflow/{id}
```

### 模型配置管理

#### 获取所有模型配置

```bash
GET /api/model-config
```

#### 获取单个模型配置

```bash
GET /api/model-config?model=BananaPro
```

#### 保存模型配置

```bash
POST /api/model-config
Content-Type: application/json

{
  "modelName": "BananaPro",
  "config": {
    "modelId": "banana-pro-v1",
    "baseUrl": "https://api.banana.dev",
    "key": "your-api-key",
    "endpoint": "/v1/chat/completions"
  }
}
```

#### 删除模型配置

```bash
DELETE /api/model-config?model=BananaPro
```

### 缓存管理

#### 获取缓存统计

```bash
GET /api/cache
```

**响应：**

```json
{
  "success": true,
  "data": {
    "total": 42,
    "expired": 5,
    "size": 2048576,
    "sizeFormatted": "1.95 MB"
  }
}
```

#### 清理过期缓存

```bash
DELETE /api/cache
# 或
DELETE /api/cache?action=expired
```

#### 清理所有缓存

```bash
DELETE /api/cache?action=all
```

## 在代码中使用

### 工作流操作示例

```typescript
import {
  getAllWorkflows,
  getWorkflowById,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
} from "@/lib/db/workflows";

// 获取所有工作流
const workflows = getAllWorkflows();

// 创建新工作流
const newWorkflow = createWorkflow({
  name: "我的工作流",
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});

// 更新工作流
updateWorkflow(workflowId, {
  name: "新名称",
  nodes: updatedNodes,
});

// 删除工作流
deleteWorkflow(workflowId);
```

### 模型配置操作示例

```typescript
import {
  getAllModelConfigs,
  getModelConfig,
  saveModelConfig,
  deleteModelConfig,
} from "@/lib/db/model-configs";

// 获取所有配置
const configs = getAllModelConfigs();

// 获取特定模型配置
const bananaConfig = getModelConfig("BananaPro");

// 保存配置
saveModelConfig("BananaPro", {
  modelId: "banana-pro-v1",
  baseUrl: "https://api.banana.dev",
  key: "your-api-key",
  endpoint: "/v1/chat/completions",
});

// 删除配置
deleteModelConfig("BananaPro");
```

### 缓存操作示例

```typescript
import {
  getCacheKey,
  getCache,
  setCache,
  clearExpiredCache,
  getCacheStats,
} from "@/lib/db/cache";

// 生成缓存键
const cacheKey = getCacheKey("BananaPro", "a cat", {
  aspectRatio: "1:1",
});

// 检查缓存
const cached = getCache(cacheKey);
if (cached) {
  console.log("Cache hit!", cached);
}

// 设置缓存（1小时）
setCache(
  cacheKey,
  "BananaPro",
  "a cat",
  { aspectRatio: "1:1" },
  { url: "https://..." },
  { ttl: 3600 },
);

// 清理过期缓存
const deletedCount = clearExpiredCache();

// 获取统计
const stats = getCacheStats();
```

## 集成到现有 API

生成 API 已经集成了数据库模型配置读取：

```typescript
// app/api/generate/image/route.ts
async function getModelConfig(modelName: string): Promise<ModelConfig> {
  // 优先从数据库读取
  const config = getModelConfigFromDb(modelName);
  if (config) {
    return config;
  }

  // 降级到环境变量（首次使用）
  return {
    modelId: modelName,
    baseUrl: process.env.DEFAULT_BASE_URL || "",
    key: process.env.DEFAULT_API_KEY || "",
    endpoint: "/v1/chat/completions",
  };
}
```

## 初始化数据

### 添加默认模型配置

```bash
# 通过 API 添加
curl -X POST http://localhost:3000/api/model-config \
  -H "Content-Type: application/json" \
  -d '{
    "modelName": "BananaPro",
    "config": {
      "modelId": "banana-pro-v1",
      "baseUrl": "https://api.banana.dev",
      "key": "your-api-key",
      "endpoint": "/v1/chat/completions"
    }
  }'
```

### 直接在代码中初始化

```typescript
import { saveModelConfig } from "@/lib/db/model-configs";

// 初始化默认配置
const defaultConfigs = {
  BananaPro: {
    modelId: "banana-pro-v1",
    baseUrl: process.env.BANANA_BASE_URL || "",
    key: process.env.BANANA_API_KEY || "",
    endpoint: "/v1/chat/completions",
  },
  Flux: {
    modelId: "flux-1.1-pro",
    baseUrl: process.env.FLUX_BASE_URL || "",
    key: process.env.FLUX_API_KEY || "",
    endpoint: "/v1/images/generations",
  },
};

Object.entries(defaultConfigs).forEach(([name, config]) => {
  saveModelConfig(name, config);
});
```

## 数据库维护

### 查看数据库内容

```bash
# 连接到数据库
sqlite3 data/canvas.db

# 查看所有表
.tables

# 查看工作流
SELECT id, name, updated_at FROM workflows ORDER BY updated_at DESC;

# 查看模型配置
SELECT model_name, base_url FROM model_configs;

# 查看缓存统计
SELECT
  COUNT(*) as total,
  SUM(LENGTH(result)) as total_size,
  COUNT(CASE WHEN expires_at < strftime('%s', 'now') * 1000 THEN 1 END) as expired
FROM api_cache;

# 退出
.quit
```

### 备份数据库

```bash
# 创建备份
cp data/canvas.db data/canvas-backup-$(date +%Y%m%d).db

# 或使用 SQLite 备份命令
sqlite3 data/canvas.db ".backup data/canvas-backup.db"
```

### 清理数据库

```bash
# 清理过期缓存
sqlite3 data/canvas.db "DELETE FROM api_cache WHERE expires_at < strftime('%s', 'now') * 1000;"

# 优化数据库
sqlite3 data/canvas.db "VACUUM;"
```

## 性能优化

### WAL 模式

数据库已配置为 WAL（Write-Ahead Logging）模式，提供更好的并发性能：

```typescript
db.pragma("journal_mode = WAL");
```

### 索引

已创建的索引：

- `idx_workflows_updated_at` - 按更新时间排序工作流
- `idx_api_cache_expires_at` - 快速清理过期缓存

### 缓存策略

- 默认 TTL: 1 小时
- 自动清理：每次查询缓存时会清理过期条目
- 手动清理：定期调用 `/api/cache?action=expired`

## 故障排除

### 数据库锁定错误

如果遇到 "database is locked" 错误：

1. 确保使用 WAL 模式（已配置）
2. 检查是否有其他进程占用数据库
3. 增加超时时间：
   ```typescript
   db.pragma("busy_timeout = 5000"); // 5秒
   ```

### 文件权限问题

```bash
# 确保数据目录存在且可写
mkdir -p data
chmod 755 data
chmod 644 data/canvas.db
```

### 开发环境热重载

代码已处理开发环境的热重载问题：

```typescript
if (process.env.NODE_ENV === "development") {
  const globalForDb = global as typeof globalThis & { db?: Database.Database };
  if (globalForDb.db) {
    globalForDb.db.close();
  }
  globalForDb.db = db;
}
```

## 生产部署注意事项

### Vercel 部署限制

⚠️ **重要**: Vercel Serverless 函数是无状态的，不支持文件系统持久化。

**解决方案：**

1. **开发环境**: 使用本地 SQLite（已配置）
2. **生产环境**: 迁移到以下之一：
   - [Turso](https://turso.tech/) - Serverless SQLite
   - [Vercel Postgres](https://vercel.com/storage/postgres)
   - [PlanetScale](https://planetscale.com/)

### 环境变量配置

在 Vercel 项目设置中添加：

```
DATABASE_PATH=./data/canvas.db  # 开发环境
DEFAULT_BASE_URL=https://your-api.com
DEFAULT_API_KEY=your-production-key
```

## 下一步

数据库已完全集成，可以继续：

1. **测试 API 端点** - 使用上面的 curl 命令测试各个功能
2. **集成到 UI** - 在组件中调用工作流保存/加载 API
3. **添加模型管理界面** - 创建管理页面来配置模型
4. **实施缓存策略** - 在生成 API 中使用缓存减少重复请求

完成！🎉
