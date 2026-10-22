# 外部 ACP 会话在 GUI 中被误投影为“已中断”的分析

本文是只读分析，不修改 DSH 宿主或 `gui-plugin/`。结论先行：**GUI 显示“任务已停止 / DSH 进程在本轮完成前退出”不能证明 DSH/ACP 真的退出**。当前用户会话 `8fa47077-3c19-4d94-abf4-90f4699f08eb` 就是反例：GUI 给出该提示时，Codex/Astra 侧仍持续看到 ACP `tool_call` 事件；只读解码 `session.v4.jsonl.zstd` 可见 `turn/start` 后日志继续增长、但没有 `turn/end`。

## 1. 观测事实

- 时间：2026-10-22 16:36–16:38（本地），Astra 持续看到该 session 的 ACP 新工具事件。
- GUI 同期显示：“任务已停止 DSH进程在本轮完成前退出……”。
- 用户/Astra 对 `~/.dsh/sessions/--Users-jiazhi.li-work-astra-dsh-bridge--/8fa47077-3c19-4d94-abf4-90f4699f08eb/session.v4.jsonl.zstd` 的逐帧只读解码显示：存在 `turn/start`，没有对应 `turn/end`，且文件在观测窗口内继续增长。本任务没有重复实现该解码器，只核对了宿主源码路径与文件仍在增长的事实。
- 本任务没有停止/重启任何 ACP、MCP、Codex 或 GUI 进程；没有修改该 session、锁或业务任务。

因此，“未结束的 turn”与“writer 已死亡”是两个不同事实。GUI 当前把前者直接投影成后者。

## 2. 宿主源码路径（只读核对）

### 2.1 冷读会无条件补 interrupted closer

`/Users/jiazhi.li/deepseek-harness/packages/session-query/session-query/src/cold-read.ts`：

```ts
// readColdSessionLog(...)
return {
  eventState: read.eventState,
  header: handle.header,
  inheritedEventCount: handle.inheritedEventCount,
  events: [...events, ...interruptedTurnClosers(events)],
}
```

`readColdSessionLog` 是只读、一次性的冷读取。只要日志最后一个 turn 没有 `turn/end`，它就追加确定性的 `interruptedTurnClosers`，用于让“writer 崩溃”的日志折叠成平衡 transcript。问题在于：**外部 ACP 进程仍在写同一个日志时，冷读无法区分“writer 崩溃”与“writer 活着但当前没有 live handle 在宿主内”**。

### 2.2 follow 只跟踪宿主自己的 session/event

`/Users/jiazhi.li/deepseek-harness/packages/api/session-controller/src/history.ts`：

- `follow()` 通过 `sessionQuery.observeSession` 得到 opening snapshot，然后消费宿主 `session-controller` 的事件 follower / assistant stream。
- 外部 ACP 进程直接写 `~/.dsh/sessions/.../session.v4.jsonl.zstd`，不会向宿主 `session-controller` 发 `session/created` 或事件；因此 follow 的增量循环看不到这些外部写入。
- `source.source === 'prepared'` 时还会 `source.retain()` 并 `promote(promotion)`，把 prepared observation 升级成普通 Session activation。对“外部 writer 仍活着”的会话，这会把只读/冷快照误当成宿主拥有的会话。

### 2.3 结果是投影层面的“已停止”

GUI 在没有本进程 live session 时走冷读/历史快照路径；冷读补的 interrupted closer 会让 UI 把最后一个 turn 折叠成“已中断”。这不是 ACP 进程退出信号，也没有经过 DSH 的 runner/锁/心跳证据。

## 3. 安全结论：不要据此 cancel/resume

- 不要把 GUI 的“任务已停止”当成 `executionMayBeActive=false` 的证据。
- 不要据此调用 `dsh_cancel`、`dsh_message`、手工删锁或启动第二个 writer。
- 桥侧应继续以 durable `task.json` 的 `executionMayBeActive`、ACP PID、锁和 incident 为准；GUI 只用于查看。
- GUI 投影错误也不会被“再打开一次会话”修复；宿主 follow 仍可能看不到外部写入。

## 4. 桥/插件当前可安全处理的范围

在**不修改宿主、不修改 `gui-plugin/`** 的前提下：

- 桥继续把外部 ACP 会话作为持久 session 发布摘要（现有 `existing`/`create`/`off` 策略不变）。
- 插件可以只发布“已持久化可见”的 summary；不应把 GUI 的 interrupted 文案回写成任务状态、通知或锁状态。
- `astra_status`/`dsh_status` 的 health/incident/executionMayBeActive 是桥自己的证据，优先级高于 GUI 投影。
- 本次源码没有热加载到执行本任务的旧 bridge；**不能声称本回合已经受到新逻辑保护**。需要用户/Astra 在安全窗口重启 MCP 后，新代码才生效；本任务不重启。

## 5. 宿主最小修改建议（暂不执行）

目标：保留“writer 真崩溃 → interrupted closer”的既有行为，同时不对“外部 writer 仍活”的日志伪造中断。

1. `packages/session-query/session-query/src/cold-read.ts`
   - 给 `readColdSessionLog` 增加只读选项，例如 `unfinishedTurnPolicy: 'interrupted' | 'open'`（默认 `'interrupted'` 保持兼容）。
   - `'open'` 时不追加 `interruptedTurnClosers`，并在返回值标记 `unfinishedTurn: true` / `lastEventAt`。
2. `packages/api/session-controller/src/history.ts` + `index.ts`
   - 在 `sourceFor` 判断会话是否可能由外部 writer 持有：只读检查 `session.lock` 是否存在且新近更新、日志 mtime/大小是否在增长、或引入轻量外部 writer heartbeat；只有确认无外部 writer 时才用 `'interrupted'`。
   - 对外部会话禁止 `promote`，改为返回显式 `unfinished/external` 状态，避免 prepared snapshot 被升级成宿主普通会话。
3. `SessionSummary` / projection API
   - 增加只读字段：`writer: 'host' | 'external' | 'unknown'`、`turnOpen`、`lastEventAt`、`live`。
   - GUI 对 `turnOpen && writer=external` 显示“外部会话仍在写入/当前 turn 未结束”，而不是“任务已停止”。
4. 可选：`session-query` 提供只读的 `isExternalWriterActive(sessionId)`，由 session-controller 注入；不要在插件里复制宿主内部路径解析。

最小测试方案：

- 临时 session 日志写入 `turn/start`、不写 `turn/end`，文件继续增长；调用 `readColdSessionLog(..., {unfinishedTurnPolicy:'open'})`，断言没有 synthetic closer、`unfinishedTurn=true`。
- 同一日志保持增长时调用 `history.follow`：断言不会把外部写入当成宿主事件，也不会 `promote`；应返回显式 external/unfinished 状态或明确 unsupported，而不是伪造 interrupted。
- 停止写入并确认外部 writer 死亡后，再走默认 `'interrupted'` 路径，断言仍能折叠成 balanced transcript。
- 回归：宿主自己崩溃/正常结束的 session 行为不变。

## 6. 当前证据边界

- 已核实：GUI 文案与 ACP 实时事件矛盾；冷读代码会补 interrupted closer；follow 只消费宿主事件；本任务未改宿主/GUI。
- 未核实：该 GUI 文案最终由哪个具体 projection/frame 渲染；外部 writer 的存活判定应以 lock、心跳还是文件增长为准，需要在宿主测试中确定。
- 不声称：GUI 已经修复、外部会话已经获得 live follow、当前运行中的旧 bridge 已受本次源码保护。
