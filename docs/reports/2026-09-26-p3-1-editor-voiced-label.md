# P3-1 编辑器“未配音”标签一致性

- **环境/日期/代码版本/镜像：** 2026-09-26（UTC+8）。本机应用连接东京 Supabase `lvbtgwlsebzbtcvjwktq`；Web `sha256:c7f92d19…`（基线 `a0484f3e` + 本轮未提交改动）。浏览器为 Claude 桌面应用内置浏览器，管理员账号由用户本人登录。
- **初始问题及复现步骤：** 方案第 10 节事实与代码一致：`components/edit/ActionsBar/ActionsBar.tsx` 用 `audioExists(candidateId) || !!audioUrl`，而 `audioExists` 只查浏览器 Dexie；课堂播放 `resolveAudioBlob` 先查云端资产池。复现（真实样本）：课程 `e48a0067-5d13-43fd-88db-041f30880af4`（1 页，5 条讲解，均有 `audioId`，只读 SQL 确认 5 条都在资产池并有私有对象）；在本浏览器 IndexedDB `MAIC-Database.audioFiles` 中 **0 行**、5 个 id 全部不存在——旧逻辑因此必然显示“未配音”（与 09-23 验收记录一致）。
- **修改范围与原因：**
  - `lib/audio/regenerate-speech-tts.ts` 新增 `speechAudioAvailable(audioId)`：先查本地 Dexie（本地、无网络），没有再用 `assetRefExists` 查资产池（HTTP 存储走 HEAD 元数据探测，不下载字节）；具体 URL 不查池。任一来源确认存在即 true；一方失败且另一方没找到时抛错表示“未知”，而不是返回 false。
  - `ActionsBar.tsx` 的 `SpeechTtsBar` 状态改为：`checking`（检查中）、`ready`（已配音）、`none`（未配音：没有任何音频引用）、`missing`（音频缺失：有 `audioId` 但两处都没有字节）、`unknown`（无法确认：检查失败）、`generating`、`error`。检查失败时不会显示“已配音”或“未配音”。只有 `ready` 可以试听。文本编辑后清除 `audioId` 的原逻辑不变，所以旧音频不会被当成新文本的配音。
  - 12 种语言补 `edit.tts.statusChecking/statusMissing/statusUnknown`。
  - 未改“全部配音”（用户主动触发的整批重生成）；未调用 TTS；未改动任何 `audioId`。
- **前后指标（真实样本，2 次打开）：** 修改前（依据代码与 Dexie 实查）5/5 会显示“未配音”。修改后两次打开结果相同：**4 条“已配音”（可试听），1 条“无法确认”**，没有一条显示“未配音”。那 1 条（`ast_nd94t4a6…`）的 HEAD 探测在 15 秒截止时间内没有返回：5 个探测与页面其余请求同时争用上限 5 的连接池，而本机到东京每个请求约 10 秒（原因见 [P1-1](2026-09-26-p1-1-tokyo-read-latency-baseline.md)）。单独请求它时 4.3 秒返回 200（`audio/mpeg`、revision 1）。这正是设计要求的“检查失败时不误报”；在服务器上延迟正常时预计 5 条都能确认，需部署后复验。
- **自动测试命令及结果：**
  - `node node_modules/vitest/vitest.mjs run tests/audio/regenerate-speech-tts.test.ts tests/media/resolve-audio-bytes.test.ts tests/edit/actions-bar-cue-preview.test.ts tests/edit/speech-tts-bar-status.test.ts --maxWorkers=2`：全部通过。
  - `speechAudioAvailable` 新增 7 项：只在池中（Pro/后台）为可用；本地先命中不查池；真正缺失为 false；池失败 + 本地无 → 未知；本地失败 + 池无 → 未知；本地失败 + 池有 → 可用；具体 URL 不查池。
  - 新增 jsdom 组件测试 `tests/edit/speech-tts-bar-status.test.ts`（7 项）：Pro 纯云端音频显示“已配音”且不调用 TTS、不改 `audioId`；有 id 无字节显示“音频缺失”；检查失败显示“无法确认”；答案返回前显示“检查中”；无引用显示“未配音”；旧 Dexie 键仍为“已配音”；旧 URL 直接视为已配音不探测。
  - `tsc --noEmit`、ESLint 通过；全量见[汇总报告](2026-09-25-supabase-post-launch-execution-summary.md)。
- **真实操作与课程/任务/会话 ID：** 课程 `e48a0067-5d13-43fd-88db-041f30880af4`（通过“编辑课程”进入 Pro 工作台 `/workspace?course=…`）；只读，没有点击任何“重新生成配音”，没有保存编辑。
- **权限与持久化检查：** 探测走现有带鉴权的资产路由；只读 HEAD，不铸造也不保留对象 URL。未修改课程文档。
- **回退方式及是否验证：** 还原两处代码与语言文件即可；未演练。
- **结论：** 通过（标签与实际可用性一致，未再误报“未配音”，无额外模型费用；1 条因本机高延迟显示“无法确认”，属于设计内的保守结果）。
- **剩余事项：** 方案第 5 步的回归项中，“生成中、替换声音、编辑文本后失效、编辑保存”由组件/单元测试和原有 `actions-edit` 测试覆盖，没有在真实浏览器里逐项操作。服务器部署后用同一课程复验 5/5。
