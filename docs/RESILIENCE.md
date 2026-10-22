# 中断感知、通知 outbox 与 watchdog runbook

本文说明桥在 ACP 传输故障、DSH 长时间静默、桥自身被杀时的真实行为、可观测字段和**不能保证的边界**。实现位于 `src/acp-client.mjs`、`src/task-runner.mjs`、`src/notifications.mjs`、`src/watchdog-supervisor.mjs`、`src/watchdog.mjs`。

## 1. 状态与证据

| 字段 | 写入者 | 含义 |
|---|---|---|
| `lastAcpUpdateAt` | runner（ACP update） | 最后一次真实 ACP `session/update`；流式 token 期间在内存更新、心跳时落盘 |
| `lastBridgeHeartbeatAt` | runner 定时器 | 桥自身仍活着；与 DSH 是否有输出分开解释 |
| `lastTool` | runner | 最后 `tool_call` 的 title/kind/时间 |
| `incident.json` | runner / watchdog sidecar | 最近一次异常的可读证据：code、exitCode、signal、stderr 摘要、部分输出、phase/tool、turn/session |
| `executionMayBeActive` | runner / task record | 控制连接丢失时旧 ACP 可能仍在执行；为 true 时保留锁、拒绝自动 resume |
| `stall.suspectedAt/recoveredAt` | runner | 静默警告 episode；仅警告，不取消任务 |
| `monitor` | watchdog supervisor | 当前 sidecar 的 pid/状态；`active/stopped/degraded/disabled` |
| `notifications/*.json` | outbox | 每任务/回合/事件的持久通知记录与 receipt |

`dsh_status`、`dsh_result`、`astra_status`、`astra_inbox` 会呈现 `health`、incident、notification 计数/错误、`executionMayBeActive` 与 monitor 状态。

## 2. ACP 传输故障

桥监听：

- 子进程 `exit`（code/signal）
- stdout `close`（子进程仍活着也算断流）
- stdin `error`（例如 `EPIPE`）
- 不可恢复的协议流（连续 50 行无法解析）

任一故障调用同一条幂等终止路径：拒绝所有 pending、`alive=false`、清空 turn handlers、记录 stderr 尾部（截断 + 脱敏）、首次 settle 后不再重复。**传输故障不自动 kill ACP**；只有显式 `dispose`/用户 cancel 清理路径才会按授权终止子进程。正常 `dispose`/用户 `session/cancel` 走预期路径，不产生失败 incident。

用户 cancel 在 `ASTRA_DSH_CANCEL_GRACE_MS` 内未获 ACP 确认时，任务标记 `cancel-unconfirmed`、`executionMayBeActive=true`、锁保留，不启动第二个写者；ACP 稍后确认停止时自动 resolve incident、清风险并释放本任务锁。

**全 workspace 写入口门禁：** `WorkspaceStore.acquireLock` 在触碰任何 lock 之前扫描本 workspace 的未解决 execution risk（`task.executionMayBeActive` 或同 turn incident；同 turn 且不早于 incident 的 resolution 才排除风险）。风险存在时：
- `astra_lock acquire`、`dsh_dispatch`、`startNextQueued` 都返回 `EXECUTION_MAY_BE_ACTIVE`；
- dead owner、expired TTL、锁文件缺失都不能让新 writer 通过；
- `inspectLock` 返回 `blockedByExecutionRisk` / `reclaimable=false`，status 同时给出 `executionRisk`；
- 不可读的 task/incident 记录失败关闭为 `EXECUTION_RISK_UNKNOWN`，不默默放行。

**慢工具不是故障**：`session/prompt` 没有超时定时器；只有传输断开才提前结束。

dispose 在子进程已退出时立即完成，并清理自己创建的 timer/listener；否则先 `stdin.end()`，再按 800ms SIGTERM / 2.3s SIGKILL / 4s 硬上限收尾。

## 3. 异常回合与队列

- 失败/中断先写 incident + outbox，再执行 `verifyCommands`；不需要等最多 5 条验证跑完才告警。
- `executionMayBeActive=true` 时跳过验证，避免与可能仍在执行的旧 ACP 并发写工作区。
- 失败/中断**不**自动启动 `task.queue`；队列保留并记录 `queue_retained`。正常 `end_turn` 仍自动开始下一条排队指令。
- 队列变更使用 `queueRevision`；durable outbox 与 `task.json` 分离，旧快照不会覆盖新 turn/review/通知。

## 4. 通知 outbox 的真实交付边界

事件 id 固定为 `taskId~turn~kind`。发送前重新读取任务，过滤已 review、已换 turn、已取消、stall 已恢复等失效记录；同 thread 的多条事件合并为一次 `codex queue --thread <dispatch thread>`。

```text
record: {
  id, taskId, turn, kind, threadId,
  status: pending|sending|retrying|sent|suppressed|degraded,
  attempts, lastAttemptAt, nextAttemptAt, lastError,
  receipt: { at, threadId, code, messageChars, attempts }
}
```

发送流程：

1. 原子 `mkdir notifications/claims/<id>/` 抢 claim；claim 内包含 owner token，已有未过期 claim 则跳过。
2. 写 `status=sending`、`attempts+1` 后再调用 CLI；CLI 执行期间每 lease/3 续租。
3. 成功写 receipt / `sent`；失败写 `retrying` + 指数退避。
4. 只有持有同一 token 的 owner 才能 release；旧 owner 不会删除新 sender 的 claim。
5. 事件 payload（thread/message/detail/episodeAt）写入后不可变；late enqueue 不会把 sent receipt 覆盖回 pending。
6. recover 只接管无健康 claim 的记录；健康 claim 属于另一个可能仍活的 sender，recover 不修改也不删除。
7. bridge restart 时过期 `sending` 才视为可重试。

**边界：外部 `codex queue` 没有幂等 key。** 桥可以保证同一事件在 claim 健康时最多一次发送；但如果 CLI 已接收消息、进程在写 receipt 前崩溃，租约过期后会再发一次。因此是 **at-least-once（可能重复）**，不是 exactly-once。消息包含任务 id/turn，重复可识别。CLI 运行期间会续租，但续租是协作式的：发送进程被 SIGSTOP/整机挂起超过 lease 时仍可能被第二个 sender 接管。

缺少 dispatch thread / Codex CLI / watchdog 启动失败会写 `degraded` 记录并在 `dsh_dispatch`、`dsh_status`、`astra_status` 显示原因；不会静默丢弃。

## 5. Watchdog sidecar 生命周期

- 每个新 turn：supervisor `spawn(process.execPath, [watchdog.mjs, workspace, taskId])`，`detached: true`，仅保留 IPC，stdin/stdout/stderr 均为 ignore。
- supervisor 只在收到带 task/turn/runner instance 的 `ready` ACK 后报告 active；初始化失败/超时会收尾 sidecar 并在任务 status 显示 degraded。
- sidecar 只继承受控 env 子集（桥 retry/CLI/预算配置、PATH/HOME/TMPDIR、mock CLI 测试变量），不隐式继承整个 `process.env`。
- 正常 turn end / cancel：桥发送 `{type:'shutdown'}`，sidecar 退出；supervisor 等待退出并记录 `monitor.watchdog=stopped`。
- 桥被 SIGKILL：IPC `disconnect` 触发；sidecar 等 200ms，确认 task 仍是同一 runner instance/turn 且 `state=running`，然后写 `incident-control-lost.json` + outbox `control-lost`。
- 父进程已死时 sidecar 在 `ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS` / `..._MAX_ATTEMPTS` 预算内只重试自己的 control-lost 事件；成功、失效、degraded 或预算耗尽才退出。耗尽时记录保持 `retrying` 并写明等待下次 bridge recovery。
- 桥 stdio 正常关闭但仍有一个 running turn：runner shutdown 以 `reason=bridge-shutdown` 通知 sidecar，sidecar 同样记录 control-loss。
- sidecar **只读** `task.json`，只写 incident/outbox；不修改任务状态、不 resume 模型、不释放锁、不碰业务文件。
- `executionMayBeActive` 由 ACP PID 是否可验证存活决定：活着/未知 → true；可证明已死 → false。
- 启动失败或 `ASTRA_DSH_WATCHDOG=0`：`monitor` 显示 degraded/disabled；桥存活时仍有启动/status 的 reconcile 兜底，但**没有**桥崩溃的独立告警。

未修改的老任务不会被自动 retrofit、重启或附加 sidecar。

## 6. 疑似停滞

- 阈值 `ASTRA_DSH_STALL_WARN_MS`（默认 900000ms，`0` 关闭）。
- 只有在 `state=running` 且超过阈值没有 `lastAcpUpdateAt` 时，写一次 `suspected_stall` 事件/通知；任务保持 running、锁保留。episode identity 进入通知 id，同一 turn 恢复后再次安静会创建新的提醒，不会被旧 sent 记录吞掉。
- 新 ACP update 清理 episode、写 `stall_recovered`，不重复高频告警。
- `health.status=suspected-stall` 是 warning，不是 error；长工具会显示 `lastTool` 和最后活动时间。

## 7. 故障排查与安全升级

1. `dsh_status <task>`：先看 `state/health/incident/executionMayBeActive/lock/notification`。
2. `notification.retrying`：看 `attempts/lastError/nextAttemptAt`；不要人为改 `.astra-dsh/notifications`，桥会恢复。
3. `notification.degraded`：确认 dispatch 时 MCP `_meta.threadId`、`ASTRA_DSH_CODEX_BIN`、`ASTRA_DSH_NOTIFY_CODEX`。
4. `executionMayBeActive=true`：不要手工删锁，也不要直接 resume。先在桥外确认旧 DSH/ACP 进程已停止（通过 DSH 自己的进程/会话管理）；确认后才可用显式的 `dsh_message force=true` 清除 incident 活跃标记并释放保留锁，再由 Astra 决定如何继续。默认 `dsh_message` 会被拒绝。
5. `suspected-stall`：先看 `lastTool`；不要因为安静就 cancel 长工具。只有确认工具真的卡死才由用户/Astra 决策。
6. 升级桥代码：先让当前任务 settle 或 cancel；确认 `astra_status.lock` 为空且没有 `executionMayBeActive`；再替换/重启 MCP server。**不要**在 running 任务上重装 GUI 插件或重启 DSH GUI。
7. GUI 显示“任务已停止/进程退出”不等于 ACP 退出；外部 ACP 冷读会补 interrupted closer，`history.follow` 也看不到外部写入。不要把 GUI 投影当作 cancel/resume 证据，详见 `docs/EXTERNAL_SESSION_GUI.md`。
8. 保护业务任务：任何故障注入/测试只用临时 workspace + mock ACP/Codex；不要对真实业务 task/session/lock 做故障注入、清理、resume 或 cancel。

## 8. 测试矩阵

| 场景 | 测试 |
|---|---|
| stdout 关闭但子进程不退出 | `test/acp-client.test.mjs` |
| stdin EPIPE | `test/acp-client.test.mjs` |
| prompt 中进程退出 / exitCode / stderr 脱敏 | `test/acp-client.test.mjs` |
| 慢工具不误判 | `test/acp-client.test.mjs` |
| 部分输出 + incident + queue 不执行 + 原 thread 通知 | `test/resilience.test.mjs` |
| 用户 cancel 不告警 | `test/resilience.test.mjs` |
| 无 thread / watchdog 降级 | `test/resilience.test.mjs` |
| 静默长工具 warning / 恢复 | `test/resilience.test.mjs` |
| 通知退避、跨重启、失效、重复 settle、跨 sender claim | `test/notifications.test.mjs` |
| 旧快照不覆盖新 turn/review/outbox | `test/notifications.test.mjs` |
| EPERM / PID 存活不误判 | `test/notifications.test.mjs` |
| 模型选择失败 fail closed | `test/notifications.test.mjs` |
| 桥 SIGKILL / stdio 关闭 sidecar 告警 | `test/resilience.test.mjs` |
| 桥死且 CLI 先失败后成功（无新桥） | `test/resilience.test.mjs` |
| sidecar 预算耗尽保留 retrying 记录 | `test/resilience.test.mjs` |
| ready ACK 超时/早退、受控 env | `test/notifications.test.mjs` |
| 同一 turn 多次 stall / 恢复抑制待发 | `test/resilience.test.mjs` |
| cancel 未确认保留锁 | `test/resilience.test.mjs` |
| claim fencing / lease renewal / old release | `test/notifications.test.mjs` |
| 启动 reconcile 仅本 workspace | `test/resilience.test.mjs` |
| dead/expired/missing lock + active ACP 拒绝 astra/dispatch | `test/store.unit.test.mjs`, `test/resilience.test.mjs` |
| 同 turn resolution 放行、旧 turn incident 不阻断、unreadable risk 失败关闭 | `test/store.unit.test.mjs` |
