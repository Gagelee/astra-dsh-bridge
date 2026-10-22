# Astra ↔ DSH 桥

让 **Codex 中的 Astra 负责规划与任务拆解，DSH 负责执行**，两者共享同一个本地工作目录。

*English: a local MCP/ACP bridge that lets Codex/Astra plan and review while DSH executes in the same workspace, with a shared `.astra-dsh` task board and optional DSH GUI session grouping.*

- Astra 通过 MCP 工具把完整任务包交给 DSH，不需要你复制粘贴上下文。
- DSH 在共享目录里真实改文件；进度、工具调用、问题、最终结果都写回任务板。
- Astra 可以查询进度、追加指令、打断、取消、要求返工，并直接读取共享目录审阅改动。
- 需求可以从 Codex 发起，也可以从 DSH 发起：DSH 把需求写进同一块任务板，Astra 用 `astra_inbox` pickup。

```
Codex / Astra  ──MCP(stdio)──▶  astra-dsh bridge  ──ACP(stdio)──▶  dsh acp（持久会话）
      │                              │                                   │
      └──────────── 共享工作目录 <workspace>/.astra-dsh/ ◀───────────────┘
```

## 快速开始

```bash
cd /path/to/astra-dsh-bridge
node install.mjs --dry-run   # 预览将要写入的文件
node install.mjs --yes       # 安装 Codex MCP 配置、Codex skill、DSH skill
```

GUI 自动归组插件 `@astra-dsh/workspace-attach` 已从 `gui-plugin/` 安装到当前的 desktop profile；如果重装 profile，需要在 Harness 的 Plugin Manager 里重新安装这个本地 bundle（见 `gui-plugin/README.md`）。

安装后重启 Codex，在项目里说：

> 把这个需求交给 DSH 执行：……

Astra 会调用 `dsh_dispatch`；任务完成后桥会在**同一个 Codex thread** 里触发一轮 Astra，Astra 再用 `dsh_result` 审阅并 `dsh_review`。

从 DSH 侧发起需求：

```bash
astra-dsh request --workspace "$PWD" --title "支持 CSV 导出" --body-file - <<'EOF'
报告页需要 CSV 导出，UTF-8 BOM，文件名带日期。
EOF
```

然后在 Codex 里说“pickup 共享任务板里的需求”，Astra 会先调用 `astra_inbox`。

## 目录结构

每个工作目录下自动生成：

```
.astra-dsh/
├── requests/<REQ-id>/
│   ├── request.json      # 元数据：来源、优先级、状态、关联任务
│   ├── request.md        # 需求原文
│   └── plan.md           # Astra 的规划/拆解
├── tasks/<T-id>/
│   ├── task.json         # 状态、会话、队列、变更、用量、审阅
│   ├── task.md           # 交给 DSH 的完整任务包
│   ├── events.jsonl      # 实时事件：消息/工具/权限/回合
│   ├── result.md         # 最新回合的结果报告
│   ├── changes.json      # 变更文件与 diff
│   ├── verification.json # 桥独立执行的验收命令结果
│   ├── review.md         # Astra 或自动验收的结论
│   ├── incident.json     # 最近一次失败/中断的可读证据（部分输出、退出码、stderr 摘要）
│   └── turns/<NNN>/      # 每回合的 prompt / result
├── notifications/        # 持久通知 outbox（每任务/回合/事件一条记录 + 原子 claim）
├── locks/workspace.lock/ # 单写者锁
└── logs/                 # ACP stderr、bridge 与 watchdog sidecar 诊断日志
```

`git` 仓库会把 `.astra-dsh/` 追加到 `.git/info/exclude`，不会污染 `git status`，也不会改受版本控制的 `.gitignore`。

## 协作协议

### 1. 任务包（Astra → DSH）

`dsh_dispatch` 的字段构成任务包，至少包含 `goal`、`implementationPlan` 与一条 `acceptance`：

| 字段 | 作用 |
|---|---|
| `title` | 任务标题 |
| `taskKind` | `implement`（默认，要求 `writeScopes`）/ `verify` |
| `goal` | 要实现的结果 |
| `implementationPlan` | Astra 的分析结论和实施计划；DSH 按此动手，可补充实现级分析，但不能另做产品规划 |
| `context` | 背景、历史决策、项目理解、用户约束 |
| `files` | 相关文件与说明 |
| `constraints` | 硬性限制 |
| `acceptance` | 可验证的验收标准（必填） |
| `deliverables` | 交付物 |
| `outOfScope` | 明确不做什么 |
| `notes` | 补充说明 |
| `requestId` | 关联的需求 |
| `writeScopes` | 预计会改的路径；`auto` 验收时也用于检查改动是否越界 |
| `reviewMode` | `auto` / `light` / `full`，默认 `light` |
| `verifyCommands` | 桥在每回合后独立执行的验收命令（最多 5 条，每条 120s） |
| `guiPolicy` | GUI 归组策略：`existing`（默认，只复用同路径已注册工作区）、`create`（允许 GUI 插件创建）、`off`（不投递 GUI） |
| `guiWorkspaceTitle` | 仅当 `guiPolicy=create` 实际新建工作区时使用的显示标题 |
| `model` / `reasoningEffort` | 本次任务使用的 DSH 模型与推理档位 |

任务包原样落盘为 `task.md`，并注入 DSH 的第一条 prompt。**Astra 负责分析、方向、优先级和计划；DSH 负责按计划修改。** DSH 可以在实现中进一步分析代码和边界，但交付物是改动和验证结果，不是产品分析/路线图。

### 2. 回合与持久会话

- 一个任务对应一个 DSH ACP 会话，跨回合、跨桥重启持久化。
- 任务 settle 后，桥用 `codex queue --thread <当前 Codex thread>` 触发一轮 Astra；不轮询、不新建 session。
- `dsh_status` 随时看进度；`dsh_result` 读完整报告；`dsh_wait` 只作为诊断/兜底。
- `dsh_message` 在 DSH 运行时进入队列，当前回合结束后自动开始下一回合；`mode=interrupt` 会先取消当前回合。
- `dsh_cancel` 停止当前回合并清空队列，会话日志保留，可继续。

### 3. 单写者锁

- DSH 回合运行时持有 `workspace.lock`；此时 `dsh_dispatch` 和 Astra 的写锁都会被拒绝。
- Astra 自己改文件前应 `astra_lock action=acquire`，改完 `release`，再派发 DSH。
- 锁带 PID 与过期时间，进程崩溃后可被回收。

### 4. 分级验收

`reviewMode` 决定“谁在什么证据下签收”，不改变 DSH 的执行方式。

| 模式 | 谁签收 | 桥做什么 | 适用 |
|---|---|---|---|
| `auto` | 桥自动 | 回合后跑 `verifyCommands`；全部通过、无问题、无排队指令、改动都在 `writeScopes` 内，才自动 `accepted` 并把父需求置 `done` | 确定性高、低风险、验证命令可靠的机械任务 |
| `light` | Astra | 跑 `verifyCommands` 并把结果放进状态/结果；不自动签收 | 低风险、Astra 看 diff/文件即可 |
| `full` | Astra | 同 `light`，Astra 补独立证据并做 targeted 复跑 | 高风险、跨模块、需求有歧义、并发/生命周期 |

`reviewMode` 是 Astra 对“证据是否足够”的判断，不是按任务类型查表。判断维度：影响面、可逆性、可观测性、不确定性、并发/生命周期、环境依赖。选择理由应写进 task 的 `context`/`notes`。

独立复跑只在以下情况需要：任务改了测试/夹具、结果不一致或 flaky、改动涉及并发/锁/进程生命周期/崩溃恢复、或现有证据覆盖不了验收标准。否则 `light` 直接用桥的 verification + diff + 关键文件，不重跑 DSH 已跑过的全量套件；`full` 也优先“变更相关测试 + 一个 smoke”，只有明确的 flaky 假设才重复全量。

`auto` 的硬性条件：

- `stopReason` 必须是 `end_turn`，任务不能是 failed/cancelled/interrupted
- DSH 没有提出 `QUESTION:`，没有排队中的追加指令
- 至少一条 `verifyCommands`，且全部 exit 0、未超时
- 有文件改动时必须声明 `writeScopes`，且所有改动都在声明的路径内

任一条件不满足，任务保持 `idle`，`autoReview.reasons` 写明原因，交给 Astra 审阅。**`auto` 不是“盲信 DSH”，而是“盲信桥独立执行的验证命令”**；`verifyCommands` 由 Astra 设计，执行结果与 stdout/stderr 都落盘。

命令在共享工作目录执行，属于受信输入；不要接受用户提供的任意命令。它们不会修改 DSH 的会话，也不替代 Astra 对高风险改动的判断。

### 4.1 交接前的评估

`reviewMode` 由 Astra 判断，但判断必须有固定标准：选择**成本最低但证据充分**的档位。

风险维度：影响面（单文件 vs 公共 API/跨模块）、可逆性（代码 vs 数据/权限/删除）、可观测性（确定性测试 vs 主观交互）、不确定性（需求是否清楚）、并发/生命周期（锁、进程退出、通知重试、长任务）、环境依赖（本地 vs 真实 GUI/外部服务）。

证据标准：

- `auto`：机械、边界封闭，验证命令通过等价于验收，没有需要人判断的语义
- `light`：局部、可逆、diff 可读，现有测试/`verifyCommands` 能捕获失败；Astra 看真实 diff + 关键文件 + verification，不重跑全量
- `full`：高风险维度命中，或 `light` 证据不足；Astra 补独立证据，但仍以 targeted 测试 + smoke 为主

升级：`light` 中出现验证失败、flaky、越界改动、需求实质疑问，升级 `full`；不要为了省 token 压回 `light`。在 `context`/`notes` 写选择理由。

### 4.2 触发式完成（不再轮询）

- `dsh_dispatch` 后 Astra 结束回合，不调用 `dsh_wait`。
- 任务 settle 时，桥从当前 MCP 调用 `_meta.threadId` 取得同一 Codex thread，执行：

```bash
codex queue --thread <threadId> --message "DSH task T-... settled; call dsh_result and dsh_review."
```

- 这会开启**一轮新的 Astra**，但仍在原 thread / 原 session，不新建会话。
- 多个任务同时 settle 会合并成一条消息；`auto` 已签收、`cancelled` 的任务不触发。
- `dsh_wait` 保留为诊断/兜底；如果它正在等，桥会抑制**正常完成**通知，避免双唤醒；失败/中断/控制连接丢失等异常通知永不被它吞掉。
- 桥仍会在回合结束后本地执行 `verifyCommands`，不消耗模型 token。
- 通知不再只存在内存里：每条事件写入 `.astra-dsh/notifications/<id>.json`，失败按指数退避重试，桥重启后继续未完成的记录。详见 4.4。

### 4.4 故障感知、疑似停滞与安全边界

**ACP 传输故障（可感知）**

- 桥同时监听 ACP 子进程 `exit`、stdout 断流、stdin `EPIPE`/错误和不可恢复的协议流。任一故障只 settle 一次：拒绝全部 pending 请求、标记客户端不可用、通知 runner 记录 incident。
- 传输故障**只终止控制 pending，不自动 SIGTERM/SIGKILL 仍可能执行的 ACP**；只有显式 `dispose`/用户 cancel 的清理路径才按授权语义终止子进程。
- incident 保留 `errorCode`/`exitCode`/`signal`、最后 stderr 摘要（截断并脱敏）、最后 phase/tool、session/turn 和**已产生的部分 assistant 输出**。部分输出在 `incident.partialText`，任务 `lastAssistantText` 也尽量保留。
- 故障/失败会先持久化 incident 和通知 outbox，再执行最多 5 条 `verifyCommands`，不需要等验证跑完才告警。
- 用户 `dsh_cancel` 与正常 `dispose` 是预期路径，不会产生失败告警；只有异常断连才写 incident。

**`executionMayBeActive` 与锁**

- 如果 stdout/stdin 断裂但 ACP 子进程可能仍在跑，或者桥自己消失时 ACP 仍存活，桥会标记 `executionMayBeActive: true`，**保留 workspace 锁**，并拒绝 `dsh_message` 自动 resume / 新写者接管。
- 该风险在 `WorkspaceStore.acquireLock` 这一全 workspace 写入口生效：`dsh_dispatch`、`astra_lock acquire`、queued turn 都会在 `EXECUTION_MAY_BE_ACTIVE` 处被拒绝，**即使 owner bridge PID 已死、TTL 已过期或锁文件缺失**。只有同 turn 的有效 resolution 才放行；`dsh_status`/`astra_status` 的 `lock.blockedByExecutionRisk`/`executionRisk` 会显示风险任务，stale 与可回收是两回事。
- 用户 cancel 若在 `ASTRA_DSH_CANCEL_GRACE_MS`（默认 20s）内未获 ACP 确认，不会把 `executionMayBeActive` 置 false 或放锁；`dsh_cancel` 返回 `cancelConfirmed=false / lockRetained=true`，状态显示 `cancel-unconfirmed`。如果 ACP 稍后确认停止，runner 会自动清除风险标记并释放该任务锁。
- 这种情况下的告警文案是“控制连接丢失，执行可能仍活跃”，不是“任务已停止”。桥不会为了感知故障自动 kill 真实任务。
- 只有能证明 ACP 进程已退出（或明确是用户确认 cancel）时才释放锁。若 `dsh_status` 显示 `executionMayBeActive`，请先在桥外确认旧 DSH/ACP 进程已停止。确认后可用显式的 `dsh_message force=true` 清除 incident 活跃标记并释放保留锁；该操作会写入 `executionMayBeActiveResolvedAt/ResolvedTurn` 证据，旧 snapshot 不能清除真实风险，也不能复活已确认的恢复。默认（无 `force`）会被拒绝，绝无自动 resume。
- PID 存活判断遵循：`EPERM`/未知 = 可能存在，绝不据此断言死亡；PID 存活但心跳陈旧也不自动判死（可能复用或挂起）。只有确定死亡，或本 runner 确认自己不再拥有活跃回合时，才进入 interrupted。

**异常回合与队列**

- 失败/中断不会自动执行 `task.queue` 里的后续写操作，队列原样保留给 Astra 决策；正常 `end_turn` 仍按既有语义自动开始下一条排队指令。
- 任务 `queueRevision` 与 durable outbox 隔离，旧 `task.json` 快照不会覆盖新回合、新 review 或通知状态。

**持久通知 outbox 与真实边界**

- 事件 id 为 `taskId~turn~kind`，同一事件重复触发只保留一条；发送前重新读取最新任务并过滤已 review、已换 turn、已取消、stall 已恢复等失效事件。
- 只允许 `codex queue --thread <dispatch 时该次 MCP `_meta.threadId`>`；不会新 session、不会用固定会话名、不会取用户 args 或其他 thread。
- claim 使用原子 `mkdir` 租约 + owner token；runner 与 watchdog sidecar 不能同时发同一事件。事件 payload 写入后不可变，发送状态/attempts/receipt 只能在 claim 内修改；CLI 调用期间按 lease/3 续租，旧 owner 的 release 不会删除新 owner 的 claim。recover 只接管无健康 claim 的记录。成功后写 `receipt`，失败持久化 `attempts`/`lastError`/`nextAttemptAt` 并退避。
- CLI 没有幂等 key。桥能保证：同一事件在 claim 健康时最多一次发送；但“CLI 已接收、receipt 落盘前进程崩溃”会在租约过期后重试一次，因此真实语义是 **at-least-once**（可能重复），不是 exactly-once。消息里带任务 id/turn，重复投递可识别。lease 续租是协作式的：如果发送进程被 SIGSTOP/整机挂起超过 lease，仍可能出现重复。
- 缺少 dispatch thread、Codex CLI 或 watchdog 启动失败时，`dsh_dispatch` 和 `astra_status`/`dsh_status` 会显示 `degraded` 及原因，不会静默丢弃。

**桥自身被 SIGKILL / stdio 关闭**

- 每个新回合启动一个小型、独立的 watchdog sidecar（不是 daemon/cron/launchd），通过 IPC 与桥相连。supervisor 必须收到携带 task/turn/runner instance 的 `ready` ACK 才报告 active；初始化失败/超时会收尾并显示 degraded。sidecar 只继承受控 env 子集（桥配置、PATH/HOME/TMPDIR、测试 mock CLI 变量），不隐式继承任意进程环境。正常回合结束/取消时桥发送 `shutdown`，sidecar 退出。
- 父进程消失（包括 SIGKILL）或 stdio 关闭且回合仍在运行时，sidecar 读取 durable task/runner instance+turn+ACP PID，写一条 `incident-control-lost.json` 和一条 control-lost 通知，向**dispatch 时的原 thread**告警。
- 父进程已死时没有新的 bridge 驱动 outbox，sidecar 会在 `ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS`/`..._MAX_ATTEMPTS` 预算内只重试**自己的 control-lost 事件**；成功、失效、degraded 或预算耗尽才退出。耗尽时记录保持 `retrying` 并写明“future bridge start will resume”，由下次桥启动恢复。
- sidecar 不修改 `task.json`、不 resume 模型、不释放未知锁、不碰业务文件；它只读任务、写 incident/outbox 并发送通知。
- 若配置 `ASTRA_DSH_WATCHDOG=0` 或 sidecar 无法启动，状态会明确显示 disabled/degraded；桥存活时仍有启动/`status` 时的 reconcile 兜底。未修改的老任务不会被自动 retrofit 或重启。

**长时间无进展 ≠ 失败**

- `lastAcpUpdateAt` 记录 ACP 最后一次语义更新；`lastBridgeHeartbeatAt` 记录桥自身心跳。两者分开解释“DSH 没输出”和“桥死了”。
- `ASTRA_DSH_STALL_WARN_MS`（默认 15 分钟，`0` 关闭）每个 quiet episode 发一次 suspected-stall 警告/通知（episode identity 进入通知 id），任务保持 `running`、锁保留，不 auto-cancel、不算 interrupted；长工具会带上当前 tool 和最后活动时间。
- 新 ACP 活动会清除 episode 并记录 `stall_recovered`，避免持续高频唤醒。`dsh_status` 把这种情况显示为 warning，不显示为 error。

更完整的字段、通知状态机、故障排查和安全升级步骤见 `docs/RESILIENCE.md`。GUI 把外部 ACP 未结束 turn 显示成“任务已停止”的问题不是 ACP 退出证据，分析见 `docs/EXTERNAL_SESSION_GUI.md`。

### 4.3 需求确认 reviewer（可选，默认关闭）

“需求确认”可以外包给一个 Codex 侧的 reviewer 子代理，而不是让 Astra 自己做完整验收：

- 模型：`gpt-6.1-sol`，reasoning `medium`
- 只读；输入是 task packet + `dsh_result` + `verification` + `dsh_diff`
- 输出 `VERDICT: PASS|FAIL`、逐条验收标准的证据、缺口
- Astra 根据 verdict 调 `dsh_review`，并负责最终交付

分工：

| 层 | 执行者 | 产物 |
|---|---|---|
| DSH 自检 | DSH | `finalText` 里的自述与命令 |
| 桥独立验证 | bridge | `verification.json`（命令、exit code、stdout/stderr） |
| 需求确认 | `gpt-6.1-sol` medium 子代理 | PASS/FAIL + 证据 + 缺口 |
| 最终签收 | Astra（高风险时可加人工） | `review.md` / `dsh_review` |

reviewer 默认关闭。DSH 回合内已经自检，桥也会独立跑 `verifyCommands`；只有“测试能过，但不确认是否做对了需求”时才加这一层。它不替代高风险验收，也不要给 `auto` 任务再开一轮；桥本身不调用 Codex 模型，reviewer 是 Codex 会话内的子代理，不引入新的控制面字段。

### 5. 审阅闭环

手动/`light`/`full` 模式：

1. `dsh_result` 读 DSH 报告、问题、变更文件、`verification` 结果与 diff。
2. Astra 自己打开共享目录里的真实文件/运行测试（而不是只信报告）。
3. `dsh_review accepted` 记录通过；或 `changes_requested` + `dsh_message` 返工。
4. 只有在真实改动通过验收后，Astra 才向用户交付。

`auto` 通过后，Astra 仍可在最终交付前抽检；若发现问题，用 `dsh_review changes_requested` 重新打开任务。

## DSH GUI 可见性

Codex 发起的任务会出现在 DSH GUI 的会话列表里：

- 会话写入 `~/.dsh/sessions/<编码后的工作目录>/<session-id>/`；标题取任务 prompt 的首行，已带任务 ID 和标题。
- 桥在创建 ACP 会话后把请求写入 `~/.dsh/astra-dsh/attach/<taskId>~<sessionId>~<generation>~<workspaceHash>.json`（不可变 per-identity 命名；`guiPolicy=off` 时不写）。旧 `<taskId>.json` 请求由插件严格校验后按 `existing` 迁移，绝不隐式创建。
- 已安装的 GUI 插件 `@astra-dsh/workspace-attach` 轮询这个队列，在 GUI 进程内先通过只读的 `sessionController.list()` 确认会话已持久化可见，再 `ctx.emit('api-session/added', summary)` 把外部 ACP 会话发布进客户端会话目录（无需重启 GUI），最后按策略用 `workspaceRegistry.resolveByPath/create` + `workspace.attachSession` 归组。插件自包含（协议实现 `gui-plugin/protocol.js`），每 pump 最多一次共享 `list()`。
- `existing`（默认）只复用规范化后同路径的已注册工作区，不存在则返回 `unregistered` 跳过、不创建；`create` 才允许创建（title 缺省交给 registry 取目录名）；`off` 完全不发布、不归组。路径经 realpath 规范化防别名重复。
- 它只是 DSH 执行会话的持久化记录：可以查看 transcript，但**不要在执行中从 GUI 向它发消息**；控制面仍然是 Codex/Astra。
- 插件成功写持久化 ACK 后删除请求；`astra_status` 显示队列路径、插件健康/版本、每个任务的 `guiStatus`（`queued`/`waiting-session`/`unregistered`/`attached`/`off`/`failed`/`private-home`）。ACK 仅证明 host 已发布列表更新，不声称客户端已渲染。
- GUI 未运行/未注册/策略 off/私有 DSH_HOME fallback 都会给出可诊断状态；可用 `dsh_gui_retry` 受控重投，不影响任务执行。ACCP 进程退出/超时不再触发 home 切换。

## 用户旅程

### light（默认）/ full

1. 用户在 Codex 说“把这个需求交给 DSH”。
2. Astra 读项目、拆任务，调用 `dsh_dispatch`（`reviewMode` 默认 `light`）。
3. 桥写 `task.md`、加锁、打开/恢复 DSH 会话、把任务包作为 prompt 发出，立即返回 `taskId`。
4. Astra 结束回合；任务 settle 后，桥通过 `codex queue --thread <当前 thread>` 在同一会话触发一轮 Astra。
5. Astra 调 `dsh_result`，再用 `dsh_diff` / `dsh_read_file`（或自己的 shell/测试）核对真实改动。
6. 通过则 `dsh_review accepted`；不通过则 `changes_requested` + `dsh_message`/`continueTask` 发回 DSH 返工，**不要自己改 DSH 的交付文件**。
7. 验收通过后 Astra 派发下一个依赖任务，最后向用户交付。

用户只需要在开头表达一次需求；中间的派发、等待、追问、返工由 Astra 和 DSH 完成。

### auto

1. Astra 判断任务低风险且可机械验证，派发时带 `reviewMode: "auto"`、`verifyCommands`、`writeScopes`。
2. 桥执行 DSH 回合，然后在共享目录独立运行验证命令，结果写入 `verification.json`。
3. 若验证全过、无问题、无排队指令、改动都在 `writeScopes` 内，桥自动把任务置 `accepted`，父需求置 `done`。
4. 任一条件不满足，任务停在 `idle`，`autoReview.reasons` 说明原因，回到 Astra 审阅流程。

### light 的检查范围

默认模式。与 manual 相同的回合流程，但桥会跑验证命令并把结果放进状态；Astra 通常只看 `dsh_diff` + `dsh_read_file` 即可签收，不要求完整测试复跑。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `astra_inbox` | pickup：列出需求、待审阅任务、运行中任务 |
| `astra_request_read` / `astra_request_create` / `astra_request_claim` | 需求的读取、创建、认领与规划 |
| `astra_lock` | Astra 写锁的 acquire/release/status |
| `dsh_dispatch` | 创建实现任务包（Astra 计划）并启动 DSH 回合 |
| `dsh_list` / `dsh_status` | 任务列表、进度、健康/incident/通知与锁状态 |
| `dsh_wait` | 诊断/兜底等待（正常流程不用） |
| `dsh_gui_retry` | 受控重投 GUI 会话可见性/归组（不启动或恢复任何 DSH 回合） |
| `dsh_message` / `dsh_cancel` | 追加指令/回答问题/打断/停止；`force=true` 仅用于确认旧进程已停止后清除可能活跃标记 |
| `dsh_result` / `dsh_diff` | 结果报告、真实工作区 diff |
| `dsh_read_file` | 读取真实文件字节与 sha256，用于验收 |
| `dsh_review` | 记录验收结论（手动/light/full），可选直接发送返工指令 |
| `astra_status` | 桥、ACP 进程、模型、锁、任务计数诊断 |

## 配置

由 Codex 启动 MCP server 时通过环境变量配置：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ASTRA_DSH_DSH_BIN` | `~/.local/bin/dsh` 或 PATH 中的 `dsh` | DSH 启动器 |
| `ASTRA_DSH_DSH_HOME` | `~/.dsh`（安装脚本写入） | DSH home（凭证、会话）；与 DSH GUI 共用，任务会话可在 GUI 中看到。若沙箱拒绝写入，桥回退到 `<workspace>/.astra-dsh/dsh-home` |
| `ASTRA_DSH_CREDENTIALS` | `~/.dsh/.credentials.yaml` | 凭证源；桥会在 DSH home 里创建只读符号链接 |
| `ASTRA_DSH_MODEL` | `deepseek-flash` | 默认执行模型 |
| `ASTRA_DSH_MODEL_PROVIDER` | `deepseek-official` | 模型提供方 |
| `ASTRA_DSH_EFFORT` | `high` | `off/low/high/max` |
| `ASTRA_DSH_PERMISSION_MODE` | `workspace-write` | DSH 自身沙箱 |
| `ASTRA_DSH_PERMISSION_POLICY` | `allow` | ACP 权限升级请求：`allow` 保持无人值守执行；`reject` 失败关闭 |
| `ASTRA_DSH_WAIT_MAX_SEC` | `300` | `dsh_wait` 诊断上限 |
| `ASTRA_DSH_NOTIFY_CODEX` | `1` | 任务 settle 时是否用 `codex queue` 触发同一 thread；`0` 关闭 |
| `ASTRA_DSH_CODEX_BIN` | 自动探测 Codex app CLI | `codex queue` 使用的 CLI 路径 |
| `ASTRA_DSH_LOCK_TTL_MS` | 2h | DSH 回合锁租期 |
| `ASTRA_DSH_VERIFY_TIMEOUT_MS` | `120000` | 每条 `verifyCommands` 的超时 |
| `ASTRA_DSH_STALL_WARN_MS` | `900000`（15 分钟） | 长时间无 ACP 更新的 suspected-stall 警告阈值；`0` 关闭，仅警告不取消 |
| `ASTRA_DSH_PROGRESS_HEARTBEAT_MS` | `5000` | 桥心跳/停滞检查间隔（测试可注入很短的值） |
| `ASTRA_DSH_PID_STALE_MS` | `120000` | runner 心跳视为陈旧的时间；陈旧也不单独断言进程死亡 |
| `ASTRA_DSH_NOTIFY_RETRY_BASE_MS` | `2000` | 通知 CLI 失败的首次退避 |
| `ASTRA_DSH_NOTIFY_RETRY_MAX_MS` | `300000` | 通知退避上限 |
| `ASTRA_DSH_NOTIFY_LEASE_MS` | `60000` | 通知 claim 租约；CLI 运行期间自动续租 |
| `ASTRA_DSH_NOTIFY_CLI_TIMEOUT_MS` | `30000` | `codex queue` 调用超时；与 lease 配合防止执行中被抢 |
| `ASTRA_DSH_WATCHDOG` | `1` | 每回合独立 watchdog sidecar；`0` 关闭（桥崩溃无独立告警，状态显示 disabled） |
| `ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS` | `3000` | 等待 sidecar ready ACK 的上限；超时收尾并 degraded |
| `ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS` | `300000` | 桥死后 sidecar 重试自己 control-lost 通知的总预算 |
| `ASTRA_DSH_WATCHDOG_NOTIFY_MAX_ATTEMPTS` | `20` | 桥死后 sidecar 重试次数上限 |
| `ASTRA_DSH_CANCEL_GRACE_MS` | `20000` | 等待 ACP 确认 cancel 的宽限；超时保留锁并标记 cancel-unconfirmed |
| `ASTRA_DSH_RECONCILE` | `1` | 启动/注册 workspace 时恢复本 workspace 的异常与待通知记录；不扫描其他项目 |

`ASTRA_DSH_PERMISSION_POLICY=allow` 只决定 ACP 权限请求的自动应答；DSH 的 `workspace-write` 沙箱仍然生效。若本机沙箱后端不可用（例如嵌套沙箱环境），DSH 可能请求升级；此时 `allow` 会让它继续，`reject` 会让它失败关闭。

## 常见问题

**DSH 报 sandbox 不可用。** 这是 DSH 自身的文件沙箱后端问题（macOS `sandbox-exec`、Linux bubblewrap/Landlock）。从普通 Codex 进程启动时通常可用；若仍不可用，可把 `ASTRA_DSH_PERMISSION_MODE` 设为 `danger-full-access`（不推荐），或保持 `allow` 让 DSH 在每次升级时请求一次性权限。Codex 自身的 sandbox 仍然约束最终可写范围。

**共享 `~/.dsh` 与 GUI 可见性。** 安装脚本把 `ASTRA_DSH_DSH_HOME` 指向 `~/.dsh`，并把 `~/.dsh` 加入 Codex 的 `sandbox_workspace_write.writable_roots`。这样 Codex 发起的 DSH 会话会写入 `~/.dsh/sessions`，DSH GUI 刷新后就能看到对应会话。

如果 Codex 沙箱仍然拒绝写 `~/.dsh`，桥会自动回退到 `<workspace>/.astra-dsh/dsh-home`，任务继续可用，但这些会话不会出现在 GUI 里，也不会写 attach 队列；`astra_status` 会显示 fallback 原因。凭证在共享模式下直接读取 `~/.dsh/.credentials.yaml`，回退模式下用符号链接，不复制密钥。

安全边界：`writable_roots` 让 Codex 的 MCP server 可以写整个 `~/.dsh`（包括会话、profile、日志）。这是为了 GUI 可见性做的取舍；如果你只想让桥写会话，可把 `writable_roots` 收窄到 `~/.dsh/sessions`、`~/.dsh/storages`、`~/.dsh/profiles`、`~/.dsh/logs` 等子目录。

**会话无法 resume。** ACP 的 resume 要求同一 `DSH_HOME`、同一工作目录、非子会话。桥会自动降级为新建会话，并在 `task.json` 里记录 `sessionRecreated: true`；任务包仍在，不会丢上下文。

**任务卡在 running / 很久没有输出。** 先看 `dsh_status`：`health=suspected-stall` 只是 warning，回合仍在跑、锁仍保留，不要当成失败；`lastTool` 会说明正在执行的工具。若 `executionMayBeActive=true`，说明控制连接曾异常丢失，旧 ACP 可能仍在执行，桥故意不释放锁、拒绝 resume。先在桥外确认旧 DSH/ACP 进程已停止，再处理任务。

**没有收到完成通知。** 看 `dsh_status`/`astra_status` 的 `notification`：`pending`/`retrying` 会显示 attempts、lastError、nextAttemptAt；`degraded` 常见原因是 dispatch 时没有 MCP `_meta.threadId`、找不到 Codex CLI 或 `ASTRA_DSH_NOTIFY_CODEX=0`。通知记录在 `.astra-dsh/notifications/`，桥重启会自动恢复。外部 CLI 无幂等 key，极端崩溃窗口可能重复一次，见 4.4。

**桥被 SIGKILL 后任务还会被通知吗？** 会，只要 watchdog sidecar 正常启动：它会写 `incident-control-lost.json` 并向原 thread 发 control-lost 告警，但不会改任务状态/锁。若 `astra_status` 显示 watchdog disabled/degraded，则没有独立告警，只剩桥存活时的 reconcile。

**Codex 看不到工具。** 确认 `codex mcp list` 中出现 `astra_dsh`，并重启 Codex。`astra_status` 能返回诊断信息。

**Codex 能派发但自己读不了文件。** 如果 Codex 的 shell 被本机 sandbox 拦截，用 `dsh_read_file` 读取真实文件；桥进程与 Codex 同处工作区沙箱，读工作区文件是允许的。

**工具调用被 Codex 要求审批。** 安装脚本在 `[mcp_servers.astra_dsh]` 上设置了 `default_tools_approval_mode = "approve"`。若你的 Codex 版本不接受该字段，改为在 Codex 设置中允许该 MCP server 的工具。

## 测试

```bash
node --test test/*.test.mjs     # 单元 + mock ACP/通知/watchdog 故障注入（不消耗模型额度）
ASTRA_DSH_DSH_HOME=$HOME/.dsh node scripts/real-e2e.mjs /tmp/some-workspace
```

故障注入测试全部使用临时 workspace、临时 DSH home 和 mock ACP/Codex：覆盖 ACP 退出/断 stdout/EPIPE、部分输出保留、用户取消不告警、异常后队列不执行、通知退避与跨重启恢复、失效/重复事件、EPERM、无 thread 降级、watchdog 收尾，以及 SIGKILL/stdio 关闭后的 sidecar 告警。它们不触碰真实的业务任务或 ACP 会话。

真实端到端测试会启动 `dsh acp`、创建一个文件并回传结果。
