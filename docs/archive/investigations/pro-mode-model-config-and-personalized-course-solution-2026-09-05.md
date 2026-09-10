# 已替代：PRO 模型配置与定制课程综合方案

本方案已根据用户最新要求收缩，当前唯一实施依据为：

[PRO 无法使用 Home 模型配置的最小修复方案](pro-home-model-config-bugfix-plan-2026-09-05.md)。

本阶段仅修复 Home 模型配置未贯通 PRO，导致消息执行失败、无法生成课程的问题。沿用已有对话、提问卡片、skill 及共用课程生成函数，不增加默认 1～3 轮追问，也不新增全局课程方案确认流程。

动态测试、Lesson 计划、checkpoint、动态题集、assessment attempt、报告及建议闭环均为后续独立工作，不纳入本次修复的依赖、实现或验收。

本页保留原文件路径以兼容已有链接。旧决策的替代关系见 [ADR-0007](../../adr/0007-fix-pro-model-binding-with-existing-generation.md)。
