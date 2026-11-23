# CL 存储优化验收 · 2026-11-07

- 正式数据库：`data/jingjing-video/characterlife.db`
- 优化前：93,662,269,440 字节（87.23 GiB）。
- 优化后：299,425,792 字节（285.55 MiB）。
- 历史快照：159,919 → 32；最新快照仍为 #159919，事件序号 707。
- 每实例最多 32 份完整快照；同一 5 分钟时间桶更新最新恢复点。
- 已同步开发仓库与 `character-companion/vendor/CharacterLife-VideoCohost/vendor/characterlife` 的持久层修复。

## 数据保全

所有非快照表逐行计数与 SHA-256 摘要相同；保留 137 条记忆、707 条事件、
51,235 条审计账本、18 个会话、736 条上下文统计、4,629 条已处理消息及其他表。
保留 schema、索引、触发器、AUTOINCREMENT 高水位与数据库版本。
候选库 quick_check 和 foreign_key_check 均通过，切换前再次核对保留内容摘要。

原数据库经 checkpoint 后完整保留为：
`data/jingjing-video/characterlife.db.before-storage-optimization-20261107.sqlite`。
备份逻辑大小 93,665,800,192 字节，NTFS 实际占用 56,039,514,112 字节（约 52.19 GiB）。
Windows 压缩完成部分区段后已停止，无后台压缩继续运行。
包含备份与新运行库，本次文件实际占用减少约 34.76 GiB。
验收时 C 盘可用约 28.82 GiB；系统其他活动也会改变空闲空间。

## 验证

- 开发仓库全量回归 427 项通过；服务内核副本全量回归 429 项通过。
- 后补的跨时间桶与清理失败回滚测试通过，最终快照专项测试 3/3 通过。
- 鲸鲸适配集成测试 114 项通过（指定当前 `JINGJING_OVERLAY_DIR`）。
- 两份内核类型检查通过；迁移/激活测试通过；独立审查通过。
- 正式库重新打开后 quick_check=ok、无外键错误、32 份快照。
- 在正式库的独立副本上用服务实际内核执行恢复：8 步全通过，加载 137 条记忆，
  恢复快照 #159919，51,235 条账本哈希链验证通过，无非法重放事件。
- 验收不调用模型、不创建新会话，临时验收数据库已删除。

优化前 CL 服务端口 8787/8788 已离线，本次未启动该服务；现有 relay/语音服务未停止。
快照数量有上限；记忆、事件、账本等表仍随使用增长，不宣称数据库总大小永久固定。
备份最初保留全部旧快照。后续用户明确授权删除，现已删除本次完整旧库备份，
释放约 52.12 GiB，删除后 C 盘可用约 87.17 GiB。正式库删除前再次通过完整性、
外键、记忆数量、账本数量及最新快照检查。删除记录见
`reports/storage-backup-deletion-20261107.json`。

复用流程见 `docs/storage-limits.md`；逐表验证摘要见
`data/jingjing-video/characterlife.optimized.verification.json`；恢复结果见 `reports/storage-recovery.json`。
