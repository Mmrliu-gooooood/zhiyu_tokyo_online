# Docker 可选联网搜索不可用：2026-09-14 排查

## 结论与真实状态

在现有 `zhiyu-worker` 容器内，以当前 Brave 适配器相同的地址、请求头和公开测试查询发起一次请求，重现 **HTTP 429 Too Many Requests**，耗时 3255 ms。服务器返回了 HTML 页面，而非成功搜索响应。因此本次失败是 Brave 公共网页搜索端拒绝请求，不是 DNS 无法解析、Docker 完全无法联网，也不是 PPT/学生端 UI 改动导致。429 本身不能进一步证明是用户个人请求过多、共享出口限流还是服务端风控。

容器与 `.env.local` 的只读核查仅输出配置是否存在，没有输出值：Brave 以及其他搜索供应商的 API key 均为空，HTTP/HTTPS 代理为空；worker 的 SearXNG 地址也为空。Compose 已列出搜索 key 与地址的传递，并无本次所需 key 漏传证据。

**本次已完成根因排查和日志修复，未恢复外部 Brave 搜索可用性。** 用户可在现有联网搜索设置中配置有效的 Brave API key，或选择已有支持的其他供应商并配置有效凭据；服务端 `.env.local` 也支持相应配置。之后应新建一次启用联网搜索的课程验证。已有课程的可选失败搜索被检查点缓存为空，续生成不会重复访问失败的搜索接口。

## 最小代码变更

- Brave HTTP 失败携带结构化 `status` 与 `mode`（`public_html` / `api`），保留原有请求和异常行为。
- 现有后台可选搜索的警告增加安全白名单信息：供应商、失败分类、HTTP 状态及模式。公共网页 429/403 附固定配置提示。
- 诊断不复制上游异常文本、HTML 响应、查询、URL 或密钥。DNS、超时、连接错误采用固定分类。
- 不改变普通/Pro 生成编排、模型绑定、请求次数、重试和取消逻辑；不自动切换供应商或代理。可选失败仍保存空检查点并继续，Pro 原有失败路径保持。

示例新增日志内容：

```json
{"provider":"brave","reason":"rate_limited","status":429,"mode":"public_html","action":"Configure a valid search API key in Web Search settings"}
```

## 验证

- 先添加断言重现：旧适配器不提供 HTTP 状态/模式，2 个新增断言失败；实现后通过。
- Brave 成功解析、无 key 的 429、API 的 401，且错误不包含原始响应或 key。
- 真实 `GenerationServices.research()` 边界：429 输出脱敏诊断、只调用一次、仍提交空检查点；普通成功、Pro 失败、取消传播和快照配置的原有测试均通过。
- 搜索适配器、搜索配置、普通前后台可选搜索、agent-runtime 搜索及快照消费回归：**18 个文件通过，182 个测试通过；1 个依赖未配置 SearXNG 的真实服务测试跳过**。
- 未重启或部署 Docker；由主任务统一构建并更新 Web/worker 镜像。
