# P2-3 运行观测与恢复演练：无输入部分（只读统计 + 日志轮转配置）

- **环境/日期/代码版本/镜像：** 2026-09-25（UTC+8）。东京 Supabase `zhiyu-tokyo` / `lvbtgwlsebzbtcvjwktq` / `ap-northeast-1`，PostgreSQL 17.6，`ACTIVE_HEALTHY`；本机应用容器 `zhiyu-supabase-web:local`（`sha256:8618bed6…`）、`zhiyu-supabase-worker:local`（`sha256:811f548b…`）×2，Tier 4 / Background。通过 Supabase 管理接口执行**只读** SQL，未写入东京项目。
- **初始问题：** 方案第 9 节第 2–4 步：生产没有日志轮转；tmpfs 无上限；Supabase 栈资产回收关闭，孤儿对象可能累积。
- **修改范围与原因：**
  - 日志轮转写入新的生产覆盖文件 `docker-compose.production.yml`：Web、两个 worker、readiness 都用 `json-file`，`max-size: 20m`、`max-file: 5`，每个容器最多约 100 MB。由 `tests/config/production-compose-contract.test.ts` 锁定。本机 compose 未改日志设置。
  - 未设置 tmpfs `size` 上限、未写清理脚本、未启用资产回收：这些要依据真实运行基线，属于第 1.1 节里“缺隔离恢复环境/告警渠道”之外、但方案要求先 dry-run 的步骤，本次只做统计。
- **前后指标（只读统计，2026-09-25 23:3x）：**

  | 项目 | 结果 |
  | --- | --- |
  | `asset_blobs` 行 / 字节 | 1,563 / 526,676,584 |
  | 无 `asset_entries` 引用的 blob | 0 行 / 0 字节（其中超过 1 小时宽限的 0） |
  | `zhiyu-assets` 桶对象 | 1,563 个，526,676,584 字节 |
  | 桶中有对象、注册表无 blob | 0 |
  | 注册表有 blob、桶中无对象 | 0 |
  | `zhiyu-materials` 桶 | 8 个对象 / 2,314 字节 |
  | classroom 桶 | 0 个对象（与迁移报告一致） |
  | 本机 tmpfs 占用（空闲时） | Web `/tmp`、`/app/data` 均 0 KB；每个 worker `/tmp` 4 KB（1 个文件）；`/app/data` 0 KB |
  | tmpfs 容量上限 | 每个挂载默认约 3.8 GiB（Docker Desktop VM 7.65 GiB 的一半），3 个容器共 6 个挂载，**均无独立上限** |
  | 容器内存（空闲） | Web 151 MiB；worker 119 MiB / 196 MiB |

  说明：“孤儿”在这里只按资产注册表层面计算（blob 无 entry、对象无 blob）。“entry 仍在但已没有任何课程文档引用”属于文档级回收，要连同课程场景 JSON 一起判断，本次未统计。

- **Advisor（只读）：** 安全类与迁移时相同：1 项 INFO（`app_schema_migrations` 开 RLS 无策略）、2 项 WARN（`public.reserved_admin_lifecycle_snapshot` 可被 authenticated 调用的 SECURITY DEFINER 函数；未开启泄漏密码保护）。性能类：4 项外键无覆盖索引、24 项未使用索引（INFO）、Auth 连接为固定 10（INFO）。均未修改；按方案，收紧函数权限须走新的 accounts 迁移版本。
- **自动测试命令及结果：** `node node_modules/vitest/vitest.mjs run tests/config --maxWorkers=2` 通过（与 D0 同一组，14 文件 108 项）。
- **真实操作与课程/任务/会话 ID：** 无写入；只读查询列于上表。
- **权限与持久化检查：** 只读；未改 RLS、未删对象。
- **回退方式及是否验证：** 日志轮转只存在于新增的生产覆盖文件，删除该段即可恢复；本机未受影响。
- **结论：** 受外部条件限制（只读统计与日志轮转配置完成；恢复演练、告警样本、tmpfs 上限与清理未做）。
- **剩余事项：**
  1. 需要用户提供：隔离恢复环境（另建 Supabase 项目或本机 PG + 对象存储）、告警渠道。
  2. tmpfs 上限要先在负载下采样峰值（P2-1），再在生产覆盖文件中设 `size`；当前 6 个无上限挂载在 8 GB 服务器上是真实风险。
  3. 东京项目的持续备份与 Storage 字节覆盖尚未单独确认（迁移冻结备份不含迁移后新增数据）。
