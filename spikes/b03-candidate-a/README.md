# B03 候选 A 验证：同库 pgvector + PGroonga + RRF

学习功能方案 B03 第 1 步（[分批实施方案 3.5 节](../../docs/plans/2026-09-27-zhiyu-learning-implementation-plan.md)）。本目录是一次性验证代码，**不进入生产路径**（生产代码不导入这里的任何文件）。结论与决策记录在 [批次台账](../../docs/plans/zhiyu-learning-batch-status.md) 的 B03 节。

## 运行

```bash
node spikes/b03-candidate-a/run.mjs            # 假 embedding，跑完删除容器
SPIKE_HNSW=1 node spikes/b03-candidate-a/run.mjs --keep   # 另测 HNSW，保留容器
```

需要 Docker 与 Node 24。`run.mjs` 构建 `zhiyu-b03-pg:17`（`groonga/pgroonga:3.2.5-debian-17` + PGDG 的 `postgresql-17-pgvector`），在 `127.0.0.1:55434` 起一次性容器，执行 `schema.sql`，用 esbuild 打包 `spike.ts`（这样能直接用仓库的 `lib/rag` 分块器），报告写到 `.scratch/b03-spike/report.json`。

真实 embedding 只在用户明确同意后使用：`SPIKE_EMBEDDING=http SPIKE_EMBED_URL=… SPIKE_EMBED_KEY=… SPIKE_EMBED_MODEL=… [SPIKE_EMBED_DIMENSIONS=1024]`（OpenAI 兼容 `/embeddings`）。

## 扩展启用方式

- 生产（只读核对，2026-10-06）：托管 Supabase Pro，PostgreSQL 17.6；`vector` 0.8.2 与 `pgroonga` 3.2.5 **可用但未安装**。
- 启用：`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions; CREATE EXTENSION IF NOT EXISTS pgroonga WITH SCHEMA extensions;`（Supabase 惯例的 `extensions` schema），写进 accounts 迁移，通过 `apply_migration` 执行。
- `app_web` / `app_worker` 的 search_path 不含 `extensions`（生产核对），所以检索 SQL 一律写成 `SET search_path = pg_catalog, public, extensions` 的函数，表定义里用 `extensions.halfvec`，并给两个角色 `USAGE ON SCHEMA extensions`。
- 本地：PGroonga 版本与生产一致（3.2.5）；pgvector 为 PGDG 当前版本（0.8.7，生产 0.8.2，所用 `halfvec`/`<=>` 在 0.7 起就有）。

## 设计（验证后的形态）

- 表：一行一个 chunk：owner、索引版本、资料、资料版本、页码、block id、文本、内容 hash、`halfvec(1024)`。`halfvec` 每个向量 2 KB（`vector` 为 4 KB）。
- **PGroonga 多列索引** `(owner_id term, index_id term, text full-text)`：owner、允许的索引集合与关键词匹配在**同一次索引扫描**里完成，`pgroonga_score` 有真实分数；只建 `text` 单列索引时，规划器用 btree 过滤 owner，`&@|` 退化为逐行判断，分数全为 0（第一次运行就是这样，已改）。
- 向量侧：**不建 HNSW**，在 owner+允许索引范围内做精确距离排序（范围内召回 100%，无 HNSW 过滤召回问题，也不占额外存储）。
- 融合：向量前 30 + 关键词前 30，RRF（k = 60）取前 k，结果带两路名次与分数（`KnowledgeHit.method = 'hybrid'` 的分项）。
- 关键词：`Intl.Segmenter('zh')` 分词，去停用词和单字，最多 16 个词，`&@|`（任一关键词）检索。
- 权限：函数为 SECURITY INVOKER，调用角色的 FORCE RLS 生效；函数参数里的 owner 与允许索引集合在产生候选的 WHERE 里，不是事后过滤。

## 结果（2026-10-06，假 embedding）

语料：[eval/study-qa/fixtures](../../eval/study-qa/fixtures)（合成中文资料 6 份 + 近似干扰资料 6 份，账号 A 43 个 chunk、账号 B 2 个；48 个标注问题，40 个有答案）。

| 指标 | 混合（RRF） | 仅向量（假） | 仅关键词 |
| --- | --- | --- | --- |
| 有答案问题 recall@5 | 40/40 | 39/40 | 40/40 |
| 查询延迟 p50 / p95（正常范围 ~43 chunk） | 3.1 / 3.7 ms | 2.5 / 2.8 ms | 1.7 / 2.2 ms |

- 权限隔离：606 个返回结果里外账号 0、范围外（含未选的旧版本）0；以 A 的身份直接查表只看到 A 的 43 行；以 A 的身份调用函数并传 B 的 owner 与索引，返回 0 行。
- 来源保真：230 个结果的 chunk 文本都能在对应资料版本、页码的原文中找到，页码/block id 全部回传，扫描页（无文字层）记为未解析页，不产生 chunk。
- 负载（单 owner 2 万 chunk 全部在允许范围内的最坏情况）：写入 0.34 ms/chunk；混合检索 p50 491 ms / p95 521 ms（精确扫描 2 万个向量）；同时其他账号正常范围 p50 2.9 ms。可选 HNSW：构建 1.2 s，51 MB / 2 万行。删除 2 万行 46 ms。
- 存储：表 + TOAST + btree 65 MB / 2 万 chunk（约 3.3 KB/chunk）。**PGroonga 的 Groonga 文件按表观大小计入 `pg_database_size`**：空库装扩展 +43 MB，再建一个空索引 +42 MB，6000 行后约 150 MB 表观（实际磁盘 54 MB），删除行后不缩小（需 `REINDEX`）。生产为 Supabase Pro（含 8 GB 磁盘），当前库 64 MB，可接受；在台账中记为成本。
- 内存：容器空闲 37 MB，跑完 2 万行负载后 190–280 MB（1 GB 上限内）。生产数据库内存在 Supabase，Tokyo 主机零新增常驻进程。

## 结论

候选 A 通过定位、权限、恢复（同库事务/删除/备份）与资源门槛，**选定 A，不验证候选 B**。假 embedding 只验证了管线；语义质量（中文、公式、表格）需要真实 embedding 模型的评测，按约定先征得用户同意再调用（推荐 `BAAI/bge-m3`，1024 维，OpenAI 兼容接口）。

已知限制：单账号允许范围超过约 2 万 chunk 时精确扫描到 0.5 s 量级，生产设每账号索引 chunk 上限，超过前再评估加 HNSW；PGroonga 存储有固定开销且删除不回收。
