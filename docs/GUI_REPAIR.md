# GUI 修复 runbook

本文记录本次修复使用的只读 DSH Host API、发布列表事件来源、后续真 GUI 联调步骤，以及三个旧测试工作区的安全清理方案。仅描述，不执行任何真实 GUI 存储操作。

## 1. 本次使用的只读 API 与事件来源

来源在 DSH 宿主源码 `/Users/jiazhi.li/deepseek-harness/packages/`（只读查证，未改动）。

| 能力 | 位置 | 性质 |
|---|---|---|
| `ctx.sessionController.list(request, signal)` → `{ items: SessionSummary[] }` | `packages/api/session-controller/src/index.ts` `list()` / `src/list.ts` `ApiSessionList.list()` | 只读、冷安全，列出已 attached 与已持久化 session 摘要，**不 resume/create Agent** |
| `SessionSummary` 形状 | `packages/api/session-controller/src/types.ts` `SessionSummary` | `{ agentAvailable, sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`，标题在 `projections.values.title` |
| `ctx.emit('api-session/added', summary)` | `src/index.ts` 构造器：`session/created` → `ctx.emit('api-session/added', this.listState.summaryFor(session))` | 现有增量事件；客户端 `src/client/index.ts` `ctx.remote.$on('api-session/added', ...)` 消费它 |
| `ctx.workspaceRegistry.resolveByPath(path)` / `create(path, title?)` / `list()` | `packages/workspace/workspace/src/index.ts` | 只做归组；`create` 幂等按 canonical path 复用 |
| `workspace.attachSession(sessionId)` | `packages/workspace/workspace/src/entity.ts` | 校验 session header 的 canonical cwd 与 workspace path **严格相等** |

**关键结论**：外部 ACP 进程创建的 session 只写 `~/.dsh/sessions`，不会触发 host 进程内的 `session/created`，因此不会自动 `api-session/added`。GUI 插件用只读 `list()` 取到外部 session 摘要后主动 `emit('api-session/added', summary)`，即可在不重启 GUI 的情况下让客户端目录出现该 session。归组则由 `attachSession` 单独完成，两者互相独立。

## 2. 修复后的行为契约

- 桥侧 `guiPolicy=existing|create|off`（默认 `existing`）；`off` 全链无发布/归组副作用，`existing` 绝不创建工作区，`create` 才允许插件创建。
- 请求文件按不可变 per-identity 命名 `$DSH_HOME/astra-dsh/attach/<taskId>~<sessionId>~<generation>~<workspaceHash>.json`，旧 `<taskId>.json`（无 schema）由插件严格校验后迁移为 `existing`，绝不隐式 create。
- 插件先确认 session 在 `list()` 里可见，再处理工作区；成功/终态写 ACK `<…>.ack.json` 后删除请求；`waiting-session` 退避重试、插件重启续跑；每 pump 最多一次共享 `list()`。
- ACK 仅证明 host 已发布列表更新；`astra_status` 展示队列路径、插件 heartbeat/版本、每个任务的 `guiStatus` 与 `sessionId`。
- 状态：`queued` / `waiting-session` / `unregistered` / `attached` / `off` / `failed` / `private-home`。

## 3. 共享 home 降级策略（已修复）

- **不再因 ACP 退出/超时切换 home**：`spawnClient` 之前会把任何 `ACP_EXITED`/`ACP_TIMEOUT`/`ACP_SPAWN_FAILED` 都当作写权限失败并降级到私有 home，会静默孤儿化已有 session；现已移除该运行时降级。
- 仅当构造期有**明确的写失败证据**（`ensureDir` 抛错或 `isWritableDir` 失败）且工作区**无已持久化 session** 时才降级；已有 session 时保留共享 home 并把原因写进 `dshHomeFallbackReason`，错误可见而非静默迁移。

## 4. 真 GUI 联调步骤（待 Astra 验收后执行）

> **2026-10-22 更新：** workspace-attach 已加载 `version 2.0.0`，heartbeat `pid 25771` 持续刷新（本任务只读复核，未重装/重启）。步骤 2 已完成；仍待办的是真实客户端渲染核对与三项测试工作区清理。
>
> 以下是历史回合记录；本任务没有重装/重载插件、没有重启应用。

1. 确认插件仍是 link：`readlink ~/.dsh/profiles/desktop/node_modules/@astra-dsh/workspace-attach` 应指向本仓库 `gui-plugin`（新插件自包含，`index.js` 只 import `./protocol.js` 与 node 内建，不再依赖 `../src`）。
2. 由 Astra 验收通过后，在 Harness Plugin Manager 重装/重载该 bundle（`install_bundle`），或重启 DSH 使新 `index.js` 生效。
3. 让 GUI 保持打开，在任意项目用 `dsh_dispatch`（默认 `existing`）派发一个任务；10 秒内会话应出现在 GUI 会话列表，且仅当对应 workspace 已注册时才归到该项目分组下。
4. 用 `dsh_dispatch guiPolicy=create` 再派发一次，验证插件能创建工作区并归组；用 `astra_status` 看 `gui.plugin.version` 与 `gui.tasks[].guiStatus`。
5. 验证首条 prompt 前会话先以 blank 元数据出现、标题/blank 在首条 prompt 后由插件限窗重查并发布更新（fingerprint 含 title/blank/sessionListMetadata/updatedAt）。
6. 未验证项：真实客户端渲染时机、标题投影在冷 session 上的具体字段、`api-session/added` 对冷摘要 `projections.kind=cached` 的客户端呈现，均需在步骤 3–5 中观察确认。

## 5. 三个旧测试工作区的安全清理

以下目录是历史测试残留。表已用只读 `~/.dsh/storages/workspace.json` 核对：**session id 不是 workspace id**，真实 workspace id 是 workspaces 表记录 key。目录与 session log 都**不应删除**。本回合未操作真实 GUI 存储（见 `docs/DEPLOYMENT_RESULT.md`）。

| 目录 | 测试 session id | 真实 workspace id（已核对） |
|---|---|---|
| `/Users/jiazhi.li/work/.astra-gui-verify` | `47ca8b79-f434-46b5-a315-b11df0bcb058` | `2ad3af86-ea48-4246-ad23-7c50da71b4ab` |
| `/Users/jiazhi.li/work/.astra-attach-e2e` | `4e58e389-0523-41b0-b119-317cbe8cc841` | `13146b0d-c2d3-4715-aa4a-91c3ad15c712` |
| `/Users/jiazhi.li/work/.astra-trigger-test` | `15966851-507e-4e87-b98e-70f4bce4e2b7` | `39dc09aa-c37e-4087-9f73-8137c1197d81` |

三项工作区各自 `sessionIds` 仅含上面对应的单一测试 session（已核对无业务 session 混入）。受保护业务任务 workspace `/Users/jiazhi.li/Documents/Codex/2026-10-19/referenced-chatgpt-conversation-this-is-an` 的 workspace id 是 `c38ee553-fa9e-4dd4-ad7b-004f2fc69392`（session `17514af0-…`），本修复任务 workspace `/Users/jiazhi.li/work/astra-dsh-bridge` 的 workspace id 是 `fe62c029-28fe-401b-9d1c-7f1a33189b2e`（session `82fa9a86-…`），均不在清理范围。

> **2026-10-22 17:36 已执行：** 通过 `gui-plugin` 2.1.0 的 repair 队列完成三项清理，ACK 见 `~/.dsh/astra-dsh/repair/cleanup-astra-dsh-test-workspaces-20261022.ack.json`。下面保留原始安全步骤作为审计记录。

安全清理步骤（需在真实 GUI 进程内执行，由 Astra 验收后安排）：

1. **动态解析真实 workspace id**：对每个目录调用 `workspaceRegistry.resolveByPath('<目录绝对路径>')`，核对返回的 `workspace.id` 与上表一致、`workspace.path === realpath('<目录>')`、`workspace.sessionIds` 只含对应测试 session（混入业务 session 立即停止并报告）。
2. **读取 activity 与锁**：用 `astra_status`/锁信息确认这些测试 workspace 无活跃回合、无正在运行的 agent。
3. **先归档测试 session**（不 `stopActivity`）：对每个测试 session 调 `workspaceRegistry.archiveSession(sessionId)`（有活动会拒绝并保留，属预期）；归档隐藏不删 log，可 `unarchiveSession` 恢复。
4. **删除注册**：`workspaceRegistry.delete(workspace.id)`（幂等删除注册，保留目录与 session log）。
5. **留档**：把「目录 → 真实 workspace id → session id」映射写回本 runbook 或 notes。

恢复办法：删除注册后可重新 `create('<目录路径>')` 恢复注册；session 仍在 `~/.dsh/sessions` 持久化中；归档可用 `unarchiveSession` 还原。

## 6. 外部 ACP 会话被误投影为“已中断”

2026-10-22 用户会话 `8fa47077-3c19-4d94-abf4-90f4699f08eb` 出现 GUI“任务已停止 / DSH进程在本轮完成前退出”，但同期 Codex/Astra 仍持续看到 ACP `tool_call` 事件，只读解码 session log 也有 `turn/start` 无 `turn/end` 且文件继续增长。根因分析、源码位置、桥/插件安全边界和宿主最小修改建议见 `docs/EXTERNAL_SESSION_GUI.md`。

结论：**GUI 投影不是 ACP 退出证据**，不能据此 cancel/resume/删锁；本任务未修改宿主或 `gui-plugin/`，也没有热加载到执行本任务的旧 bridge。

## 7. 受保护任务

`/Users/jiazhi.li/Documents/Codex/2026-10-19/referenced-chatgpt-conversation-this-is-an/.astra-dsh/tasks/T-20261022-114003-a947/task.json`（state running，session `17514af0-8225-4b5d-9f6c-58851ae489a8`）全程按活跃保护：未修改其源码、task/lock、session 或工作区，未取消/恢复/重启。
