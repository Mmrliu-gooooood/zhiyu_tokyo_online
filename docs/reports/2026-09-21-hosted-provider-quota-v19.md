# hosted Web 模型调用额度权限修复（accounts v19）

2026-09-21，浏览器教会学伴 prepare 返回 503，错误为 `permission denied for table generation_provider_slots`。

## 根因与修复

共享 LLM 层 `withGenerationModelQuota` 使用请求侧 `app_web` 数据库登录，但 `PostgresGenerationLimiter` 原先直接读写 worker 专用槽位表。该表不给 Web 权限是正确的隔离边界；此外，普通请求侧 quota 事务此前没有绑定 `app.owner_id`。

v19 在 `app_internal` 增加 acquire、heartbeat、release、cooldown 四个窄函数。函数要求 active owner，仅允许 `llm:` / `tts:` / `media:` 额度组，并绑定 owner、holder UUID、slot、epoch。公共角色 `anon` / `authenticated` 没有执行权限，Web 仍然没有槽位表直接读写权限。租约失效、未知结果隔离、供应商 429 cooldown 均沿用原有语义。

请求身份在可信 principal 边界通过 AsyncLocalStorage 传递，每次 quota 短事务都使用事务内 owner 设置，不让身份留在池连接上。通用 `withApiPrincipal`、Pro `withRequestOwnerId`、后台生成 HTTP `withGenerationRequest` 均已绑定；旧课堂 chat/Pi、coach、check、quiz-grade、verify-model、web-search 使用共享验证包装。教会学伴使用已验证 principal。客户端提交 owner 字段不参与授权。

worker 默认 limiter 构造及直接数据库路径不变。普通前台的受支持配置 `GENERATION_BACKGROUND_ENABLED=0` 保持现有同步路径，不触发此背景模型 quota wrapper；前台根任务继续由已有 foreground 2/16 fencing 控制。

## 本地验证

- 独立 PostgreSQL 16，真实非超级用户 `capacity_proof_web` 登录继承 `app_web`，配合现有真实 owner 上下文测试。
- 新场景验证共享额度竞争、跨 owner 续期/释放/cooldown 拒绝、错误 epoch、缺 owner、inactive owner、禁止重任务 reservation 组、deadline 边界、anon/authenticated 拒绝、未知结果 quarantine、429 cooldown、释放与重用。
- teach-back API 测试验证模型调用中实际 owner 来自已验证 principal，忽略 payload 伪造 owner；请求结束后上下文为空。
- 第一轮 4 文件 94 项通过；追加 3 文件 28 项通过；扩展课堂/身份/compose 回归 7 文件 79 项通过。
- Pi/verify-model 扩展 5 文件 46 项首次有 1 项超过原 15 秒超时，45 项通过；未放宽超时，单独重跑对应文件 11 项全部通过（10.30 秒）。
- 最终 `tsc --noEmit --pretty false` 退出 0。

各轮存在重复覆盖，数量不能相加宣称独立测试总数。

## 云端迁移与真实 app_web 验证

Supabase `lzomhnjyymalupgvcato` 已应用增量 migration `hosted_provider_quota_owner_fences_v19`。只增加槽位 holder_owner_id 列及函数；没有授予 Web 表权限，没有提升数据库角色，也没有删除用户或课程。

`app_schema_migrations` 当前版本 **19**，checksum：

```text
5fa6f48e724236c18114ef9f43288deb7511bf754bb09af29b8f7add28bacd65
```

使用运行中 Web 容器的实际 `zhiyu_app_web` LOGIN 连接，证书校验保持开启。在独立随机 `llm:verification-<uuid>` 组中，以现有 verified owner 进行数据库权限验证；整个验证事务最终回滚，不残留测试槽位。返回：

```json
{"passed":true,"loginRole":"zhiyu_app_web","acquire":true,"heartbeat":true,"staleEpochRejected":true,"cooldown":true,"release":true,"missingOwnerRejected":true,"directTableAccess":false,"allFixtureWritesRolledBack":true}
```

MCP 管理连接没有 `SET ROLE zhiyu_app_web` 权限，因此该尝试未用于证明；上面的结果来自实际 Web 登录，不依赖超级用户模拟。

代码需纳入统一新镜像后，再由主验收任务复测浏览器教会学伴与课堂。数据库测试通过不能单独替代浏览器整条产品流程验收。
