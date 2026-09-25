# 16/2 调度与删除生命周期：独立 PostgreSQL 验收

2026-09-21 22:03（北京时间）。本报告只覆盖自动化数据库/进程验收，不代表方案第 9.1 节浏览器、真实生成及线上负载验收已经完成。

## 结果

最终统一运行：**4 个文件、37 项测试全部通过，21.40 秒，无跳过**。

| 测试文件 | 通过数 | 实测范围 |
| --- | ---: | --- |
| `tests/server/generation-jobs.pg.test.ts` | 7 | 双独立 Node 进程竞争 claim；8 owner 各 2 根任务共 16，第 17 个排队；幂等创建；行锁跳过；取消/课程删除后的迟到结果被拒；数据库供应商额度 |
| `tests/server/generation-worker-pipeline.pg.test.ts` | 3 | 持久化检查点及有序发布；独立 worker 强杀后未知结果进入人工处理且外部请求只发生 1 次；已提交响应恢复后不重复外调 |
| `tests/server/hosted-capacity-rls.pg.test.ts` | 11 | 实际 PostgreSQL 非超级用户登录与 RLS；跨 owner 聚合但不能读取其他 owner 行/内部租约表；禁止伪造 owner；前台 2/16 额度；删除账户禁入；Pro/派生 job/解析根去重；公平排队；过期租约 fencing；24 个待确认 reservation 及缩至 16 不抢占 |
| `tests/server/account-deletion-lifecycle.test.ts` | 16 | 同 8 场景分别运行 PGlite 与真实 PostgreSQL：立即冻结 writer、共享 hash 竞争重查、Storage 失败可重试、Auth 失败后恢复、删除 tombstone 与共享对象保留 |

混合根测试在数据库创建 8 个 owner，每个 owner 有普通后台根以及 Pro 根；同一 Pro 会话同时有 2 个派生 generation job 和材料解析 lease。实际聚合仍为每 owner 2、总数 16。普通后台 lease 过期后允许前台占用空出的槽；重复前台请求不重复占位，释放后额度回落。这里的混合测试覆盖真实 SQL/RLS 聚合，不是 16 条真实模型生成流水线的吞吐压测。

## 发现并修复的缺陷

`prepareAccountDeletionManifest` 原先用 `jsonb_build_object('objectCount',...)` 覆写整个 `manifest`，丢弃 `requestAccountDeletion` 保存的 `operator_email_sha256`。短路径恢复测试遗漏了这个中间步骤；新增完整“请求删除 → 素材清理 → Auth 删除失败 → 按邮箱找回任务”测试后，PGlite 和 PostgreSQL 均复现恢复结果为 `null`。

修复将统计信息合并到原有 manifest，保留恢复标识。修复后同一测试验证失败持久化为 `retry/auth_delete`、邮箱恢复成功、重试完成、tombstone 保留、其他 owner 引用的共享字节不删除。没有弱化断言。

## 复现

Windows PowerShell，在项目根目录运行，使用 Node.js 22 或更新版本：

```powershell
./scripts/test-hosted-capacity.ps1 -NodeExecutable 'C:\path\to\node.exe'
```

脚本重新构建当前 worker，然后运行上述 4 个测试文件。每次创建随机命名的 `postgres:16` 容器，数据库为 `capacity_rls_proof`，只监听 `127.0.0.1:55432`，数据库目录挂 tmpfs，不连接已有卷；结束时仅停止自己创建的容器，`--rm` 自动删除容器。端口被占用时失败，不停止已有服务。

测试环境变量仅指向本次临时库：`TEST_GENERATION_DATABASE_URL`、`TEST_HOSTED_CAPACITY_DATABASE_URL`、`TEST_ACCOUNT_DELETION_DATABASE_URL`；禁用加载 `.env.local`。脚本不读取应用数据库连接或密钥。生产 Web/worker、旧源数据库及数据卷均未用于测试或被本任务修改。

本次最终运行使用 Codex 附带 Node，PostgreSQL 16；Supabase 项目实际版本为 PostgreSQL 17，因此该报告不是对托管 PG 17 的版本专属性能保证。测试 SQL 中模拟了账号/生成表与对应实际 RLS 函数；Storage/Auth 故障使用明确的故障注入实现，没有删除真实 Supabase 用户或对象。

## 仍需独立验收

- 16 个实际普通/Pro/前台生成根同时执行真实模型与媒体请求时的吞吐、错误率、连接数、CPU/内存、课堂与教会学伴延迟。
- 真实 Supabase 网络短断、连接上限、供应商 429 的负载恢复。
- 真实 Supabase Storage/Auth 临时账号完整删除及对象回收（本报告仅测试应用生命周期代码与真实本地 PostgreSQL）。
- 三类生成、完整课堂、教会学伴的第 9.1 节浏览器验收及迁移清单完整性。

这些未验证项不能由本报告的 37 项通过替代。
