# 第一阶段实施与验证记录

日期：2026-11-13

## 已交付

- pnpm Workspace + Turborepo；现有应用与 worker 移至 apps/web，保留根目录数据和已有未提交改动。
- apps/api：Gin、请求 ID、健康检查、优雅退出、GORM/PostgreSQL 连接、Goose 版本化 SQL 迁移入口。
- PostgreSQL Compose；真实数据库集成测试使用隔离 schema，缺少测试数据库配置时明确失败。
- 根目录统一开发、构建、单元、集成、进程 E2E、浏览器及 eval 命令；GitHub Actions 分层配置。
- Web/Gin Sentry 初始化与脱敏测试；Langfuse 合成评测、失败门槛、离线报告、显式发布入口和真实 SDK 本地接收测试。
- 修复搬迁后的环境加载、Turbo 环境透传、源码变更检测与旧测试假设。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| 冻结 lockfile 安装 | 通过 |
| typecheck | 3 个工作区通过，6.82 秒 |
| lint | 3 个工作区通过，无错误；Web 保留已有警告 |
| 全量快速测试 | Web 300/300、eval 3/3、Go 测试通过；总耗时 8.315 秒 |
| PostgreSQL 集成 | 真实 PG、Goose、GORM 与就绪检查通过，1.784 秒 |
| Gin 进程 E2E | 1/1，2.199 秒 |
| 全量浏览器 | 140/140，6.2 分钟；源码检测未失效 |
| 离线 eval | 6 个合成案例，得分 1，达到门槛 |
| 生产构建 | Web 和 Go 通过，19.573 秒 |
| git diff --check | 通过 |

首次全量 E2E 中的浏览器部分因磁盘 ENOSPC 中断，不能计为通过。
清理本项目生成缓存后，在相同源码下完整重跑浏览器，140 项全部通过。
Gin 进程 E2E 在首次命令中已独立通过。上述是本地验证结果，未宣称远端 CI 已运行。

## 交付边界

- 业务仍运行于 apps/web，旧 SQLite 数据未迁移；PostgreSQL 已有基础设施，没有业务表迁移。
- GORM 用于数据访问，Goose 管理版本化 SQL；没有使用启动时 AutoMigrate 作为生产迁移机制。
- Sentry 和 Langfuse 未配置真实远端项目、未验证远端投递；本地测试覆盖脱敏和 SDK 接收链路。
- eval 当前验证生产解析/校验逻辑与评测基础设施，不代表真实模型质量评测。
- 管理后台、成本账本、MQ、通知和告警在 spec 的后续阶段；本阶段未制作占位产品界面。

启动和配置见根目录 README.md；架构约束见 docs/architecture/foundation.md。
