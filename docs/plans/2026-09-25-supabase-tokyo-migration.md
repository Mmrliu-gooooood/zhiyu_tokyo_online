# Supabase 新加坡至东京迁移

日期：2026-09-25。状态：**迁移完成。14:52（UTC+8）切换东京，15:13 删除原新加坡项目，删除后再次确认东京健康。** 当前仅剩 `zhiyu-tokyo` / `lvbtgwlsebzbtcvjwktq`，区域 `ap-northeast-1`。数据库及全部 1,571 文件（526,678,898 字节）已迁移。源库在 14:34 冻结后重新完整备份，最终 51 张业务表内容摘要一致；3 个现有账号及 43 份加密配置验证通过。详见 [最终交付报告](../reports/2026-09-25-supabase-tokyo-migration-completed.md)。

## 授权与目标

用户授权将主项目迁至 `ap-northeast-1`，迁移完整验收后删除原新加坡项目，以避免持续双项目费用。用户确认沿用组织 `Mmrliu-gooooood's Org`（`kxjcibafpuwyjkbfmief`）。源项目为 `zhiyu` / `lzomhnjyymalupgvcato` / `ap-southeast-1`。

Supabase 创建工具报价为每项目每月 10 USD；迁移期间短暂并存，实际账单以组织计费为准。目标先命名 `zhiyu-tokyo`。新加坡项目的删除是最后一步，不以“导入命令成功”代替完整验收。

## 初始在线盘点

- PostgreSQL 17.6，数据库约 55 MB；业务所在 schema 包括 `public` 与 `app_internal`，另有 `auth`、`storage`、`supabase_migrations` 及平台 schemas。
- 3 个 Auth 用户；初始统计约 131 门课程、477 个场景。这里是在线统计估值，最终采用冻结写入后的精确计数与内容摘要。
- 三个私有桶：`zhiyu-assets` 1,563 对象 / 526,676,584 字节；`zhiyu-materials` 8 对象 / 2,314 字节；`zhiyu-classrooms` 当前无对象。三桶配置均须保留，包括空桶。
- 无 Edge Functions、无开发分支、Vault secrets 为零（最终快照复核）。
- 自定义角色：`app_web`、`app_worker`、`zhiyu_app_web`、`zhiyu_app_worker`。两个业务 LOGIN 均无 BYPASSRLS。
- Resend 已验证域名 `auth.zhiyulearn.online`，区域已为东京，发信开启，收信/点击追踪/打开追踪关闭；无 Resend webhook。
- 当前应用为本机 `openmaic-supabase` Compose 项目：一个 Web、两个 worker。Docker `default` context 可连接，当前 `desktop-linux` context 的管道不可用；迁移命令显式使用可工作的 context，不改变全局默认。

## 完整迁移矩阵

| 范围 | 迁移与保留 | 验收条件 |
| --- | --- | --- |
| 业务数据库 | 所有业务表，包括课程/场景/历史版本、资料、课堂/学习记录、Pro/普通生成会话与事件、队列、额度、账本、删除墓碑、资产引用与旧迁移记录；不得只迁 public 的部分表 | 冻结快照每表精确行数和顺序无关内容摘要一致，所有差异有明确原因 |
| 数据库结构 | schema、表、索引、约束、序列及其当前位置、视图、函数、触发器、RLS/强制 RLS、角色成员关系、GRANT、默认权限、publication、自定义 schema 和托管 schema 上的用户定制 | 规范化 catalog 对比；显式核对 app_internal 函数及 auth/storage 上的用户触发器/策略 |
| Auth 数据 | users、identities、密码哈希、用户元数据及关联认证记录，保留原 UUID 和 owner 映射；核查 MFA/SSO/OAuth/passkey 数据 | 账号计数/ID/密码哈希摘要一致，管理员与另一个现有账号可正常登录；必要时重新登录，不承诺旧会话无缝延续 |
| Auth 配置 | Site URL、redirect allow-list、SMTP、全部邮件模板/主题、注册和确认规则、密码策略、JWT/会话设置、限流、验证码、MFA、providers、hooks、OAuth server、审计配置 | 管理配置完整导出；可写字段逐项恢复、回读对比。项目专属 URL/密钥做有记录的替换 |
| Storage | 所有桶及属性，所有对象字节、路径、Content-Type、Cache-Control、自定义 metadata、owner 属性与数据库引用；检查 multipart/analytics/vector 资源 | 源/目标完整分页清单一致，每个对象下载计算 SHA-256 并比较；不可只比数量、大小或 ETag |
| 平台配置 | 数据 API exposed schemas/search path/max rows、DB SSL/网络限制、扩展/参数、pooler、Realtime、webhooks/cron/外部连接、备份/PITR/compute/disk、函数及 secrets、custom domain/集成/副本/分支等 | 逐项登记为已迁移、未启用或平台自动管理；所有已启用依赖具备处理结果；避免恢复后重放后台副作用 |
| 应用密钥 | MEDIA_CONFIG_ENCRYPTION_KEY、GENERATION_MODEL_ENCRYPTION_KEY、PRO_MODEL_ENCRYPTION_KEY、GENERATION_SESSION_SECRET 及现有供应商配置保持一致 | 密钥指纹相同，现有加密模型配置可解密；值仅留在 Git 忽略的本地私密文件 |
| 部署与脚本 | 新项目 URL、publishable/secret key、DB 管理/Web/worker/LISTEN 连接、TLS CA、S3 endpoint/region/key；移除运行脚本对旧 ref/host 的固定绑定；同步本地部署和测试入口 | 重新构建 NEXT_PUBLIC_* 浏览器包；运行路径不再连接旧项目；历史报告保留原 ref 并标注迁移 |
| Resend | 保留现有已验证域名、DNS、发信身份和现有邮件历史；为东京 Supabase 配置可用 SMTP 凭据 | Auth 实际测试邮件经 Resend 发出并确认投递状态，模板回调指向现有应用入口；不重建或删除发信域名 |

## 执行顺序

1. 完成管理 API 访问准备、源项目/应用盘点与只读备份演练。Supabase MCP 未提供 Auth/SMTP 配置导出更新、项目删除等接口，须补充 Management API 或等效控制台能力。
2. 将数据库、Storage 文件、平台配置和应用环境备份到 Git 忽略的本地专用目录，保存清单和 SHA-256。备份文件含用户数据/凭据，报告只记录数量、摘要和路径。
3. 原组织内创建东京项目，获取新项目连接与密钥，核查 PG 版本兼容性。按源配置设置容量与安全/连接参数。
4. 先迁移并核验静态文件，保持可恢复进度。正式快照前暂停新任务入口，等待活动任务结束，再停本项目 Web/worker；阻止其他已识别写入来源（含直接 Auth/Storage 写入），确认无后台写入。冻结是有限维护窗口，不能在等待凭据期间提前停服。
5. 导出最终一致数据库快照，恢复自定义角色、schema、数据、序列、权限和托管 schema 定制；平台内部 migration schema 不盲目覆盖不同版本，所有排除项逐项登记。保留 Supabase 和应用迁移历史。
6. 复制最终文件增量、核对 Storage 元数据；恢复全部项目级配置及邮件模板/SMTP。新旧项目不同时运行相同任务和清理器。
7. 完成冻结基线的全量对账，再更新应用环境和脚本、重新构建并启动东京连接；保留原模式、两个 worker、Tier 4 和功能开关。
8. 通过下述验收后删除新加坡项目；再查项目清单确认只剩东京主项目、检查应用仍健康，记录旧项目删除时间和备份位置。

## 删除旧项目的硬性验收门槛

- 可恢复的最终数据库/文件/配置备份存在，文件摘要可复核；执行恢复演练或在目标实际完整恢复并验证。
- 所有业务表、Auth 关键身份数据、应用权限结构和文件对象全量对账通过；无未解释缺失。
- 三桶仍 private；用户 A 无法读取/改写用户 B 资源，匿名访问受保护接口被拒绝。
- 管理员与另一用户登录、旧课程和学习记录恢复、保存并读回、资料下载、图片/音频/Range、导出可用。
- 现有加密模型配置可用；普通后台与 Pro 的数据库状态持久化、两个 worker 心跳、LISTEN/NOTIFY 正常。真实生成冒烟受现有供应商可用性与额度约束，未完成必须如实记录，不伪称通过。
- SMTP 与注册/恢复邮件模板可用，实际邮件有投递证据；测试仅使用明确属于本项目的测试邮箱，不触达无关用户。
- 构建产物、运行容器和运维入口均指向东京；无活动客户端继续写旧项目。
- 旧项目删除会永久移除云端源数据，删除前检查确切项目 ref 为 `lzomhnjyymalupgvcato`；删除后只能依靠本地备份恢复，不能宣称平台可撤销。

## 回退

切换前失败：原项目继续提供服务；只修复目标。切换后且东京尚未产生新业务写入：可以恢复旧环境与旧镜像。东京已产生新业务写入后：必须先保存/同步这些写入再回退，不能直接指回旧快照。旧项目删除后不再有一键回退，保留本地最终备份与迁移证据。

## 执行补充与已识别差异

- 源与目标均为 PostgreSQL `17.6.1.166`；目标连接已使用原 CA 成功执行完整 TLS 主机名校验。
- 管理 API 的 `smtp_pass` 是脱敏摘要而不是明文，不能复制当作密码。已创建仅绑定原发信域名的 `zhiyu-supabase-tokyo-smtp` 发送权限密钥并设置到东京 Auth；真实邮件投递验收前仍不算通过。
- S3 控制台创建新密钥前已取得用户单独确认。密钥与数据库管理密码、应用配置、备份只保存在 `.scratch/supabase-tokyo-20260925/`，已被 Git 和 Docker 构建上下文忽略。
- Supabase CLI roles dump 包含 `GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin`，租户 postgres 无权恢复该平台内部权限。首次事务回滚后仅排除这条平台权限；四个业务角色及成员关系完整恢复，平台参数权限另行核对。
- Storage 字节通过 API 上传，不能盲目恢复旧对象的底层版本标识。恢复原对象 ID、所有权、时间戳与用户元数据，同时保留东京实际文件版本及服务生成 metadata；每个文件的字节与 HTTP 内容属性单独对账。
- 平台 migration 表与未启用的 vector/analytics 功能由目标平台管理，不覆盖其内部版本。源完整数据库 archive 仍包含这些资源，未丢弃备份。
- 一次本地进程中断后重新停止了仍指向新加坡的容器，重新建立写锁并完成最终备份。文件复制采用可恢复进度，未重复创建或覆盖源数据。
- 本机两次非正常重启，最近一次启动于 13:53。系统 Event 1001 确认 BugCheck `0x00000050`，转储 `C:\Windows\Minidump\092526-13593-01.dmp`；不能仅凭时间关联判定根因。用户确认是自动重启/蓝屏。停止重型构建和全量测试，未改驱动/BIOS/系统内存设置。
- 14:05 左右恢复源应用；原 `.env.hosted.local` 从未切换。运维脚本/示例地址也已恢复原新加坡配置，东京切换差异保存在私密目录 `tokyo-operator-cutover.patch`，防止当前应用和运维配置不一致。14 项定向测试通过；全量测试与生产构建未完成，不能宣称通过。
- 数据核对文件：`business-reconciliation.json` 显示 52/52（51 业务表 + 原 migration 表）全量计数/摘要一致；`target-fast/database-inventory.json` 和 `reconciliation.json` 保存完整 catalog。三个登录探针带来各 3 条 sessions/refresh_tokens/mfa_amr_claims 及 last_sign_in_at 变化，属于明确的测试增量。
- 平台 realtime/storage migration 表行数相同但内部时间戳不同，保留目标平台版本。Storage 对象 ID/所有权/时间戳已恢复，物理版本/生成 metadata 保持东京实际值；全部字节逐个校验通过。一条 CHECK 表达式只有等价括号规范化差异。
- 完整 ACL 对账发现默认权限导致新表多出 anon/authenticated 授权，已通过 `tokyo_restore_source_acl_and_rls_event_trigger` 在目标撤销 51 表多余授权、恢复 2 个函数权限和 `ensure_rls` 事件触发器。此修复在原 12 条 migration 历史之外新增 1 条有意的迁移记录。角色/成员关系、默认权限、RLS policies、Auth/业务触发器、列、索引、扩展的快照对比一致。
- 修复后重新逐一比对 90 个表/序列的所有者、ACL、RLS/强制 RLS 标志，差异为零，证据为 `acl-reconciliation-final.json`。51 张业务表中源/目标均有 50 张启用强制 RLS；剩余平台/迁移用途表沿用原权限，不擅自改变设计。

## 当时中断后的恢复步骤（现已执行，非待办）

1. 用户已明确要求“不用排查，先继续迁移”。不做蓝屏诊断或系统更改；改用单构建 worker、Webpack 低内存选项与独立构建进程，构建/全量测试串行执行，不原样重复之前的重型并发。
2. 保留源作为唯一在线系统。重新冻结/导出并补增量；现有 data restore 脚本有目标非空保护，不能直接重复运行，也不能绕过保护覆盖东京测试/数据。须明确整理目标测试增量并制定差异同步或受控清空恢复策略。
3. 重新导出源平台配置，确认 Resend 只读域名/DNS未变；东京 SMTP 专用凭据已配置但真实投递未验收。
4. 应用生产构建、东京 Web/worker 切换、LISTEN/NOTIFY、HTTP 隔离/文件/学习记录/导出与生成冒烟仍未验收。通过全部删除门槛后，才按已获得的用户授权删除确切新加坡项目。
5. 两项目目前仍并存，重叠计费尚未消除。不要为省费提前删源。迁移管理令牌已出现在对话中，完成后应撤销；不要在报告中再复制任何密钥。

## 本次继续执行记录

- 按用户要求不排查蓝屏。Next.js 改为单构建 worker、独立 Webpack worker、低内存优化；Web/worker 镜像均构建成功。浏览器静态产物 52 个文件包含东京 ref，零文件包含旧 ref。
- 最新冻结备份为 `.scratch/supabase-tokyo-20260925/source-cutover/sql/full-source.dump`（10,922,853 字节）；SHA-256 见同目录 `backup-manifest.json`，`pg_restore --list` 可读取 1,081 项。
- 源库 91 表相较上次最终快照仅 `generation_worker_heartbeats` 内容变化。已对这张表事务同步，写入前另存东京原心跳表；不清空/重导业务数据。最终 51 业务表内容完全一致。文件清单的路径、大小、ETag 与原备份完全一致。
- Auth 登录探针带来的 `last_sign_in_at` 和 `updated_at` 两列变化，以及新增 sessions/refresh_tokens/mfa_amr_claims 是明确测试增量；原用户 UUID、密码哈希及其余字段逐列核对相同，原认证记录均保留。
- 恢复完整列级 ACL：原权限清理误撤销的 `app_accounts` 四列 SELECT 已恢复给 authenticated，保持原 RLS。全库 5 项非空列 ACL 与源一致，审计脚本加入列级权限盘点。目标额外记录两条权限修复 migration，保留原 12 条历史。
- 修复连接配置生成器对 `DATABASE_LISTEN_URL*` 的漏匹配，并将 Web/worker 通知连接主机改为东京 session pooler；不修改 TLS 校验与角色权限。
- `.env.hosted.local` 切换全部项目连接及 S3 凭据；`.env.local` 的公开 Supabase URL/key 同步更新，四项应用加密/会话密钥保持不变。运维脚本与示例地址同步东京，历史报告保留原地址。
- Storage 功能开关已按源配置恢复（仅 S3 开启，其余原未启用功能保持关闭），三桶仍 private。Resend 原域名/DNS 未变，恢复邮件真实投递 `delivered`，实际模板回调含 localhost:3000 和 recovery 流程。
- 全量 Vitest：8,459 通过、0 失败、70 跳过；另有 15 项针对性测试通过。迁移脚本 ESLint 通过。类型检查及 Next.js 生产构建通过。
- 已通过真实课程 Markdown/DOCX 导出；普通资产 HTTP 合约明确要求忽略 Range 并返回完整 200，不误报为支持 206；S3 分段读取单独验收。`classroom-media` 桶为空，没有可供真实媒体播放的旧文件。
- 未为迁移触发付费 LLM/TTS 生成任务。既有普通/Pro 任务、配置、事件数据已迁移，worker 与持久化/通知连接单独核验，不能将其描述为已完成新课程的端到端生成。
- 安全顾问两项目相同：1 项 INFO（迁移表有 RLS 无策略）、2 项原有 WARN（受保护的管理员生命周期 SECURITY DEFINER RPC、未启用泄漏密码保护），未擅自改变现有权限/密码策略。说明：[函数警告](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)、[泄漏密码保护](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)。

## 官方依据（链接）

- https://supabase.com/docs/guides/troubleshooting/change-project-region-eWJo5Z
- https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore
- https://supabase.com/docs/guides/platform/clone-project （Restore to a New Project 保持源区域，不能用作本次跨区搬迁）
- https://supabase.com/docs/guides/troubleshooting/migrating-auth-users-between-projects
- https://supabase.com/docs/guides/platform/backups （数据库备份不含 Storage 文件字节）
