# 修复图生视频模型错误

## 问题

使用 `wan2.6-i2v-flash` 模型时出现 "Model not exist" 错误。

## 原因

阿里云通义万相的图生视频模型可能不支持 `wan2.6-i2v-flash` 这个模型 ID，或者该模型已经下线/改名。

## 解决方案

### 方案 1：使用标准模型（推荐）

在前端设置中，修改模型配置使用 `wan2.6-i2v` 而不是 `wan2.6-i2v-flash`：

1. 打开设置（点击右上角齿轮图标）
2. 找到 "通义万相-图生视频-基于首帧" 配置
3. 修改 Model ID 为：`wan2.6-i2v`
4. 保存

### 方案 2：使用其他可用模型

根据阿里云文档，以下模型可能可用：

- `wanx-v1`（最新版本）
- `wan2.6-i2v`（标准版）
- `wan2.5-i2v-preview`（预览版）

### 方案 3：修改数据库

直接修改数据库中的模型配置：

```bash
sqlite3 data/canvas.db "UPDATE model_configs SET model_id = 'wan2.6-i2v' WHERE model_name = '通义万相-图生视频-基于首帧'"
```

### 方案 4：检查 API Key 权限

确保你的 API Key 有权限使用图生视频功能：

1. 访问 [阿里云百炼控制台](https://bailian.console.aliyun.com/)
2. 检查 API Key 的权限设置
3. 确保已开通"通义万相"服务

## 验证

修改后，重新测试图生视频节点：

1. 在画布中添加"图生视频"节点
2. 连接输入图片
3. 填写提示词
4. 点击生成
5. 查看控制台日志，应该显示：
   ```
   [AliyunWanx] Creating video generation task...
   [AliyunWanx] Task created successfully: xxx
   ```

## 当前已知可用模型

根据测试，以下模型已确认可用：

- ✅ `wan2.6-i2v` - 标准图生视频模型
- ✅ `wan2.2-kf2v-flash` - 首尾帧生成视频模型
- ⚠️ `wan2.6-i2v-flash` - 状态未知（建议使用 wan2.6-i2v 替代）

## 参考文档

- [阿里云通义万相文档](https://help.aliyun.com/zh/model-studio/developer-reference/tongyi-wanxiang-api)
- [图生视频 API 参考](https://help.aliyun.com/zh/model-studio/developer-reference/api-reference-for-image-to-video)
