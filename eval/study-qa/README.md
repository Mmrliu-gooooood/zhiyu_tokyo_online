# B03 资料答疑评测集

学习功能方案 B03 的可重复评测（[分批实施方案](../../docs/plans/2026-09-27-zhiyu-learning-implementation-plan.md) B03“验收”）。结果与解读记录在 [批次台账](../../docs/plans/zhiyu-learning-batch-status.md)。

## 数据

- `fixtures/corpus.json`：为本仓库编写的**合成**中文学习资料（没有可授权的真实教材，按约定先用合成资料）：高等数学讲义 7 页（正文、公式、导数公式表、一张图的说明、1 页无文字层的“扫描页”）、泰勒公式补充讲义两个版本（第一版有印刷错误，第二版勘误）、数据结构笔记（含排序算法比较表与图说明）、两份互相冲突的考试通知，以及账号 B 的一份资料（隔离用）。
- `fixtures/distractors.json`：账号 A 的 6 份近似干扰资料（大学物理、概率论、操作系统、计算机网络、线性代数、C 语言），词汇相近但不含任何问题的答案。
- `fixtures/questions.json`：48 个标注问题：正文 17、公式 8、表格 5、图 2、扫描页 2、多文档冲突 3、版本 3（含 1 个固定旧版本）、无答案 4、跨账号隔离 4。每题标注可接受的证据位置 `资料@版本#页`、冲突题要求全部来源、无答案题期望“资料中未找到”。

## 运行

需要一个带 vector + pgroonga 的一次性 PostgreSQL（`spikes/b03-candidate-a/Dockerfile` 构建的镜像），例如：

```bash
docker run -d --name zhiyu-b03-knowledge-pg -p 127.0.0.1:55435:5432 -e POSTGRES_PASSWORD=proof -e POSTGRES_DB=knowledge_rls_proof zhiyu-b03-pg:17
EVAL_STUDY_DATABASE_URL=postgres://postgres:proof@127.0.0.1:55435/knowledge_rls_proof node eval/study-qa/run.mjs --answers
```

- 每次运行新建并删除一个数据库，用生产 schema（`ensureStudySchema`，含 v24 的检索表），经真实的 `material_index` 任务处理器建索引，用生产的检索 SQL 与答疑流程。
- 检索方式：`EVAL_RETRIEVAL=keyword`（默认，与生产默认一致：仅关键词索引、不调用 embedding）或 `hybrid`（语义 + 关键词）。`hybrid` 下默认用**假 embedding**（确定性哈希向量），只验证管线。
- 答疑：`--answers` 默认用**假答疑模型**（按关键词重合引用片段），只验证引用校验与保存。
- 真实模型（先征得同意）：`EVAL_EMBEDDING_URL`、`EVAL_EMBEDDING_KEY`、`EVAL_EMBEDDING_MODEL`（OpenAI 兼容、1024 维；可选 `EVAL_EMBEDDING_SEND_DIMENSIONS=1`，SiliconFlow bge-m3 不接受该参数），`EVAL_ANSWER_MODEL=provider:model`（走模型网关，provider 的 key 用其环境变量，如 `SILICONFLOW_API_KEY`）。例：

```bash
SILICONFLOW_API_KEY=… EVAL_ANSWER_MODEL=siliconflow:deepseek-ai/DeepSeek-V3.2 EVAL_STUDY_DATABASE_URL=… node eval/study-qa/run.mjs --answers
EVAL_RETRIEVAL=hybrid EVAL_EMBEDDING_URL=https://api.siliconflow.cn/v1 EVAL_EMBEDDING_KEY=… EVAL_EMBEDDING_MODEL=BAAI/bge-m3 … node eval/study-qa/run.mjs --answers
```
- 报告写到 `eval/study-qa/results/<时间>/report.{json,md}`（不入库）。

promptfoo 方式（同一管线，指标为 recall@5、isolation、version、citation-support、not-found）：

```bash
EVAL_STUDY_DATABASE_URL=… [EVAL_ANSWERS=1] npx promptfoo@0.124.0 eval -c eval/study-qa/promptfoo/promptfooconfig.yaml --no-cache
```

## 指标

| 指标 | 定义 | 拟定门槛 |
| --- | --- | --- |
| evidence recall@5 | 有答案的问题，前 5 个检索结果包含任一标注证据（冲突题需全部） | ≥ 85% |
| 引用支持率 | 每条“资料依据”至少引用一个标注证据位置，或引用片段含预期关键词（自动近似人工抽检） | ≥ 90% |
| 权限隔离 | 检索/引用中出现其他账号或范围外（含未选旧版本）的片段数 | 0 |
| 版本正确 | 固定版本的问题只命中该版本；默认范围不命中旧版本 | 100% |
| 未找到正确率 | 无答案问题的回答为“资料中未找到” | 记录 |
