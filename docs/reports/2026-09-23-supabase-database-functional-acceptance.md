# Supabase 数据库迁移与核心功能验收收口

日期：2026-09-23（北京时间）。结论：**数据库迁移与本轮核心功能验收通过；可以进入上线部署阶段。** 此结论针对已运行的本机应用 + Supabase 环境，不代表生产服务器已经部署或 16 并发容量已经通过。

根据用户本轮明确要求，先完成数据库迁移、保存、读取、账号隔离及核心功能验证；性能与非阻断性体验优化后置。原计划完整 T8 扩展矩阵、T9 负载验收仍未完成，不再作为本轮数据库功能收口的前置条件。历次原始证据见[完整验收记录](2026-09-21-supabase-storage-capacity-acceptance.md)。

## 已通过的检查

| 范围 | 实测结果 |
| --- | --- |
| 原始数据迁移 | 原始 115 门课程、459 场景、1484 个对象，511178031 字节完成迁移校验；迁移账本 complete，64 条原删除状态保留，旧匿名归属已处理 |
| 最终资产完整性 | 收口查询：130 门课程、474 场景、1548 个资产条目及 1548 个 blob；条目缺 blob = 0、blob 缺私有对象 = 0。新增数量来自验收课程，不是原始迁移数量 |
| 私有存储 | zhiyu-assets / zhiyu-materials / zhiyu-classrooms 三桶均 private；实际图片、音频已通过受保护路径读回 |
| 账号隔离 | 管理员可读写自己的课程、学习记录；另一账号访问相同资源为 404；匿名访问及外来 learner marker 为 401 |
| 删除生命周期 | 使用独立临时账号完成删除验证、共享 hash 保留与最终回收、Storage/Auth 失败重试；真实管理员保留 |
| 新课程生成 | 普通前台、普通后台、Pro 各有独立成功课程，持久化完成标记均 true，均保持 private；课程、图片、语音可以重新打开使用 |
| 老课程与学习记录 | 重建后旧课堂、交互内容、白板、学习反馈和历史记录恢复；实际完成恢复学伴练习、解释、评价、结束；失败后重试及平台助教语音成功 |
| 保存与导出 | 前台课程改名保存并读回；实际导出完整 MAIC ZIP，包含 manifest、1 张图片及 7 条音频；Pro 实际导出 PPTX 含 1 页及 2 个媒体文件 |
| 取消任务 | 前台准备阶段返回首页；后台任务从 queued → running 后取消，API 200、云端 cancelled，错误为空 |
| 重建与回归 | 新镜像构建成功、readiness 通过；TypeScript 通过；稳定全套 8457 测试通过、70 跳过，813 文件通过、14 跳过 |

## 三种生成模式的独立证据

| 模式 | 课程 ID | 结果 |
| --- | --- | --- |
| 普通前台 | `bK4mbbRke1` | 2 页、1 张图片、7 条音频，改名/重新打开/播放/编辑/ZIP 导出通过 |
| 普通后台 | `3edb7d54-c8b0-4e2f-965f-00b156c589f5` | job `0c4303fd-8a9b-4361-b02a-cd9c01430c9a` 成功，1 页、1 张图片、6 条音频，关闭后返回及课堂读取通过 |
| Pro | `e48a0067-5d13-43fd-88db-041f30880af4` | session `bf96ad86-3a9d-4ff5-b832-5c5e5b615f82` 与 job `b167a802-feba-4b8f-9b1a-a432449f175f` 成功；材料读取、1 页、1 张图片、5 条音频，工作台恢复、课堂播放、PPTX 导出通过 |

前台旧验收样本的大纲已完成、2 页已保存，但元数据完成镜像曾为 false；本轮核实完整文档后通过现有 owner-only generation-complete API 补齐（200），最终 SQL 确认 true。这是一次样本状态修复，不据此声称自动完成标记同步的所有路径已回归。

## 最终运行状态与证据位置

- 保持 **Tier 4 / Background / 2 workers / 接收任务**；17:16 readiness 为 ready=true，账号 schema v19、生成 schema v4、worker 2/2、私有桶 3/3。schema v19 不是 19 个账号，实际保留 3 个账号。
- Web 镜像：`sha256:db574a597bf061ce530c1166b7059dd6917444841c2b16c3feb987bd98770056`。
- Worker 镜像：`sha256:0627f6d31735aab99ed02d6023ee18029e4650bddf96a9129bcbb3b50bda3525`。
- 最终 SQL：活动生成任务 0、有效模型占用槽 0；Pro 会话均已终态。取消样本 `5347b2ca-ce30-4bc5-9adc-4c0d7d62efc3` 为 cancelled。
- 旧 PostgreSQL、旧应用保持停止；原卷、备份及真实管理员未删除。浏览器受控网络阻断已撤销，验收标签页已关闭。
- 全套回归：`.temp/supabase-full-tests-auth-reuse-20260923.log`；构建：`.temp/supabase-auth-reuse-build-20260923.log`；恢复后台配置：`.temp/supabase-final-background-20260923.log`。
- 真实请求证据：`.temp/runtime-auth-reuse-admin-20260923.jsonl`、`.temp/runtime-auth-reuse-user-a-20260923.jsonl`、`.temp/pro-media-bytes-after-rebuild-20260923.jsonl`、`.temp/background-cancel-20260923.jsonl`、`.temp/foreground-completion-20260923.jsonl`。
- 临时账号生命周期：`.scratch/cloud-deletion-proof-30191821-0185-4a2b-ab70-3fdaf02c084d.json`。

## 后置事项与结论边界

实际远程读取仍有数秒至数十秒等待，尚无 P95/SLA 结论；16 并发与 8-owner 真实负载未执行，不能按 16 并发已验收宣传或配置上线。原完整 T8 的其余矩阵、生成图片是否严格满足教学细节、编辑器部分配音标签等体验问题保留，按用户要求本轮不继续优化。

本轮未发现已验核心路径的数据丢失、越权读取或私有对象缺失阻断项。下一阶段为目标生产环境部署及该环境的登录、读写、生成冒烟检查；生产域名、HTTPS、Auth 回调和服务器切换不属于本报告已完成内容。
