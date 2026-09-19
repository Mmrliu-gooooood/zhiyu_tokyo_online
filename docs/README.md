# OpenMAIC / ZHIYU 技术文档

这里是项目技术文档的统一入口。文档按“现行说明、决策与调研、历史记录”分层；运行时 Prompt、Agent Skill 与包内接口说明继续和代码放在一起，避免移动后破坏加载路径或模块边界。

## 现行文档

- [系统架构](architecture/system-overview.md)：应用入口、生成链路、持久化、后台 Worker 与工作区包边界。
- [部署与运行模式](deployment/runtime-modes.md)：本地开发、标准 Docker、PostgreSQL、后台生成和 MP4 渲染。
- [ComfyUI 工作流配置](guides/comfyui-workflows.md)：工作流存放、节点要求与 API 格式导出。
- [ZHIYU 演示检查清单](guides/zhiyu-demo-checklist.md)：比赛/演示前的人工验收项。

## 决策与调研

- [架构决策记录（ADR）](adr/)：已经接受、替代或仍影响实现的架构决定。状态以各文件头部为准。
- [技术调研](research/)：部署、数据库与认证等选型依据；结论不自动代表已经实施。
- [智域学生端参赛定位访谈](research/zhiyu-student-competition-interview-2026-09-14.md)：学生端范围、代码观察和待讨论的差异化方案；建议不等于已批准实施。
- [智域学生端最高 / 核心改进实施方案](plans/2026-09-14-zhiyu-student-core-implementation.md)：评分、可控互动、学习反馈与补学的原规格；用户已报告完成，当前代码已有对应实现，后续验证见[学生端回归记录](investigations/2026-09-14-student-regression-fixes.md)。原方案的状态描述不替代当前代码。
- [教会学伴：反向教学实施方案](plans/2026-09-14-zhiyu-teach-back-implementation.md)：已实施独立领域模块与课堂接入；默认开关关闭。普通前台、后台和 Pro 生成保持原链路。验证细节见实施报告。
- [Supabase 邮箱账号与用户数据隔离实施方案](plans/2026-09-19-zhiyu-supabase-accounts-implementation.md)：GitHub 认证方案调研、现有代码审查、全链路数据隔离、预置测试 admin、迁移与上线验收；供新对话实施，当前尚未接入账号。

## 模块内文档

这些文件属于对应模块的公共契约，应与实现一起维护：

- [DSL](../packages/@openmaic/dsl/README.md)
- [Renderer](../packages/@openmaic/renderer/README.md)
- [Editor](../packages/@openmaic/editor/README.md)
- [Importer](../packages/@openmaic/importer/README.md)
- [Generation](../packages/@openmaic/generation/README.md)
- [Storage](../packages/@openmaic/storage/README.md)
- [PDF 解析](../lib/pdf/README.md)
- [Prompt 资源](../lib/prompts/README.md)
- [MP4 Render Service](../render-service/README.md)

`lib/prompts/**/*.md`、`packages/@openmaic/generation/**/*.md` 与 `skills/**/*.md` 是运行时资源，不属于普通说明文档，请勿为了“集中”而移动。

## 历史资料

[archive/](archive/) 保存已完成的实施计划、阶段性 QA、故障排查和被替代的设计稿。它们用于追溯，不应作为当前行为的唯一依据：

- `archive/implementation-plans/`：ZHIYU UI、前端架构和生成链路的阶段计划与结果。
- `archive/investigations/`：部署、模型、媒体、语音和课程生成问题的排查记录。
- `archive/design/`、`archive/superpowers/`：历史视觉方案和早期规格。
- `archive/qa/`：阶段性设计验收证据。

## 维护规则

1. 现行能力必须能在代码、配置或测试中找到依据；计划中的能力明确标注“未实施”。
2. 面向使用者的启动方式同步更新根目录的 `README.md` 与 `README-zh.md`。
3. 会持续生效的架构选择写 ADR；一次性方案、排查与验收结果完成后移入 `archive/`。
4. 包级 API、Prompt 和 Skill 文档与所属模块共置，不复制到本目录。
5. 新增或移动文档后检查相对链接，并优先链接本索引而不是复制大段说明。
