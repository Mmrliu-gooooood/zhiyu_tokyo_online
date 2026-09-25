# Supabase 东京迁移完成报告

完成日期：2026-09-25，时间均为 UTC+8。

## 结果

- 主项目已迁入原组织的东京 `ap-northeast-1`：`zhiyu-tokyo`，ref `lvbtgwlsebzbtcvjwktq`。
- 应用在 14:52 切换；原新加坡 `zhiyu`（`lzomhnjyymalupgvcato`）于 15:13:15 删除，Management API 返回 200。两次项目清单复核均只剩东京，状态 `ACTIVE_HEALTHY`。
- 15:13 删除后检查：Web 与两个 worker 均健康，数据库、账号 schema v19、生成 schema v4、两个 worker 心跳及三个私有桶全部通过。
- 不再保留额外新加坡项目；迁移期间已经产生的重叠费用仍以实际账单为准。

## 完整性与应用验收

| 范围 | 结果 |
| --- | --- |
| 数据库 | 盘点 91 张表；冻结后最终 51 张业务表逐表行数、内容 SHA-256 一致，131 条课程及其历史、场景、任务、事件、学习记录均保留 |
| Auth | 3 个原账号 UUID、密码哈希及原认证记录保留；管理员/A/B 登录和应用身份接口通过 |
| 权限结构 | 90 个表/序列所有者及 ACL/RLS 标志一致；5 项列 ACL 一致；原函数、触发器、策略、角色成员关系与原 12 条 migration 历史保留 |
| Storage | 三个 private 桶均保留，包括空 classroom 桶；1,571 文件、526,678,898 字节逐个上传后下载 SHA-256 校验通过，本地全部文件在删除前再次验证摘要 |
| 配置/密钥 | 平台配置逐项回读；43 份模型/媒体密文再次解密通过；4 项应用加密/会话密钥未变，项目 URL/API/S3/DB/LISTEN 凭据已换为东京 |
| 课程 | 原有课程读取，创建测试课程、保存、读回、删除测试课程均通过；可见课程按原有删除标记规则过滤，管理员可见 66 门，与源规则一致 |
| 隔离 | 匿名应用访问被拒绝；跨账号课程读写和资产访问被拒绝；anon/authenticated 不能通过 Data API 读取课程表 |
| 文件 | 图片/音频经真实应用下载，字节摘要一致；8 份资料再校验通过，匿名公开 URL 不可读；S3 Range 返回 206 且切片字节一致 |
| 学习记录 | 已有学习会话与记录通过真实 HTTP 接口读取，记录数量与数据库一致 |
| 邮件 | 使用原 Resend 已验证域名/DNS；东京 SMTP 密钥实际发送密码恢复邮件，Resend 确认 delivered，模板回调与 recovery 流程正确 |
| 后台 | 原有两个 worker 和 Tier 4 模式保留；Web/worker 各自 session pooler 上 LISTEN/NOTIFY 往返验证通过 |
| 导出 | 使用东京实际读取的课程，经现有导出逻辑生成 Markdown/DOCX 并验证 OOXML 内容 |
| 构建/测试 | Web、worker 生产镜像构建成功；浏览器产物无旧项目 ref；类型检查通过；全量测试 8,459 通过、0 失败、70 跳过；另有 15 项定向测试及导出冒烟通过；新增迁移脚本 ESLint 通过 |

## 有意差异与验收边界

- 东京项目专属 API/JWT/数据库管理/S3/SMTP 凭据不同，不复制旧项目身份密钥。用户可能需要重新登录。
- 登录和邮件探针产生认证测试记录、最后登录/更新时间及恢复令牌变化；测试课程删除后可保留正常的删除标记。这些不是原业务数据丢失。
- Storage 原对象 ID、所有权、时间戳和用户元数据保留；底层文件版本与服务生成 metadata 使用东京实际值，不能拿旧物理版本替换新文件。
- 原 12 条 migration 之外增加两条迁移权限修复记录：恢复表/函数权限及事件触发器、恢复账号表四列 SELECT 权限。修复不扩大整表公开访问。
- 通知连接生成器原先漏匹配 `DATABASE_LISTEN_URL*`，本次已修正并验证东京 session pooler。`.env.local` 公开 URL/key、`.env.hosted.local` 及运维入口一并切换，应用加密密钥保持不变。
- 普通资产 HTTP 合约本来就忽略 Range 并返回完整 200，本次验证保持该行为；不宣称该接口支持 206。东京 S3 底层 206 单独验证。classroom 桶为空，没有旧课堂媒体可做真实播放样本。
- 未额外触发付费 LLM/TTS 新课程生成，也未宣称完成新生成或所有导出格式的端到端验收；既有普通/Pro 数据、密文、队列、心跳及通知连接已核验。
- 安全顾问与源项目相同，无新增告警：1 项 INFO（迁移表 RLS 无策略）、2 项原有 WARN。保留原应用策略，未借迁移擅自改动：[已登录用户可调用 SECURITY DEFINER 函数](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)、[未启用泄漏密码保护](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。

## 备份与证据

专用私密目录：`.scratch/supabase-tokyo-20260925/`，已被 Git 与 Docker 构建上下文排除，包含用户数据和凭据，不应提交或公开分享。

- 最终冻结数据库备份：`source-cutover/sql/full-source.dump`，10,922,853 字节；同目录 `backup-manifest.json` 保存 SHA-256，`pg_restore --list` 成功读取 1,081 项。初次实际恢复到东京已验证完整性，最终只需同步心跳增量。
- 原始文件及逐文件摘要：`source-preflight/objects/`、`storage-backup-manifest.json`；目标逐文件下载验证：`lvbtgwlsebzbtcvjwktq/storage-transfer.json`。
- 数据/权限：`final-data-reconciliation.json`、`acl-reconciliation-final.json`、`column-acl-reconciliation.json`。
- 应用/邮件/导出/测试：`live-verification.json`、`materials-verification.json`、`export-verification.json`、`smtp-delivery-private.json`、`full-tests.json`。
- 删除证据：`source-deletion.json`、`projects-after-delete.json`。
- 原项目配置、原环境、旧镜像回退标签仍保留为恢复材料，但原 Supabase 项目删除不可撤销，无法再直接切回旧服务；恢复需另建项目并导入备份。

## 后续注意

1. 撤销之前在对话中提供的 Supabase 管理令牌；不要删除应用当前使用的东京 S3/SMTP 密钥。
2. 后续日本服务器部署继续使用东京环境配置；目前应用仍运行在本机 localhost:3000，未把未来服务器部署视为已完成。
3. 用户要求不排查蓝屏，本次未做系统/驱动诊断。构建采用单 worker 与低内存选项，完成了本次迁移，不代表系统问题已被诊断或修复。

迁移过程遵循 Supabase 技能的配置回读、RLS/列权限、Auth/Storage 完整性核验要求；Next.js 技能用于保持构建期公开变量与最终部署一致。详细过程见 [迁移计划](../plans/2026-09-25-supabase-tokyo-migration.md)。
