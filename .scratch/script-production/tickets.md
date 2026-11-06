# 脚本节点第一阶段任务

六项任务均已实现并标记为 `resolved`，合入 `integration/script-production`；下表保留实施依赖以供追溯。范围以[第一阶段规格](spec.md)及各任务验收条件为准。

| 编号 | 任务 | 阻塞项 |
| --- | --- | --- |
| 02 | [真实脚本后台生成与流式展示](issues/02-script-streaming.md) | 无 |
| 03 | [参考输入与创作任务预设](issues/03-script-inputs.md) | [02](issues/02-script-streaming.md) |
| 04 | [停止、重开与异常恢复](issues/04-script-recovery.md) | [02](issues/02-script-streaming.md) |
| 05 | [脚本版本与编辑稿](issues/05-script-versions.md) | [02](issues/02-script-streaming.md) |
| 06 | [发布文本与冲突保护](issues/06-script-publishing.md) | [05](issues/05-script-versions.md) |
| 07 | [旧节点迁移与完整链路收口](issues/07-script-migration.md) | [03](issues/03-script-inputs.md)、[04](issues/04-script-recovery.md)、[06](issues/06-script-publishing.md) |

实施顺序为 02 → 03／04／05；05 → 06；03、04、06 → 07。各任务和[审查修复](review.md)均已完成。

所有任务保留“不运行测试”的约束，真实付费模型联调未获本任务清单授权。制作台、音频节点和样片观看属于后续阶段。原型议题保持原状；规格已记录实施结果与未执行的验证。
