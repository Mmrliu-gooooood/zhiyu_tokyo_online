# P2-1 4→8→16 容量验收：第 2 步（临时 PostgreSQL 调度测试）

- **环境/日期/代码版本/镜像：** 2026-09-25（UTC+8），本机 Windows 11 + Docker Desktop 29.7.2（8 GiB VM，20 核），Node v24.18.1。数据库为一次性容器 `postgres:16`（`--tmpfs` 数据目录，只绑定 `127.0.0.1:55432`，库名 `capacity_rls_proof`，结束即 `--rm` 删除）。基线提交 `a0484f3e` + 本轮未提交改动。**未连接东京 Supabase，未调用任何模型。**
- **初始问题：** 方案第 7 节：扩容前必须证明全局/owner 准入、租约 fencing、取消、去重和删除不回归。
- **修改范围与原因：** 本项无代码修改。`tests/server/hosted-capacity-rls.pg.test.ts` 新增的 4 个用例属于 P1-2（完成标记与释放同一事务），一并在此环境运行。
- **执行方式：** `scripts/test-hosted-capacity.ps1` 在本机 Windows PowerShell 5.1 下第一行就失败：`& $NodeExecutable -p 'process.versions.node.split(".")[0]'` 的内层双引号被 5.1 的原生参数传递去掉，Node 报语法错误（PowerShell 7 下正常；本机没有 `pwsh`）。失败发生在创建容器之前，没有任何写入。未修改脚本，改为在 bash 中逐条执行与脚本相同的步骤：同一镜像、同一标签和 `--tmpfs`、同一组 `TEST_*_DATABASE_URL`、`TEST_LOAD_LOCAL_ENV=0`、先 `scripts/build-generation-worker.mjs`（重建本地 `dist-worker/`，该目录被 git 忽略），再运行同样 4 个测试文件，`--maxWorkers=1 --reporter=verbose`。另外 Git Bash 会改写 `--tmpfs /var/lib/postgresql/data`，第一次尝试因此没起容器（测试全部连不上库，无写入），加 `MSYS_NO_PATHCONV=1` 后重跑。
- **前后指标：** 不涉及。
- **自动测试命令及结果：**

  ```text
  node node_modules/vitest/vitest.mjs run tests/server/generation-jobs.pg.test.ts \
    tests/server/generation-worker-pipeline.pg.test.ts tests/server/hosted-capacity-rls.pg.test.ts \
    tests/server/account-deletion-lifecycle.test.ts --maxWorkers=1 --reporter=verbose
  ```

  结果：4 个文件、42 项全部通过（`vitest=0`）。其中 hosted RLS 文件包括 2/16 前台根准入与越权拒绝、同步槽 fencing、删除中账号拒绝续租、8 个 owner 混合 Pro/材料/后台根的去重，以及 P1-2 新增的事务内标记+释放 4 项。
- **真实操作与课程/任务/会话 ID：** 无。
- **权限与持久化检查：** 写入只发生在临时容器；容器已停止并自动删除。
- **回退方式及是否验证：** 无需回退。
- **结论：** 受外部条件限制（第 2 步“调度上限”通过；第 1、3–9 步真实容量验收未执行）。
- **剩余事项：**
  1. 需要用户提供：≥8 个专用测试 owner、模型 RPM/TPM 与图片/TTS 配额、测试费用上限、成功率门槛、隔离环境或维护窗口。
  2. 东京连接预算（只读，2026-09-25）：`max_connections=60`（保留 3），当时共 23 个后端，其中 `zhiyu_app_worker` 8 个（idle 6、idle in transaction 2）、`zhiyu_app_web` 1 个；Auth 固定 10 连接。代码按 session pooler 10 个后端给 `app_worker` 做预算（2 worker × 3 池 + 各 1 LISTEN = 8），与当前观测一致；升档前需在负载下复核。
  3. `scripts/test-hosted-capacity.ps1` 的 Node 版本探测在 Windows PowerShell 5.1 下不可用（引号问题）；是否修复属于独立小改动，未在本轮擅自改。
