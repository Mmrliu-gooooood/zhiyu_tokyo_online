# 智域学生端「最高 / 核心」改进实施方案

日期：2026-09-14。状态：**供新对话执行的实施规格，本文新增功能尚未实施**。

目标：在现有通用课程助手上，完成「可控互动 → 可靠测评 → 有依据的反馈 → 针对性补学」。保留当前完整 UI，优先保护普通模式和 Pro 模式的课程生成。本轮仅编写文档；工作区已有的互动修正属于此前工作，不应回退。

## 1. 范围与执行优先级

用户已确认：学生端优先；用户自由输入想学的课程；一人加 AI 开发，每周约 30 小时；距提交约十天；可邀请 10–50 名学生试用。这里的试用人数是可联系人数，不是已经验证的效果数据。

| 优先级  | 工作项                   | 本次完成标准                                                                                 |
| ------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| 最高 H1 | 讨论有界、结束后恢复讲解 | 验证并完善现有修正；不输入就停止自动续轮，手动结束无需切页即可恢复被打断的讲解               |
| 最高 H2 | 真实评分与可恢复批改     | 前后端去除失败补半分；保存原题和原答；待批改可重试，不伪造正确率                             |
| 核心 C1 | 有核查的互动答疑         | 学生主动选择；解释草稿经核查后发布；最多修正一次；轮到学生时必须等待真实输入                 |
| 核心 C2 | 学习检查与证据化反馈     | 已生成课程可手动发起小测；报告展示真实题目、作答、评分依据和薄弱点；与课程原有 Quiz 分开统计 |
| 核心 C3 | 错题驱动补学             | 从结果回看相关页面、针对原错题讨论、用一道新题再检查；保存前后两次实际作答                   |

**“核实账号与数据隔离”不纳入本次实施任务或验收前置条件，移到后续拓展。** 保留现有 `learnerKey`、RuntimeStore 分区和鉴权行为；这不是删除隔离检查的授权，也不代表已有跨设备账号系统。以前部署 ADR 的长期要求没有在这里被宣称已完成。

本次不做：人类教师端、班级管理、支付、账号改造、全学科知识图谱、跨课程长期记忆、固定学前问卷、生成时重构 Lesson/检查点计划、逐页强制测验、自动重写整门课、动态扩充 AI 团队、独立研究平台、强制开启 Pi、Pro Agent Runner 重构。

十天内先交付以上各项的最小纵向闭环。若工期不足，先保 H1/H2，再完成一条「检查—反馈—补学」路径；未完成项必须在交接记录中明示，不能通过砍普通/Pro 功能、隐藏原 UI 或伪造演示数据换取完成标记。

## 2. 代码审查依据与关键发现

审查基线：`HEAD 68ace01b` 加当前未提交工作区。实施前重新记录 `git status --short`，读取当前文件及适用的 AGENTS.md，不执行 reset/clean，不覆盖此前修改。下列路径均相对于仓库根目录，列出职责而不固定易失效的行号。

| 实际链路 / 文件                                                                          | 检查到的事实                                                                                                          | 实施影响                                                                                                        |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `components/stage.tsx` → `components/edit/PlaybackChromeRoot.tsx`                        | 课堂播放与编辑壳共享业务状态和生命周期                                                                                | 不能另写一个简化 Stage 替代；新功能只做局部接入                                                                 |
| `components/stage/scene-renderer.tsx` → `components/scene-renderers/quiz-view.tsx`       | 实际课堂测验由 QuizView 展示、提交、批改、恢复                                                                        | 不要误改 `components/scene-renderers/quiz-renderer.tsx` 的简化展示后就宣称功能完成                              |
| `lib/chat/agent-loop.ts` → `components/chat/use-chat-sessions.ts`                        | legacy 路径每轮请求 `/api/chat`；工作区已加入 QA 3 次、discussion 6 次上限及 `turn_limit` 交还输入                    | 保留已修行为，验证迟到事件、取消、音频缓冲，不重复写另一套默认循环                                              |
| `lib/playback/auto-resume.ts`、`PlaybackChromeRoot.handleSessionStop`                    | 已允许符合条件的 `manual_stop` 恢复；清理后异步创建 lecture session，再检查 engine 身份和模式                         | 切页、报错、无中断位置时不能自动播放；当前修正还需要真实浏览器验证                                              |
| `lib/chat/pi/director-loop.ts`、`config.ts`、`tools/cue-user.ts`                         | Pi 有独立轮次/动作限制；默认最多 6 个 agent turns，每 agent 最多 8 个 actions；可 cue/close                           | 普通/Pro 与 legacy/Pi 是不同维度，不能混为两种课程生成模式                                                      |
| `lib/chat/pi/tools/call-agent.ts`、`prompts.ts`                                          | 当前会把 agent 文本发到 SSE；可见输出发生在新增核查之前；部分 peer 摘要为截断预览                                     | 仅添加“核查员”人设不能形成发布前审核；核查必须收到完整、限长的原题、证据和候选文本                              |
| `app/api/quiz-grade/route.ts`                                                            | JSON 解析失败给半分；`Number` 转换加 clamp 未严格拒绝 NaN、字符串分数等                                               | API 必须严格校验输出，失败返回错误而不是假成绩                                                                  |
| `quiz-view.tsx` 的 `gradeShortAnswerQuestion`                                            | 请求失败也给半分，并作为结果进入 reviewed                                                                             | 只修 API 不够；前端必须独立处理 pending/error                                                                   |
| `lib/quiz/grading.ts`                                                                    | `QuestionResult` 仅支持已判的 correct/incorrect；选择题按显式 type 分类；缺失标准答案和空作答可能同为 `[]`            | 缺答案的题不能判对，也不能偷偷转 AI；pending 应独立建模，避免冲击所有旧消费者                                   |
| `lib/quiz/runtime.ts`、`view-state.ts`                                                   | payload v1 仅保存阶段、答案和结果，没有原题；submitted 恢复成 answering；已有队列、Web Locks、CAS 和重试 attempt 处理 | 原答提交后必须冻结；保存快照；保留并发处理而非换成一组 localStorage 键                                          |
| `lib/classroom/complete-summary.ts`、`classroom-complete.tsx`                            | 完成页读取答案，用当前课程题目重新算选择题，未以完整 reviewed 记录汇总简答评分；读答案不区分 draft/submitted/reviewed | 必须修正数据来源；原布局、奖杯、动效、短屏滚动和自适应阈值保留                                                  |
| `PlaybackChromeRoot` 的 `isCourseComplete`                                               | 该变量主要表达生成结果可用/末尾占位状态，不是持久化的学生掌握或逐课学习完成证明                                       | 禁止用它写入“学生全部学完”事实；新报告第一版不假造完成率                                                        |
| `lib/chat/quiz-results-for-store-state.ts`                                               | 已有当前 Quiz 已批改结果注入，带异步切页保护                                                                          | “让 AI 看到当前错题”已有基础；新价值是跨页面仍绑定正确原题、核查与补学闭环                                      |
| `lib/pbl/v2/operations/runtime/quiz-snapshot.ts`                                         | PBL 也消费 Quiz 结果                                                                                                  | 不扩大 `QuestionResult` 联合类型后漏改 PBL；待批改不能当错题或达标                                              |
| `lib/runtime/store.ts`、`payload-validators.ts`、`lib/persistence/bootstrap.ts`          | 已有 Browser/HTTP provider 和应用层 payload validators                                                                | 使用现有 RuntimeStore；新增 kind/payload 不应重建存储系统或在服务端 import 浏览器单例                           |
| `packages/@openmaic/storage/src/runtime/types.ts`                                        | session kind 可由应用定义；只对 active session append；seq 排序；支持 expectedLastSeq 和原子状态转换                  | 追加事实、CAS 重读、完成后另开 attempt；不能向 completed session 继续写                                         |
| `app/generation-preview/GenerationSessionController.tsx`                                 | 普通前台路径先生成首场景、actions/TTS，持久化候选课程后才发布到 Store，随后课堂继续生成；另有后台 job 观察分支        | “能进入课堂”不等于“全课程生成结束”；检查入口必须正确识别未完成状态                                              |
| `app/api/generate-classroom/route.ts`、`lib/server/generation-pipeline/pipeline.ts`      | 后台生成有幂等提交、规划确认、checkpoint、模型/媒体快照及 Worker 流程                                                 | 不把检查、报告或 reviewer 接入生成成功判定、重试或确认流程                                                      |
| `lib/server/agent-runtime/generation-job-tools.ts`                                       | Pro `submit_course_generation` 验证计划后提交 durable job；共享后续 pipeline                                          | 不改工具契约、技能别名、typeMix、目标课程 revision 或模型绑定                                                   |
| `WorkspaceClassroomPane.tsx`、`ClassroomSurface.tsx`、`lib/workbench/stage-freshness.ts` | Pro 托管课堂有独立加载/可见性语义；隐藏 pane 可能仍挂载；共享 Store 需防止旧结果串到新课程                            | 新学习任务按 stage/learner/view lifetime 隔离，隐藏 pane 不自动发请求；工作区 revision 不能直接充当学习内容版本 |

审查覆盖函数内提交/恢复/取消分支、数据消费者、前台与后台生成的交接、现有单元/集成与浏览器测试定义，并执行了第 10 节列出的测试。没有在本轮启动真实课堂、真实模型或 PostgreSQL 部署验证，不能将代码推断写成现场复现。

## 3. 必须保持的边界

### 3.1 普通 / Pro 生成零新增依赖

1. 不修改生成请求必填字段、Stage/Scene 必填字段、outline 结构、generationSession/sessionStorage 协议、generationComplete 语义、模型配置来源、技能路由或持久化格式。
2. 不向生成 worker、首屏生成、Pro 提交工具加入测评生成、审题、报告生成或等待学生的步骤。新功能失败、关闭、超时，课程仍应照常生成、进入课堂、续生成、重试。
3. 不为了出题插入 Quiz Scene，不调用 `setStage`/`addScene`/编辑命令把学习检查写回课程；不让补学触发整课重生成。仅将课程作为只读材料。
4. 不在普通/Pro 的课程 load、任务轮询、切页或组件 mount 时发起学习模型请求。显式点击才启动；历史记录读取可以发生在打开反馈面板时。
5. 前台仅生成首场景时，仍可使用现有问答和该页 Quiz；全课检查显示“课程仍在生成，可稍后检查”，不占用生成队列。后台 failed/cancelled 也不能被当作全课 ready。
6. 无 generation metadata 的导入/旧课程，只在无活跃生成任务且已有稳定内容时允许创建检查；有不明 pending 状态时只阻止新检查，不阻止原课程。

### 3.2 UI 保留清单与允许增量

保留：首页普通/Pro 入口、模型与媒体配置、生成预览与确认页、课程目录及生成状态、四类场景、播放条、圆桌与角色、聊天/讲解笔记两个标签、白板、设置、主题/语言、演示/全屏、编辑器、Pro 对话/工具/课堂 tabs、既有导入导出入口、完成页全部内容及窄屏滚动。

允许的 UI 改动仅为：

- 现有课堂交互区域增加一个紧凑“学习反馈”入口；放在播放壳中的交互区域，避免只放在 hosted 模式会隐藏的全局 HeaderControls 中。窄屏放入现有菜单或局部收纳，不挤掉原按钮。
- 使用现有 `components/ui/dialog.tsx` 建立一个学习反馈 Dialog，内部展示检查、历史、报告；不新建替代课堂页面，不改变 Stage key 或卸载课堂。
- 原答题结果区域增补“重试批改”“回看讲解”“针对这题讨论”；保留原“重新答题”的含义。待批改提示替换错误评分文案属于必要修正。
- 现有聊天输入区增加默认关闭的“核查式答疑”选择；仍使用原 SessionList/消息/圆桌渲染，不新建一套聊天界面。
- 完成页只更换统计数据来源和必要状态文字，可增加打开同一反馈 Dialog 的小入口；保留奖杯、动效、标题、场景统计、响应式结构。

新增组件样式局部生效；不改全局 CSS、尺寸 token、布局断点或原有组件隐藏条件。默认关闭新功能时，除 H1/H2 真实错误修正外，原 UI/交互应与基线一致。Dialog 关闭焦点回到触发处，不重载页面；不能靠大范围更新截图基线掩盖缺项。

### 3.3 第一版学习语义

本次交付的是**手动课程检查及学习反馈**。不实现“每个 Scene/Lesson 均学完才记课程完成”的完整进度模型，不把页面末尾、AI 发言数、作答次数当学习完成或掌握率。

沿用 ADR-0002/0004 的题目归学习者 runtime、原题不可变、按内容版本分离的原则。本次暂不执行 ADR-0002 中“生成时建立共享 Learning-check plan”的完整设计，也不实现 ADR-0003 全部完成事实。报告第一版称“学习反馈”，避免冒充 CONTEXT 中定义的完整 Course report。后续若扩大范围，应另补 ADR，不追改旧决策为“已完成”。

## 4. 用户故事

1. 作为学生，我希望一次提问后 AI 自动收束并把话轮交给我，以便决定继续还是结束。
2. 作为学生，我希望结束讨论后同页恢复被打断的讲解，以便连续学习。
3. 作为学生，我希望暂停、切页和退出后旧消息不再发言，以便控制播放。
4. 作为学生，我希望提交后保存当时的题目和答案，以便之后准确回看。
5. 作为学生，我希望批改失败显示待批改并可重试，以便得到真实成绩。
6. 作为学生，我希望重试批改保留原答、重新答题产生新记录，以便区分两种操作。
7. 作为学生，我希望选择核查式答疑后看到有依据的简短解释，以便理解关键条件与争议。
8. 作为学生，我希望 AI 邀请我作答后等待我的输入，并允许跳过，以便自主参与。
9. 作为学生，我希望没有课程自带测验时也能发起一次小检查，以便确认理解情况。
10. 作为学生，我希望看到哪些结果已经评分、哪些仍待核实，以便理解反馈的依据和限制。
11. 作为学生，我希望从错题直接回看对应讲解或继续讨论，以便补足具体问题。
12. 作为学生，我希望用一道新题检查补学后的理解，以便看到真实前后变化。
13. 作为学生，我希望刷新、断网恢复、换课程或课程编辑后记录仍可辨认，以便不丢答、不串题。
14. 作为普通/Pro 用户，我希望生成、编辑、播放和导出保留原来功能，以便新增学习功能不打断已有工作。

## 5. 最高 H1：有界讨论与恢复讲解

### 5.1 从现有修正继续

当前工作区已改 `lib/chat/agent-loop.ts`、`components/chat/use-chat-sessions.ts`、`lib/playback/auto-resume.ts` 及相关测试；`PlaybackChromeRoot.tsx` 和 `engine.ts` 的部分改动为解释性注释。先看 diff 和测试，不把它们恢复成上游版本再重写。

| 结束原因                           | 应有行为                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| legacy 本次达到 3/6 次自动请求上限 | 当前输出排空后交还输入；不继续请求，不把课程或会话判定完成                                   |
| `cue_user`                         | 保持等待；组件重渲染、计时器、AI 消息均不得自动触发下一请求                                  |
| 用户主动继续/新提问                | 才开始新一轮预算；历史保留                                                                   |
| `manual_stop`                      | 取消网络/缓冲/音频，复用 existing cleanup；有讲解中断、引擎 idle、内容未耗尽且未完成时才恢复 |
| 切页/切课/切编辑、卸载、异常       | 清退旧资源；不得使用 manual_stop 意图，避免旧课自动恢复                                      |
| 无被打断讲解 / 已在末尾            | 只结束当前讨论，不凭空播放                                                                   |

保留 `handleSessionStop` 对异步 `startLecture` 后 engine 身份及模式的再次检查。停止、清理、恢复必须串行；网络返回、TTS 完成、buffer drain 的迟到回调均带 producer session 身份检查。等待输入与停止会话是不同状态，不新增 `while(true)` 或自动“继续”定时器。

### 5.2 验收

- legacy 连续有效响应也最多 3/6 次；服务端陈旧 turnCount 无效；模型提前 cue/end 不补满次数。
- 达到上限后观察一段空闲期，网络调用数不增长；用户发新消息后才增长。
- TTS 开/关各验证：讲解中提问 → AI 回答 → 手动结束 → 无导航恢复同一中断位置，只有一套音频。
- stop 后立刻切页、连续点 stop、startLecture 尚未返回时切课，旧引擎不能抢占新页。
- Pi 开启的现有 cue/close/预算行为另测；不因 legacy 修正强行开启 Pi。
- 若现场仍卡住，记录 sessionId、engine mode、cleanup 起止、buffer/TTS 状态再定位；不要以“多等一会儿”或页面刷新代替修复。

## 6. 最高 H2：真实评分、题目快照与批改恢复

### 6.1 数据与评分契约

新增应用层 `lib/quiz/attempt-schema.ts`，将 Quiz payload 扩展为 v2；DSL 的 `draft/submitted/reviewed` 三阶段保持不变。不要把包级 runtimeDslVersion 当应用 payloadVersion 使用。

| 字段               | 约束                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `payloadVersion`   | 新写入为 2，兼容读取 1                                                                                   |
| `phase`            | draft → submitted → reviewed；有未完成批改时保持 submitted                                               |
| `questionSnapshot` | 第一次开始答题时冻结题目 id/type/text/options/answer/analysis/commentPrompt/points；保留题序及所需标题   |
| `contentRevision`  | 与快照绑定的学习内容指纹及算法版本，不使用 updatedAt 或 Pro manifest rev 代替                            |
| `answers`          | draft 可修改；submitted 后不可更改；改答必须新 attempt                                                   |
| `grading`          | 每题 `pending / graded / unavailable`；包含结构化错误码、是否可重试；只有 graded 含有限合法 score/result |
| `results`          | 兼容旧消费者，只投影有效已评分结果；旧的“已 reviewed”入口须等全部题可评分且已持久化才开放                |
| `gradeProvenance`  | 记录评分规则版本、模型标识、依据来源与评分时间，不存 API 密钥                                            |

`unavailable` 表示缺标准答案/无可用评分依据等不能靠原样重试解决的问题；不把它计作 0 分。全部题都成功评分才进入 reviewed/completed。含 unavailable 的 attempt 保持非最终结果，允许学生放弃它并显式新建 attempt；旧记录保留并标记 archived，不自动宣布成绩完成。

`QuestionResult` 继续表达已评分结果。pending/unavailable 由上层模型承载，不能用 `correct: null, earned: 0` 冒充“尚未评分”。先审查所有消费者再调整接口，特别是 chat quiz snapshot、PBL 和完成页。

### 6.2 `/api/quiz-grade` 与前端同时修

1. 服务端请求严格检查类型、长度、points、题目/答案；支持原题快照中的评分要点和参考依据。题面、资料和学生答案当作数据，不能让它们覆盖评分指令。
2. 空白答案按明确的“未作答”规则确定性记 0，不请求模型。缺评分依据的题进入 unavailable；不要将题目坏数据当学生错误。
3. 非空简答只有取得合法结构化评分才产生 result。要求 score 为 number、finite、处于允许范围，comment 为限长字符串；不接受字符串强转、不把越界值 clamp 成合法分、不从混杂文本截出疑似 JSON 后直接信任。
4. 第一版保留现有整数计分习惯；若满分含小数，先定义该题的合法计分单位并校验，不能 round 后超过满分。不要无意改变已有分值含义。
5. 成功保留 `success/score/comment` 兼容字段，可附评分依据；错误使用现有 apiError 格式并给出稳定 code，例如 `INVALID_GRADE_OUTPUT`、`GRADING_TIMEOUT`、`GRADING_UNAVAILABLE`。错误响应中没有 fallback score。
6. 客户端同样验证 response，删除 catch 半分逻辑，失败记 pending/unavailable。网络失败、429、5xx、输出无效均不计作“答错”。
7. 使用现有 `resolveModelFromRequest` 和 `callLLM`，延续当前模型选择/平台配置，不创建独立密钥配置。将请求取消信号与超时传至 `callLLM` 的 `abortSignal`；本功能显式控制 SDK `maxRetries` 与外层重试，避免预算外自动重复。
8. 初始上限：单次批改 45 秒，客户端同一 attempt 最多两道简答并发；失败后由用户重试，不后台无限重试。这是实现预算，可经实测调小；不是对真实延迟的承诺。

### 6.3 持久化和恢复次序

`QuizView` 操作顺序：读取/建立快照 → 答题 draft → 持久化 submitted 与原答 → 启动批改 → 每题成功即时追加结果 → 全部成功时原子写 reviewed + completed → 展示最终成绩。

- 部分成功后断网：已保存评分保留；刷新恢复 submitted/待批改视图，不能重新变成可编辑 answering；“重试批改”只处理未完成题，继续同一 attempt。
- “重新答题”沿用显式创建新 attempt 的语义，清空新答卷，历史不覆盖；新题快照来自当时课程。不要复用这个按钮做评分重试。
- 切页/卸载取消网络和 UI 更新；已经开始的写入只能落在捕获的原 attempt 分区。课程、scene、attempt、view lifetime 不匹配的返回不能更新当前页面。
- 两标签页重复批改使用 request/answer digest 和 CAS 去重；一个题同一提交接受的首个持久化合法结果成为事实，冲突重读，不能以迟到响应改成绩。
- 现有 writer 对 completed session 的不同 payload 可能自动 rollover；v2 必须区分“显式重新答题”和“原提交的迟到评分”。评分写入绑定原 attempt 与 submitted digest，冲突后只能重读/丢弃，绝不能自动滚入新 attempt。只有学生明确重答才允许新建答卷。
- 复用现有队列、Web Locks、有/无锁 CAS 回退和原子 sessionTransition；v2 的 samePayload/校验必须包含快照及 grading，避免把新增结果误去重。
- `lib/runtime/payload-validators.ts` 增强 quizAttempt 校验，保留整个现有 validator map；Browser 与 HTTP 入口都覆盖。无需改 SQL 表或包 DSL。
- v1 历史照常可读，显示“旧记录，缺少题目快照”；不要拿当前题目补成“历史原题”。新报告不将这类分数混入有证据的汇总。尚未提交的旧 draft 可在明确记录迁移来源后绑定当前题快照；旧 submitted/reviewed 不可这样回填历史事实。

### 6.4 完成页的必要修正

修改 `lib/classroom/complete-summary.ts` 的输入，从“当前题目 + 任意阶段答案重新评分”改为“已持久化 attempt 投影”。`ClassroomCompletePage` 保留表现层。

原环形“答对 n/m”仍只展示可证明的已批改客观题；简答得分另以必要文字或反馈 Dialog 展示，不混成同一正确率。无已评分数据时显示“暂无已批改结果”；有 pending 时显示待批改数量。课程场景数量仍是内容统计，不改成学生完成数量。

不得把草稿、解析失败补分、当前题目重算后的分数计入成绩。v1 历史如展示，只放独立旧记录说明，不制造可追溯性。

## 7. 核心 C2：手动检查、版本与学习反馈

先建可靠数据基础，再接 C1/C3，避免核查互动最后没有可保存的学生证据。

### 7.1 独立学习数据模块

新增 `lib/learning/`，职责按领域分开：`contracts.ts`（运行时校验和类型）、`content-snapshot.ts`（只读提取/指纹）、`runtime.ts`（记录与 CAS）、`report.ts`（确定性投影）、`remediation.ts`（补学来源）。UI 放 `components/learning/`。服务端模型编排放 `lib/server/learning/`；浏览器 RuntimeStore 不进入服务端依赖树。

学习内容指纹使用算法版本 + 按场景稳定顺序规范化的教学内容做 SHA-256：scene id/type/title、正文/讲解文本、Quiz 题面及规则、interactive/PBL 的可读取任务说明和相关内容。排除更新时间、视觉坐标/主题/缩放、TTS 缓存地址和纯展示状态。互动源码/未知内容发生变化时保守产生新版本；禁止仅凭名称相同复用旧成绩。

提取适配 slide/quiz/interactive/pbl 四种类型；只提取已有可读内容，不执行 iframe/代码，不把整套 HTML/媒体二进制灌入模型。信息不足的页面记录 coverage 限制；不能声称已经评价该页所有操作技能。完整指纹可以覆盖全文；模型输入使用选出的限长片段，并保存实际使用的片段及 sourceRef。

### 7.2 RuntimeStore 记录

新增应用 kind `learningCheck`，每个检查 attempt 对应一个 session，复用 stageId/learnerKey 分区与课程删除级联。payloadVersion=1，记录最小完整事实：

- identity：checkId、attemptId、来源 `course_check / remediation_check`、可选 parentAttemptId/questionId。
- source：contentRevision、snapshotAlgorithmVersion、课程标题、采用的场景标题/id、实际题目依据片段和各片段 digest。
- questions：不可变题组、选项、标准答案/评分要点、分值、题目对应 conceptId 和 sourceRefs；题组还需 questionSetId 与 scoringVersion。
- lifecycle：draft/submitted/reviewed；answers、grading、results、提交时间、开始/结束记录。应用 payload 可以沿用这三阶段，不修改包级 Quiz 骨架。
- generation/review metadata：prompt/schema 版本、模型标识、实际调用数/usage（可得时）、审题结果。没有 usage 时标 unknown，不能记 0。

生成题组失败时不创建一张“成功的空检查”。成功后先保存不可变题组，再展示答题。报告为按 seq 读取的投影，不复制成另一份可漂移的总分；跨 sessions 的先后使用显式父子关系/序号及稳定排序，时间戳不能替代单 session 的 seq。历史查询不能只调用读取 latest 的 helper 就声称包含全部 attempts。

新增 kind 必须注册到 `APP_RUNTIME_PAYLOAD_VALIDATORS`。追加只允许 active；最后一次 reviewed 与 completed 原子提交。记录请求去重、双击/跨 tab CAS 冲突、保存失败重试；不新增独立 IndexedDB 数据库或服务端 JSON 文件。

### 7.3 手动出题 API

新增 `POST /api/learning/check`，输入为只读课程证据包、scope、requestId 和沿用现有模型配置的请求信息；服务端重新校验 payload 边界，不接受客户端扩大调用预算。返回经校验的题组、覆盖说明、审题状态和调用元数据，不写课程或直接访问浏览器 runtime。

初始接口限制：请求 JSON 最大 128 KiB，证据正文合计最多 24,000 字符、最多 30 个片段，单片段最多 2,000 字符；题干/解析分别最多 2,000 字符，学生单题答案最多 4,000 字符。超限在调用模型前返回稳定 4xx 错误；客户端展示选取的范围。出题/审题单次 `maxOutputTokens` 起始上限 4,000，批改 1,000，guided 各阶段 2,000；模型不支持该参数或上下文不足时报告能力/预算错误，不全局切换模型。它们是可配置的部署上限，不是准确的费用或输入 token 估算。

第一版课程检查 3–5 题，最多 2 道简答；补学检查 1 题。只对证据覆盖的内容出题，不保证每类场景必须有题。请求整体体积设上限，按题保留 sourceRefs；若截断使材料不足，提示缩小范围/无法生成，不产生无依据题组。

流程为生成候选题组 → 独立审题 → 确定性结构验证 → 返回。审题检查答案唯一性/正确性、评分依据、歧义及与材料的对应；审题不通过，本次返回可重试失败，不自动无限修题。最多两次模型调用、总 90 秒；用户重试是新的请求，成功题组不因重开面板再次生成。两次调用均设置明确输出与输入限制并关闭隐式重试。

简答批改复用 H2 的评分服务模块；课程 Quiz 与 Learning check 使用不同持久化适配器，共享纯评分规则，不把 `QuizView` 整体搬到 Dialog 中并沿用它硬编码的 quizAttempt 路径。

新模型请求继续使用项目已有模型解析方式。出题/批改初版沿用 `quiz-grade` 路由，核查互动沿用 `chat-adapter` 路由；日志 source 用独立 learning 标识。不要改全局模型优先级或为了增加功能创建必填 MODEL_ROUTES 键；若未来需专用路由另立变更。

### 7.4 反馈内容与分数规则

反馈 Dialog 展示：检查版本/时间、参加与待批改状态、原题、学生答案、得分/满分、评分要点、课程来源、需复习概念、下一步按钮。总分/题数/最新记录等事实由确定性代码计算，AI 只能解释证据，不能生成统计事实。

- 没有检查：显示“尚未参加检查”，提供开始入口，不显示 0% 或全部掌握。
- 有部分评分：显示“已评分 x/y，已得 a 分，待批改 z 题”；不把 a 除以全卷满分标为最终成绩。
- 有完整结果：同一 contentRevision、questionSetId、scoringVersion 内可显示最新/最佳；不同题组分别展示，不能挑新旧题组高分拼成“最佳成绩”。
- 课程原有 Quiz、手动课程检查、补学新题分开列示。单道新题答对只说明本题表现，不承诺掌握整个知识点。
- 薄弱点必须能点回具体错题/评分依据；未覆盖知识点标未检查。不要生成没有数据支持的雷达图、学习完成率或涨幅。
- 课程修改后保留旧报告，标“对应旧版本”；新检查生成新快照。已删除场景继续可看历史题目，回看按钮说明原页不可用。
- 第一版用确定性建议模板连接具体错题和补学入口，避免另加一条自动报告模型请求。核查式答疑承载需要 AI 的解释工作。

## 8. 核心 C1：可选的核查式答疑

### 8.1 接入位置与传输契约

在 `ChatMessageSendOptions` 增加可选的 `interactionMode` 和有版本的 `learningContext`；默认值保持当前普通答疑。模式固定到当前 live session，切换模式需显式结束/另开，不能把同一 session 的下一回合静默发到另一编排器。

`use-chat-sessions.runAgentLoopFn` 增加一个窄分支：明确 guided 时调用新增 `/api/learning/coach` 的单请求客户端；否则**原样**执行现有 Pi/legacy 分支。guided 不运行 `runAgentLoop` 的续轮逻辑，不要求开启 Pi，也不调用 Pro 工作区 Agent Runner。

复用 `createStatelessStreamConsumer`、StreamBuffer、当前 session 生命周期和 TTS。新增 `lib/chat/guided-request.ts` 负责该单请求 SSE 消费，不把大量新状态塞入 PlaybackChromeRoot。服务端新增 `lib/server/learning/coach.ts` 负责有界流程。

SSE 继续使用已有 `agent_start/text_delta/agent_end/cue_user/done/error` 结构；内部审稿内容不发送为 text_delta。只有发布阶段发送最终解释和简短核查说明，随后恰好一个 cue_user 和 done。done 必须标记有内容、cueUserReceived=true；客户端不会因缺终止帧或异常 EOF 自动重发。若需结构化保存核查结果，给 done 增加可选、独立校验的 `learningOutcome` 字段，默认路径不依赖它；旧字段语义不变。

`learningOutcome` 至少含 schemaVersion、requestId、phase、实际发布内容、checkPrompt（如有）、review verdict/evidenceRefs、budget stop reason、使用量。每轮学生输入及成功结果追加到新 `learningDialogue` runtime kind，引用原 chat session 和来源 attempt；注册 validator。持久化只存公开结论、必要依据和真实回答，不保存模型隐藏推理。刷新后可以读取此前结果；不自动恢复模型执行。

### 8.2 固定、有限的教学流程

| 阶段                   | 行为与出口                                                                        |
| ---------------------- | --------------------------------------------------------------------------------- |
| explain                | 教学调用生成短解释候选和一个可选检查问题，先缓存在服务端                          |
| review                 | 核查调用获得原问题、课程依据及完整候选；独立对照关键结论，输出 verdict 与具体依据 |
| revise（可选一次）     | 仅发现明确问题才修正候选；不能通过新开子 agent 规避次数限制                       |
| re-review（可选一次）  | 对修订结果核查；没有完成该步骤，不能把修订文本标为已核查通过                      |
| publish → wait_student | 发布短解释/必要争议/检查问题后 cue；服务器请求结束，无后台等待循环                |
| feedback               | 仅真实学生回答后调用一次反馈，指出具体理解情况，再 cue 等待；不让 AI 同学代答     |
| end                    | 用户主动结束，沿用 H1 manual_stop；跳过问题不等于答错，不妨碍继续讲解             |

解释阶段最多 4 次模型调用，总 90 秒；单调用最多 30 秒，实际整体 deadline 优先。学生回答后的反馈请求最多 1 次、30 秒；总预算按完整解释+学生反馈记录至多 5 次调用。限制每次输出与输入长度，统计所有审查/修正调用；不把“可见发言两次”称为“模型只调用两次”。本版无搜索/代码执行/编辑/生成工具，避免 hidden tool calls 扩大预算。

若调用失败、证据不足、预算不足或争议未解决：显示“本次未能核实”及具体缺失依据，只发布明确标注的有限说明/请求补充；不能显示“验证通过”。取消立即传播到所有当前调用，不再进入下一阶段，丢弃迟到发布。

核查状态仅用 `no_issue_found / issue_found / insufficient_evidence` 等受控值；“未发现问题”不是数学证明或外部事实核验。只有现有材料/明确反例支持的来源才能显示为依据；不能凭模型输出发明链接。未提供网页检索/代码执行工具时，不显示“已联网核实/运行通过”。

教学角色、核查角色复用现有角色外观；核查员无需加入所有课程的 agent roster，不更改生成的人设或用户选择。前台最多展示一次最终教学发言和一次简短核查说明，内部讨论不逐字刷屏。学生真实回答后给反馈，不能拿 reviewer 的认可作为学生成绩。

### 8.3 回合与失效保护

- 每个请求绑定 stageId、contentRevision、chat sessionId、requestId、source attempt/question；server 做结构一致性校验，client 再检查当前 producer/view。
- 自由 guided 答疑仅对选定场景证据计算 scopedRevision；生成其他页面不应使这段未变化的证据失效。全课检查使用整课 contentRevision；错题补学沿用原 attempt 版本并单独校验回看目标。不得为了等待全课版本稳定而暂停课程生成。
- lecture/QA/guided 保持现有单活跃 live request 约束，不在并行的第二聊天控制器里另播音。
- 提问被取消、模式切换、课程切换后旧响应不得进入圆桌、白板或新课记录；guided 本版不发白板 action。
- pending 学生问题及已有解释从 runtime 还原；刷新保持等待状态，必须手动回答或继续，不自动重跑 explain/review。
- 学生回答先保存，再请求 feedback；保存失败保留输入，提示重试。反馈失败保留原答；重试反馈不是再次提交学生答卷。

Google Teamwork 只作为“提出—核查—修正”流程的设计参考，不是本项目已经接入的 SDK，也不是教学效果证据。采用两个角色本身不构成创新验证；需要第 11 节的对照结果。

## 9. 核心 C3：从真实错题回到学习

提供三个相互独立的明确操作：

1. **回看讲解**：检查当前课程与来源版本，定位 sourceRef 对应 scene；使用 PlaybackChromeRoot 已有 gatedSceneSwitch/导航生命周期清退 live 资源再切页，不能直接改 Store 当前 scene 绕过清理。课程改变且锚点无法确认时只打开历史证据，不猜测跳页。
2. **针对这题讨论**：把快照原题、原答、已评分结果、评分依据和明确场景片段形成 `RemediationContext`，学生主动启动 guided session。即使当前页已切到讲解页，也保留这个上下文，不能依赖只读取当前 quiz 的原 helper。
3. **检查这次理解**：补学后由学生点击，用相同概念、不同题面生成一道新题，建立 `remediation_check`，引用 parent attempt/question。沿用 C2 审题及 H2 评分规则；展示原答和新答表现，不覆盖历史成绩。

`RemediationContext` 为版本化结构，含来源 attempt/question/contentRevision、概念、原题/原答/得分、sourceRefs；不能仅传一句“用户这题做错了”。来源结果 pending/unavailable 时只能请求解释或核实题目，不能预设学生答错。

当前课程原有 Quiz 没有标准化 conceptId/讲解页映射，不能假定生成链路已经提供。新 Learning check 在出题/审题时保存本题组内的概念标识与依据片段；原有 Quiz 默认来源是原题页。学生主动补学时可以在只读候选材料中选取相关讲解，或采用经过核查的材料匹配结果；返回的 sceneId/片段 digest 必须属于传入证据包。没有可靠讲解映射时按钮显示“回看原题”，不虚构“对应知识点页面”，也不为补字段改课程生成接口。概念标识仅在本内容版本内用于组织证据，不宣称跨课程知识图谱。

Dialog 开关不得重新挂载课堂。进入答题前若需暂停讲解，复用现有播放暂停动作，保留学生原先是否正在播放的意图；关闭查看型 Dialog 不调用 manual_stop，不强行自动播放。学习导航使用 scene-change 意图，只有学生明确结束 guided 讨论才走 manual_stop 恢复路径。

## 10. 实施拆分、文件范围与验证

### 10.1 执行票据

| 顺序 | 交付                          | 主要修改 / 新增位置                                                                       | 验收门槛                                                                  |
| ---- | ----------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| T0   | 基线与保护清单                | 实施记录、测试环境；不修改功能                                                            | 保存 dirty diff 和 UI 截图；明确普通前台/后台、Pro 构建配置；复现测试基线 |
| T1   | H1 验证与残余修正             | agent-loop、use-chat-sessions、auto-resume、PlaybackChromeRoot 的必要分支                 | 有限轮次、真实 TTS 停止/同页恢复、切页竞态通过                            |
| T2   | H2 合法评分与 v2 恢复         | quiz-grade route、lib/quiz、QuizView、payload validators、complete-summary/完成页数据绑定 | 失败无分、快照不变、pending 恢复、重试/重答分离、旧记录兼容               |
| T3   | 学习快照 / runtime / 手动检查 | lib/learning、lib/server/learning、api/learning/check、components/learning                | 无 Quiz 课程也能显式检查；Browser/HTTP 均落盘；生成内容未改               |
| T4   | 确定性反馈与增量入口          | report、LearningFeedbackDialog、播放交互入口、结果区                                      | 分母/状态正确，历史/版本清晰，原 UI 保留                                  |
| T5   | 可选核查式答疑                | api/learning/coach、guided-request、coach、聊天可选分支/选项、learningDialogue            | 发布前核查、预算、真实学生等待、取消、默认两条路径不变                    |
| T6   | 错题补学闭环                  | remediation、报告/题目按钮、导航适配                                                      | 原题依据跟随、正确跳页、补学新题独立 attempt                              |
| T7   | 完整回归与试点材料            | 测试、截图、实施记录、演示脚本                                                            | 第 10.3/11 节证据齐全；如缺真实环境，明确标未验证                         |

新建功能开关集中在 `lib/learning/feature-flags.ts`：`NEXT_PUBLIC_LEARNING_CHECKS_ENABLED` 与 `NEXT_PUBLIC_GUIDED_LEARNING_ENABLED`，默认 false，独立开关，服务端也验证对应部署配置。开关只控制新增能力；H1/H2 的修正不应被开关关闭后重新变成假成绩/无限循环。关闭功能不能删除已经产生的记录；重新启用后仍可读取。

这些是构建期 public 开关，切换验证需要正确重启/重新构建，不能只改浏览器 localStorage 伪称测过两个配置。新增模块按需加载，不使生成页静态依赖整套报告 UI。

原则上不改：`GenerationSessionController.tsx`、`app/api/generate-classroom/route.ts`、`lib/server/generation-pipeline/`、`generation-job-tools.ts`、worker、`use-scene-generator.ts`、`use-generation-job.ts`、包级 Stage/Scene DSL、课程导出协议、全局样式。只读生成 readiness 的接入应放在学习适配层。若实际代码迫使触碰这些区域，先在实施记录解释必要性并补对应保护测试，禁止顺便重构。

### 10.2 本轮实际测试结果

使用 Codex 随附 Node `v24.19.0`。默认 shell 的 Node 不能满足当前测试依赖的 `node:util.styleText`，因此没有使用它运行 Vitest，也没有改依赖版本。

初次 17 个文件测试结果为 184 passed / 4 failed，失败均在 `tests/quiz/runtime.test.ts` 的跨 tab 并发用例，5 秒超时。单独重跑也复现。其中两个用例名称明确要求 without Web Locks，但测试没有屏蔽 Node 24 自带 `navigator.locks`，导致模拟双 tab 的屏障与单进程锁互相等待。

仅在父 Node 命令行加 `--no-experimental-global-navigator` 没有消除 Vitest 子进程中的问题。改为在本次测试进程环境设置 `NODE_OPTIONS=--no-experimental-global-navigator` 后，同一 `runtime.test.ts` **27/27 通过**。随后下列完整选择集 **22 个文件、263 项通过**；本轮未改测试或业务实现来换取通过。

实际执行命令（PowerShell，环境变量只用于该测试会话；不要添加到产品运行配置）：

```powershell
$env:NODE_OPTIONS = '--no-experimental-global-navigator'
$taskNode = 'C:\Users\Lenovo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $taskNode node_modules/vitest/vitest.mjs run tests/quiz tests/chat/agent-loop-turn-limit.test.ts tests/chat/agent-loop-async-state.test.ts tests/lib/playback/auto-resume.test.ts tests/playback/action-navigation.test.ts tests/agent-runtime/pro-model-chain.test.ts tests/agent-runtime/pro-submission-regression.test.ts tests/agent-runtime/pro-course-guidance.test.ts tests/agent-runtime/generation-job-tools.test.ts tests/generation/scene-builder-pbl-v2.test.ts tests/generation/scene-outlines-standard-desync.test.ts tests/generation/model-snapshot-client.test.ts tests/server/generation-worker-pipeline.test.ts tests/classroom/complete-summary.test.ts tests/generation-preview/generation-session-runtime.test.ts tests/generation-preview/generation-session-boundary.test.ts tests/lib/chat/pi/route-cue-user.test.ts
```

T0 应在测试自身显式隔离“有 Web Locks / 无 Web Locks”环境，测试后恢复，避免依赖运行机器恰好没有 navigator；增加有锁串行用例，保留无锁冲突用例。不要删除产品 Web Locks、跳过测试或只提高超时。上述通过结果仅覆盖关闭该 Node 全局对象的测试环境，不证明真实浏览器多标签页行为已通过。

没有执行完整测试库、生产 build、Playwright、真实模型调用或 PostgreSQL 集成测试；263 passed 不得写成“全站已验证”或“新功能已经通过”。

### 10.3 实施后的强制行为矩阵

| 区域         | 必须验证的行为                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通前台生成 | 首场景先成功、后续继续生成；outline 编辑确认；取消/重试；进入课堂前持久化失败；新学习功能关闭/开启均不新增生成请求                                        |
| 普通后台生成 | 提交幂等、awaiting_confirmation、后台续跑、ready/failed/cancelled、重试状态；不能因报告缺失停在生成中                                                     |
| Pro          | 原咨询/提交工具、模型和技能绑定；生成后托管课堂；workspace 多 tab 切换、hidden pane、新旧 freshness；UI 控件完整                                          |
| 原有场景     | slide、quiz、interactive、pbl 均可播放/查看；Quiz 评分变化不污染 PBL，互动执行与白板功能保留                                                              |
| H1 / C1      | legacy 与 Pi 的默认行为；guided 每阶段取消/超时/失效；无终止帧报错；cue 后无自动调用；手动结束讲解恢复                                                    |
| H2           | JSON 非法、NaN/字符串/越界分数、空答、缺答案、429/5xx、部分成功、刷新、提交后不可改答、重复重试、旧 v1 记录                                               |
| runtime      | Browser 与 HTTP provider；顺序写、跨 tab CAS、保存失败恢复、completed 不可追加、删除课程级联；保留现有分区规则                                            |
| 学习反馈     | 无检查/仅草稿/待批改/全成功/旧版本/场景删除；不同题组不合并最佳分；分子分母由事实计算                                                                     |
| 补学         | source 不随切页丢失；旧页不可用不跳错；新题独立记录；退出后旧请求不更新别的课程                                                                           |
| 生成隔离     | 完成一次检查、核查、补学前后，课程/outline/actions/媒体数据一致；无 generate-classroom、scene-content、scene-actions 或 Pro submit 请求；仅导航状态可变化 |

UI 基线至少包含普通 standalone 与 Pro hosted；1366×768、1024×768、390×844，另测短容器高度；深浅主题及中文/英文关键界面。先记录原有溢出，区分基线问题与新增回归。已有 `zhiyu-responsive-matrix` 并不等于上述全部尺寸已验证。

优先复用现有 `e2e/tests/generation-flow.spec.ts`、`zhiyu-workspace-ui.spec.ts`、`zhiyu-classroom-complete-adaptive.spec.ts`、`zhiyu-responsive-matrix.spec.ts` 等高层流程。`zhiyu-classroom-complete-adaptive` 测的是完成页的容器高度/滚动自适应，不是自适应学习实现证据。新增可确定的模型响应 fixture 覆盖失败与迟到事件；另行做少量真实模型烟测，不用 mock 冒充真实平台可用。

Playwright 当前使用 3002 端口，并设置 editor/Pro/runtime 相关环境；按仓库配置准备服务和数据。后台 Worker/PostgreSQL 与真实 Pro 场景需要相应环境，缺失时记录 blocker，不降低测试内容为“按钮存在”。

每票完成跑受影响测试及必要消费者测试；最后运行保护选择集、类型检查、受影响 ESLint/Prettier、`pnpm check:i18n-keys`、`pnpm build` 和相关 e2e。按最终 diff 判断是否需 `pnpm build:worker`、performance 或包测试；未改包时不为这些功能无理由改包版本。任何未过检查明确留在实施记录中。

## 11. 十天交付与试点证据

约 43 小时是可投入时间估算，不是上述全部工作的保证工期。建议时间盒：基线/H1 6 小时、H2 10 小时、检查/反馈 10 小时、guided/补学 10 小时、回归/演示 7 小时。这个安排偏紧；T2 若暴露额外并发/迁移问题，优先减少可选报告装饰、额外题型、自动建议和高级核查工具，不压缩生成/UI 回归，也不将半完成闭环称为完成。

准备两门不同主题的短课，保留通用输入。每门包含已知误区、可检查答案与材料不足例；另有无 Quiz 课程、含 PBL/interactive 的兼容样例。邀请学生真实完成“提问—检查—看反馈—补学新题”，记录：

- 讨论是否能停止、手动结束是否恢复、批改失败后能否恢复、旧答是否保留。
- 核查发现了哪些实际错误、是否引入新错、证据不足是否诚实表达。
- 原互动、同模型单角色核查、新双职责流程在相同材料下的效果、延迟和实际调用成本；小样本只作为试点描述。
- 学生是否真正作答、补学新题表现，避免用满意度、发言数或 AI 一致率代替学习效果。

参赛材料区分 OpenMAIC 原有能力、智域已有 UI/生成架构修改、本次新做的有界核查与证据闭环。保留上游归属说明，不把上游原有多智能体、Quiz 或错题上下文注入称为本次原创。

## 12. 新对话实施指令

可直接将以下文字与本文一起交给新对话：

> 请按照 `docs/plans/2026-09-14-zhiyu-student-core-implementation.md` 在当前智域仓库实施。先读取当前代码、适用 AGENTS.md、工作区 diff 与本文审查基线，保留此前未提交修改。账号与数据隔离属于后续拓展，本次不实施、不作为前置条件。先完成 T0/T1/T2，再按依赖推进学习检查、反馈、可选核查式答疑和错题补学。保护当前完整 UI，最优先保证普通前台/后台及 Pro 的课程生成、模型绑定和后续续生成；不得用简化界面、替换课堂壳或重构生成主链路实现新功能。新增能力须按需触发、运行时旁路保存，失败不阻断课程。不把待批改算成分数、不从当前题目重建历史原题、不让 AI 代替学生作答。逐票执行适当测试，记录已完成、未完成、真实环境未验证项及新增文件。若实际代码与方案冲突，先核查并记录证据后做最小调整，不擅自扩大范围或删除现有功能。最终提交实际测试与 UI/普通/Pro 回归证据。

实施记录建议另建 `docs/plans/2026-09-14-zhiyu-student-core-execution.md`，每票记录：实际改动、关键决定、测试命令/结果、截图位置、剩余风险；不要把本规格的“计划”直接批量改成“已完成”。

## 13. 关联资料

- [学生端范围 ADR](../adr/0018-focus-competition-release-on-student-learning.md)
- [原始访谈与互动缺陷修正记录](../research/zhiyu-student-competition-interview-2026-09-14.md)
- [学习检查题目归属](../adr/0002-own-dynamic-assessment-questions-in-learner-runtime.md)
- [学习进度事实](../adr/0003-persist-learning-progress-as-runtime-facts.md)
- [内容版本与测评历史](../adr/0004-version-course-assessment-history-across-edits.md)
- [保持业务状态归属的 UI 边界](../adr/0001-redesign-product-chrome-without-moving-business-state.md)
- [Google Teamwork 原文](https://www.antigravity.google/blog/teamwork-when-ai-becomes-a-research-partner)
