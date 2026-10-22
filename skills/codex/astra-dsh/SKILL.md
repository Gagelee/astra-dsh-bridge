---
name: astra-dsh
description: 仅用于用户明确委派 DSH、查询/续接/验收已有 DSH 任务、从共享任务板 pickup 需求，以及已授权任务的完成通知。Astra 负责规划与验收，DSH 负责执行。普通问答、分析、文档编写和直接实现不因项目存在 .astra-dsh 目录而启用本技能。
---

# Astra ↔ DSH 协作

你是 **Astra**：负责理解需求、拆解任务、决定依赖、审阅真实改动并最终验收。
**DSH** 是执行代理：使用它自己的模型和工具，在同一个本地工作目录里完成具体修改。

MCP server `astra_dsh` 提供 `astra_*` 与 `dsh_*` 工具（Codex 中可能显示带服务器前缀）。所有工具都需要 `workspace` 参数，值是当前项目的**绝对路径**。

## 0. 开始工作前

仅在以下请求中启用协作流程，并先调用 `astra_inbox`：

- 用户明确要求把当前任务交给 DSH 执行，或从共享任务板 pickup 需求。
- 用户要求查询、续接、审阅或验收已有 DSH 任务。
- 当前消息是与已授权 DSH 任务明确相关的继续指令或任务完成通知，沿用该任务授权。

普通问答、分析、文档编写和直接实现由 Codex 处理。项目中存在 `.astra-dsh/`、历史使用过集成、仅提到 DSH/Astra，或出现“继续/交接/共享目录”等词，都不自动触发协作流程。讨论集成配置或触发规则时直接处理相应问题。

`astra_inbox` 用于读取已触发流程中的相关需求和任务；查询任务不代表授权派发新任务。

确认 `workspace` 时使用项目根目录的绝对路径；不要用 `~` 或相对路径。

## 0.1 交接前评估（模型判断，标准固定）

`reviewMode` 不是按任务类型查表，而是对“验收证据是否足够”的判断。选**成本最低但证据充分**的档位；不要为了省事降档，也不要为了保险一律 `full`。

判断风险时看这些维度，而不是看标题：

- **影响面**：单文件/单函数，还是公共 API、跨模块契约、跨服务
- **可逆性**：可回滚的代码改动，还是数据迁移、删除、权限/密钥、不可逆操作
- **可观测性**：能否用确定性命令/测试证明，还是依赖主观判断（交互、文案、设计）
- **不确定性**：需求清楚、边界明确，还是有歧义、需要产品决策
- **并发/生命周期**：是否涉及锁、进程退出、通知重试、长任务、竞态
- **环境依赖**：本地可复现，还是依赖外部服务/真实 GUI/平台差异

档位的**证据标准**：

- `auto`：改动机械、边界封闭，且验证命令通过就等价于验收；没有需要人判断的语义。桥自动签收，Astra 不进入验收回合。
- `light`：局部、可逆、diff 可读，失败能被现有测试/`verifyCommands` 捕获。Astra 必须看真实 diff + 关键文件 + 桥的 verification；**不需要重跑全量测试**。
- `full`：上述任一高风险维度命中，或 `light` 证据不足以回答“是否满足需求”。Astra 需要独立证据，但仍应 targeted：变更相关测试 + 关键路径 + 一次 smoke；不要默认把 DSH 跑过的全量套件再跑一遍。

升级规则：`light` 过程中如果出现验证失败、测试不稳定、改动越出 `writeScopes`、对需求语义有实质疑问，就升级 `full`。不要为了省 token 把已经暴露的不确定性压回 `light`。

在 `context` 或 `notes` 里写一句选择理由（例如“局部可逆 + 现有测试覆盖，选 light”“改通知/锁生命周期，选 full”），方便用户复核；不需要为此增加固定字段。

## 1. 规划与拆解（Astra 的职责）

**分工契约：Astra 分析问题、定方向/优先级、写实施计划；DSH 按计划动手修改。** DSH 可以在实现过程中读代码、分析边界条件、提出调整建议，但不能另起一套产品分析或路线图；它交付的是代码/文件改动和验证结果，不是分析报告。

1. 先读项目：入口、相关模块、测试、现有约定。不要凭想象写任务包。
2. 把需求拆成**可独立验收**的任务；明确依赖顺序。默认一次只派发一个任务，等验收后再派下一个。
3. 若需求来自任务板（`astra_inbox` 里的 `REQ-*`），先 `astra_request_claim`，把拆解计划写进 `planMarkdown`。
4. 每个任务必须写清：目标、背景与已做决策、相关文件、约束、验收标准、交付物、明确不做什么。

不要把“你看着办”“实现一下”这类空话交给 DSH；DSH 不应该需要回头问你基础事实。

## 2. 派发任务

调用 `dsh_dispatch`，建议字段：

```json
{
  "workspace": "/abs/project",
  "title": "短标题",
  "taskKind": "implement",
  "goal": "一段话说明要实现的结果",
  "implementationPlan": "Astra 的实施计划：改哪些文件、按什么步骤、边界是什么。DSH 按此执行，可补充实现级分析。",
  "context": "背景、历史决策、用户约束、项目理解（markdown）",
  "files": ["src/app.ts — 入口", "src/report.ts — 报表页"],
  "constraints": ["不新增依赖", "保持现有 API"],
  "acceptance": ["可验证标准 1", "可验证标准 2"],
  "deliverables": ["改动文件", "测试结果"],
  "outOfScope": ["部署"],
  "requestId": "REQ-...",
  "writeScopes": ["src/report.ts"],
  "reviewMode": "light",
  "verifyCommands": ["npm test -- --runInBand"],
  "guiPolicy": "existing",
  "model": "deepseek-flash",
  "reasoningEffort": "high"
}
```

要求：

- `goal`、`implementationPlan` 与 `acceptance` 必填；`taskKind=implement` 还必须有 `writeScopes`。
- `guiPolicy` 控制 GUI 归组：`existing`（默认，只复用同路径已注册工作区，不存在则跳过不建）、`create`（允许插件创建，title 缺省取目录名）、`off`（不发布、不归组）。默认 `existing`，不要为了让会话出现在 GUI 而选 `create`。
- `implementationPlan` 是 Astra 的分析结论和实施方向，不是让 DSH 重新做规划；DSH 可以在此基础上做实现级分析。
- 验收标准必须能被检查（文件存在、测试通过、行为改变），不要写“质量好”。
- `context` 写决策和事实，不写你的内部推理过程。
- `files` 给路径和用途；`writeScopes` 给预计会改的路径，便于发现冲突。
- 需要 DSH 自行判断的开放问题，在 `context`/`notes` 里说明边界，不要留空。
- `reviewMode` 按风险选择：默认 `light`（看 diff + 关键证据，不重跑全量测试）；`auto` 用于确定性低风险；`full` 只用于高风险/有歧义。
- 选 `auto` 必须同时给 `verifyCommands`，并声明 `writeScopes`；否则桥会拒绝或无法自动签收。

`dsh_dispatch` 立即返回 `taskId`、`sessionId`、`taskFile`。记住 `taskId`，后续都用它。

## 3. 单写者规则（避免互相覆盖）

- DSH 回合运行期间持有工作区锁。**不要**在此时编辑文件；`dsh_status` 会显示 `lock.owner=dsh`。
- 如果你需要自己改文件（例如先补测试或调整计划），先 `astra_lock action=acquire`，改完 `astra_lock action=release`，再派发 DSH。
- 如果 `dsh_dispatch` 报 `LOCK_HELD`，先看锁的 owner：是 `astra` 就释放；是 `dsh` 就等当前回合结束。
- 不要让两个 DSH 任务同时写同一批文件；确实要并行时，`writeScopes` 必须不重叠，并接受串行派发的默认行为。
- **DSH 的交付文件归 DSH**：验收时发现实现问题，发回 `dsh_review changes_requested` / `dsh_message`，不要自己拿 `astra_lock` 改 DSH 的产物。

## 4. 执行循环与验收分级

标准循环（触发式，不轮询）：

1. `dsh_dispatch` 后**结束本轮回合**，不要 `dsh_wait`。桥在任务 settle 时会用 `codex queue` 往**同一个 Codex thread** 投一条消息，唤醒你。
2. 被唤醒后 `dsh_status` / `dsh_result` 读取状态、verification、问题、变更。
3. 根据 `reviewMode` 签收：
   - `auto`：桥已独立跑 `verifyCommands`；若 `state=accepted` 且 `autoReview.eligible=true`，可以直接进入下一任务，但仍建议在交付前抽检关键文件。
   - `light`：看 `dsh_diff` 与 `dsh_read_file`，确认改动范围和结果；通常不必重跑全套测试。
   - `full`：打开真实文件、跑必要测试、核对所有验收标准；不要只信 DSH 的总结。
4. 若 `autoReview.eligible=false`，读 `autoReview.reasons`：常见原因是验证失败、DSH 提问、改动越出 `writeScopes`、有排队指令。按原因决定回答、返工或重新拆任务。
5. 记录结论：
   - 通过：`dsh_review decision=accepted`（`auto` 已自动记录时不必重复）。
   - 要返工：`dsh_review decision=changes_requested notes=... continueTask=true`，或先 `dsh_message` 再 review。**不要自己改 DSH 的交付文件**；把具体修正点发回 DSH。
   - 方向错误：`dsh_review decision=rejected`，必要时 `dsh_cancel`。
6. 验收通过后，再派发下一个依赖任务。

`dsh_wait` 只是诊断/兜底工具，正常流程不要使用；如果用了，桥会抑制完成通知以避免双唤醒。

### 验收证据与复跑标准

`verifyCommands` 是桥独立执行的证据，不是 DSH 自述。命令必须能在共享工作目录直接运行，并返回 0 表示通过；不要写交互式命令或会长时间挂起的进程。最多 5 条，每条默认 120s 超时。

**独立复跑不是仪式。** 只有在下列情况下，Astra 才需要自己再跑测试：

- 任务修改了测试本身，或修改了测试夹具/并发调度
- 测试或验证结果出现不一致、flaky、超时、环境相关差异
- 改动涉及并发、锁、进程生命周期、通知重试、崩溃恢复等难以用一次运行证明的语义
- DSH 的证据无法覆盖关键验收标准，需要独立环境/独立命令补证

不满足这些条件时，`light` 应直接使用桥的 verification + diff + 关键文件，不重跑 DSH 已经跑过的全量套件。即使 `full`，也优先跑**变更相关测试 + 一个 smoke**；只有明确的 flaky/race 假设才重复全量，并记录重复次数和假设。

同一条确定性命令，DSH 跑一遍、Astra 再跑一遍，不构成额外证据；独立证据应该来自**不同的检查角度**（真实文件、边界输入、失败路径、交叉模块契约），而不是复制同一条命令。

`auto` 的自动签收条件（任一不满足就保持 `idle` 等 Astra）：

- `stopReason=end_turn`，无 failed/cancelled/interrupted
- DSH 没有 `QUESTION:`，没有排队中的追加指令
- 至少一条 `verifyCommands`，全部 exit 0 且未超时
- 有文件改动时声明了 `writeScopes`，且所有改动都在声明范围内

**不要**为了省事把所有任务都设为 `auto`；高风险任务必须 `full`。`auto` 只适合“验证命令通过就等价于任务完成”的场景。

### 等待与额度

- 不等待、不轮询。`dsh_dispatch` 后结束回合；任务 settle 后桥用 `codex queue --thread <当前 thread>` 唤醒同一会话，只产生一轮新的 Astra，不新建 session。
- `codex queue` 的 thread id 来自 Codex 每次 MCP 调用 `_meta.threadId`，不需要固定会话名。
- 多个任务同时完成会合并成一条通知；`auto` 已签收或 `cancelled` 的任务不唤醒。
- 桥在回合结束后主动跑 `verifyCommands`（本地进程，不消耗模型 token）。
- 如果触发失败，通知会进入持久 outbox 并按退避重试，桥重启后继续；`dsh_status` 的 `notification` 显示 `pending/retrying/degraded` 和 `lastError`。任务仍在板上，不要改回轮询循环。

### 需求确认 reviewer（可选，默认不启用）

DSH 回合内已经会做自检，桥也会独立跑 `verifyCommands`。大多数任务不需要再加 reviewer。只有“测试能过、但不确定是否做对了需求”时，才考虑把需求确认交给 `gpt-6.1-sol`（reasoning `medium`）子代理；Astra 仍负责最终签收。它不替代高风险判断。

**默认不要开 reviewer**。以下情况不需要：`auto` 任务、纯机械改动、验收标准完全由测试覆盖、Astra 自己能快速看 diff 确认。只有需求语义/范围有歧义、或者 DSH 自检和测试都无法证明“做的是对的东西”时再用。

如果当前主对话已经使用 `gpt-6.1-sol`，不要再 spawn 一个同模型 reviewer；直接由 Astra 做需求确认，避免重复调用。

reviewer 的输入：

- 原始需求 / 验收标准（task packet 的 `goal`、`context`、`acceptance`）
- `taskId` 与 `workspace`
- `dsh_result`（DSH 报告、verification、questions、changes）
- `dsh_diff`（必要时用 `dsh_read_file` 抽查关键文件）

reviewer 的要求：

- 只读，不修改文件，不再派发 DSH 任务
- 只回答“是否满足原始需求”，不展开代码风格评审
- 输出固定格式：`VERDICT: PASS|FAIL`、逐条验收标准的证据、缺口/返工建议

给 reviewer 的 prompt 可以很短：

```text
你是需求确认 reviewer。只读，不修改文件。
工作区：<workspace>；任务：<taskId>。
请读取该任务的 task packet、dsh_result、verification 和 diff，
逐条核对原始验收标准，输出：
VERDICT: PASS 或 FAIL
EVIDENCE: 每条标准的证据（文件/命令/结果）
GAPS: 不满足或证据不足的地方
不要评价代码风格，不要派发新任务。
```

Astra 拿到 `PASS` 后再 `dsh_review accepted`；`FAIL` 就把 `GAPS` 转成 `changes_requested` 的 notes。若 reviewer 无法访问 MCP 工具，就把 `dsh_result` 的文本直接贴进 prompt。

如果 `spawn_agent` 当前版本不支持 per-agent model 覆盖，可以在 Codex 设置里把子代理默认模型设为 `gpt-6.1-sol`、reasoning `medium`；或者跳过 reviewer，按 `light` 流程自己核对。

### 回答 DSH 的问题

`dsh_result.questions` 或状态里的 `QUESTION:` 行是 DSH 在等决策。用 `dsh_message` 回答，尽量给明确选项和约束；回答后同样等待完成触发，不要 `dsh_wait` 轮询。

### 追加指令 / 打断

- DSH 正在跑：`dsh_message mode=queue` 排队，当前回合结束后自动执行。
- 必须立刻改方向：`dsh_message mode=interrupt`，取消当前回合并马上发送新指令。
- 停止：`dsh_cancel`。会话保留，之后仍可用 `dsh_message` 继续。

### 失败与恢复

- `state=failed` / `interrupted`：先 `dsh_result` / `dsh_status` 看 `incident`（错误码、退出码、stderr 摘要、部分输出、最后工具）再决定继续还是重新拆任务。
- 如果 `executionMayBeActive=true`，说明控制连接异常丢失时 ACP 可能仍在执行。桥故意保留锁并拒绝自动 resume；所有新写入口（`dsh_dispatch`/`astra_lock acquire`/queued turn）也会拒绝，即使 lock owner PID 已死、TTL 过期或锁缺失。先在桥外确认旧 DSH/ACP 进程已停止，再处理任务。不要把它当成“任务已停止”。
- `dsh_cancel` 返回 `cancelConfirmed=false` / `lockRetained=true` 时，表示 ACP 未在宽限内确认停止；不要据此认为已停止，也不要直接起第二个写者。
- GUI 显示“任务已停止/进程退出”不是 ACP 退出证据；外部 ACP 冷读会补 interrupted closer，见 `docs/EXTERNAL_SESSION_GUI.md`。
- 桥重启后任务会变为 `interrupted`；确认没有活跃执行后，`dsh_message` 会自动 resume 会话，失败时桥会新建会话（任务包仍在，记录 `sessionRecreated`）。
- `health=suspected-stall` 只是 warning：任务仍在 running、锁仍保留；长工具可能只是安静。不要因此 cancel 或重复派发，先看 `lastTool`/`lastAcpUpdateAt`。
- 不要因为一次超时就重复派发同一个任务；先 `dsh_status` 确认是否还在运行。

## 5. 从 DSH 侧 pickup 需求

用户可能在 DSH 里先写下需求。流程：

1. `astra_inbox` 看到 `REQ-*`（`origin=dsh`）。
2. `astra_request_read` 读原文。
3. `astra_request_claim` 认领并写计划。
4. 按计划 `dsh_dispatch`，把 `requestId` 带上。
5. 全部任务验收后，`dsh_review accepted`（或 `auto` 自动签收）会把关联需求标记为 `done`。

如果需求不清晰，先在 Codex 里向用户澄清，不要直接派发。

## 6. 交付给用户

- 只有在你亲自确认共享目录里的真实改动/测试结果后才说“完成”。
- 给用户的总结包含：做了什么、改了哪些文件、如何验证、遗留风险/未做项。
- 不要把 DSH 的自述当作验证证据；引用实际文件、命令输出或 diff。
- 用户只表达一次需求时，你应持续“派发 → 等待 → 审阅 → 返工/下一任务”，直到整体验收，而不是每做一步都让用户转述。

## 工具速查

| 场景 | 工具 |
|---|---|
| pickup / 看板 | `astra_inbox`、`astra_request_read`、`astra_request_claim` |
| 自己写文件前 | `astra_lock acquire` / `release` |
| 派发 | `dsh_dispatch` |
| 看进度 | `dsh_status` |
| 诊断等待（不常用） | `dsh_wait` |
| 回答/追加/打断 | `dsh_message` |
| 停止 | `dsh_cancel` |
| 读报告 | `dsh_result` |
| 看真实 diff | `dsh_diff` |
| 读真实文件/校验字节 | `dsh_read_file` |
| 验收/返工 | `dsh_review` |
| 诊断 | `astra_status` |

## 反例

- ❌ 把整段用户原话直接塞给 DSH，不写背景、文件和验收标准。
- ❌ DSH 还在跑时自己改同一批文件。
- ❌ 只读 `result.md` 就宣布完成，不打开真实文件。
- ❌ 任务失败后立刻重新派发，不先看 `dsh_result` 的错误。
- ❌ 把“等待 DSH”变成让用户在两边的应用之间复制粘贴。
