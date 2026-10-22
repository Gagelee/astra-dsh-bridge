# 部署/联调/清理阶段结果（Turn 3）

本文件记录第二阶段（部署、真 GUI 联调、三项测试工作区清理）的真实回执与阻塞项。只记录已核实事实，不假报未验证项。全程未重启任何进程、未修改任何业务 session/workspace/锁/任务控制记录、未在 GUI 向执行中的业务会话发消息。

## 1. 只读核对回执

- `dsh` CLI：`~/.local/bin/dsh`，版本 `0.1.7-rc.2`。
- DSH profiles：`~/.dsh/profiles/{acp,desktop,web,node_modules}`。desktop 是 Electron GUI profile，acp 是桥用的自动化 profile。
- `dsh plugin --profile desktop --help` → `error: profile "desktop" is managed exclusively by the Electron application`（desktop 插件管理只能走 Electron 应用）。
- `ps` 被本沙箱拒绝（`/bin/ps: Operation not permitted`）；`lsof` 可见：
  - 桌面应用在跑：`/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness`（PID 1347）。
  - 本修复会话的 ACP 进程：`node`（PID 2160），cwd `/Users/jiazhi.li/work/astra-dsh-bridge`，持有 `~/.dsh/sessions/...82fa9a86-.../session.lock`。
- 插件安装形态（只读）：`~/.dsh/profiles/desktop/package.json` 声明 `@astra-dsh/workspace-attach: link:/Users/jiazhi.li/work/astra-dsh-bridge/gui-plugin`；`node_modules/@astra-dsh/workspace-attach` 是到本仓库 `gui-plugin` 的符号链接。即磁盘上已是我（turn 2）的源码，但桌面进程仍在跑旧版 v1.0.0（无 heartbeat）。
- 心跳：**已加载新版**。`~/.dsh/astra-dsh/heartbeat.json` 存在，`version: 2.0.0`、`pid: 25771`；2026-10-22T08:33:35.521Z 仍在刷新（本回合只读复核时间 08:33:42Z）。此前“desktop 插件尚未加载新版”的结论已过期。
- 受保护业务任务（只读）：`T-20261022-114003-a947` state `running`、phase `tool:bash`、turnIndex 3、session `17514af0-8225-4b5d-9f6c-58851ae489a8`、`updatedAt 2026-10-22T04:46:36Z`。全程未触碰。
- 本修复任务：`T-20261022-120550-d0e3` state `running`、session `82fa9a86-169a-44e5-a427-db781c3cc553`。

## 2. 已核实 workspace/session 映射（只读 `~/.dsh/storages/workspace.json`）

| 目录 | session id | 真实 workspace id |
|---|---|---|
| `/Users/jiazhi.li/work/.astra-gui-verify` | `47ca8b79-f434-46b5-a315-b11df0bcb058` | `2ad3af86-ea48-4246-ad23-7c50da71b4ab` |
| `/Users/jiazhi.li/work/.astra-attach-e2e` | `4e58e389-0523-41b0-b119-317cbe8cc841` | `13146b0d-c2d3-4715-aa4a-91c3ad15c712` |
| `/Users/jiazhi.li/work/.astra-trigger-test` | `15966851-507e-4e87-b98e-70f4bce4e2b7` | `39dc09aa-c37e-4087-9f73-8137c1197d81` |
| 受保护业务任务 | `17514af0-8225-4b5d-9f6c-58851ae489a8` | `c38ee553-fa9e-4dd4-ad7b-004f2fc69392`（**保护，不清理**） |
| 本修复任务 | `82fa9a86-169a-44e5-a427-db781c3cc553` | `fe62c029-28fe-401b-9d1c-7f1a33189b2e`（**不归档，仍执行中**） |

三项测试工作区各自 `sessionIds` 仅含对应单一测试 session，无业务 session 混入。其余 workspace（`/Users/jiazhi.li/work`、`/Users/jiazhi.li/work/NLAOP`、`/Users/jiazhi.li/work/NLAOP运营`）不在白名单，未触碰。

## 3. 阻塞项（需安全维护窗口，本回合无法安全完成）

以下事项都需要**桌面 Electron 应用进程内**的 host 服务（`pluginManager` / `sessionController` / `workspaceRegistry`）。本沙箱没有可达这些服务的受支持路由，也无法安全重启应用：

1. **重载 workspace-attach 插件（让 v2.0.0 生效）** — **已完成（用户回执 + 只读复核）**。
   - 证据：插件 heartbeat 为 `version: 2.0.0`、`pid: 25771`，2026-10-22T08:33:35.521Z 持续刷新；不再显示旧版无 heartbeat 的状态。
   - 本任务（T-20261022-160836-3996）没有重装、重载或重启 GUI 插件/应用，只做了只读心跳核对。

2. **真 GUI 联调（本修复 session 可见性 + ACK）** — 仍阻塞、未验证。
   - 需在 GUI host 内调用只读 `sessionController.list` 查 `82fa9a86-…` 摘要并 `emit('api-session/added')`；本沙箱不可达。不能假报 attached/visible。

3. **三项测试工作区清理（archiveSession + delete 注册）** — **已完成（2026-10-22 17:36）**。
   - 通过 `gui-plugin` 2.1.0 的显式 repair 队列在 GUI host 内执行；请求 `~/.dsh/astra-dsh/repair/cleanup-test-workspaces.json`，回执 `~/.dsh/astra-dsh/repair/cleanup-astra-dsh-test-workspaces-20261022.ack.json`。
   - 三项均 `ok: true`，各自 `archiveSession` 后 `delete(workspace.id)`；目录/session log 保留。清理后 `workspace.json` 只剩业务/当前任务 workspace，未触碰受保护任务。

## 4. 待安全维护窗口执行清单（已授权动作，非“等确认”）

1. ~~重装/重载 workspace-attach bundle~~ — 已由用户完成，heartbeat 2.0.0 / pid 25771 持续刷新；本任务不再重装。
2. 在 GUI host 内只读 `sessionController.list` 查 `82fa9a86-169a-44e5-a427-db781c3cc553`，向插件投递该 session 的 `existing` 请求（不改身份/不 resume），核对 ACK 与 GUI catalog 出现；仅发布已有 session 摘要，不新建测试会话/工作区。host ACK 不作为客户端渲染证据，客户端渲染需肉眼/GUI 侧确认。
3. 按第 2 节映射对三项测试工作区执行 `archiveSession`（不 `stopActivity`）→ `delete(workspace.id)`，保留目录/日志与映射记录；误含业务 session 则跳过。不归档本修复 session。本任务不执行。
4. 受保护任务 `T-20261022-114003-a947`（session `17514af0-…`）前后保持只读证据一致；其可见性仅可经插件只读摘要发布/同路径已有 workspace attach，不改其内容/锁/任务控制记录。

## 5. 恢复方法

- 误删 workspace 注册：GUI host 内 `workspaceRegistry.create('<目录绝对路径>')` 即可重建注册（幂等，按 canonical path 复用）。
- 误归档 session：`workspaceRegistry.unarchiveSession(sessionId)` 还原（归档只隐藏，不删 session log）。
- 测试工作区目录与 `~/.dsh/sessions/<…>` 日志均保留，未删除。

## 6. 结论（2026-10-22 更新）

- 插件加载状态**已更新**：用户回执 + 只读复核确认 workspace-attach `version 2.0.0`、`pid 25771` 心跳持续刷新；旧的“desktop 插件未加载新版”事实不再成立。
- 本任务 `T-20261022-160836-3996` 只修改桥源码/测试/文档，没有重装 GUI 插件、没有改 `gui-plugin/`、没有重启 Codex/DSH/GUI、没有触碰受保护业务任务。
- 三项旧测试工作区清理**已完成**（repair ACK `cleanup-astra-dsh-test-workspaces-20261022.ack.json`，2026-10-22T09:36:07Z）。
- 仍未验证的只剩**真实客户端渲染/肉眼可见性**；session 摘要与 workspace 注册已由 host API 核对，不能把 ACK 当作客户端渲染证据。

## 7. 本任务故障感知相关回执

- 已实现并测试：ACP 退出/断 stdout/EPIPE 及时 settle、部分输出与 incident 保留、失败/中断不自动执行排队写、持久通知 outbox 退避/跨重启/去重、桥 SIGKILL/stdio 关闭时 watchdog sidecar 向 dispatch 原 thread 告警且不释放可能活跃的锁、疑似停滞只警告不杀任务、无 thread/监督失败明确 degraded、模型选择失败 fail closed。
- 全部故障注入使用 mock ACP/Codex + 临时 workspace/DSH home；未对真实业务任务做故障注入。最终测试结果见交付回复。
- GUI 误投影分析：`8fa47077-…` 的“任务已停止”与同期 ACP 工具事件矛盾；宿主冷读会补 interrupted closer，follow 看不到外部 ACP 写入。详见 `docs/EXTERNAL_SESSION_GUI.md`。本任务未修改宿主/`gui-plugin/`，当前旧 bridge 未热加载，不能声称本回合已受新逻辑保护。

## 8. Turn 2 返工回执（2026-10-22）

- 已修复 Astra 独立验收发现的 8 项问题：onlyIds Array/Set finally、sidecar 有界重试、force 恢复证据、outbox claim fencing/续租、每 episode stall 通知、传输故障不自动 kill ACP、GUI 误投影分析、watchdog ready ACK/受控 env。
- 追加修复 P1：`WorkspaceStore.acquireLock` 对全 workspace 未解决 execution risk 形成写入口门禁；dead/expired/missing lock 均不能绕过。
- 最终 `node --test test/*.test.mjs`：**126/126 pass, 0 fail**（约 24s）；未重复跑多轮全量。
- 本轮未重启/停止任何现有 MCP/ACP/Codex/GUI 进程，未重装插件，未修改 `gui-plugin/` 或 DSH 宿主，未对真实业务任务做故障注入。


## 9. 2026-10-22 17:36 接手收尾回执

- `workspace-attach` 已从 2.0.0 重载到 **2.1.0**（heartbeat `version: 2.1.0`、pid 25771）。
- 三项测试工作区通过 host 内 repair 队列完成 `archiveSession` → `delete(workspace.id)`：
  - `.astra-gui-verify` → workspace `2ad3af86-…`，session `47ca8b79-…`
  - `.astra-attach-e2e` → workspace `13146b0d-…`，session `4e58e389-…`
  - `.astra-trigger-test` → workspace `39dc09aa-…`，session `15966851-…`
- 回执：`~/.dsh/astra-dsh/repair/cleanup-astra-dsh-test-workspaces-20261022.ack.json`，三项全部 `ok: true`。
- 清理后 `workspace.json` 保留 `/work`、`/work/NLAOP`、`/work/NLAOP运营`、受保护 `/Documents/Codex/...`、当前任务 `/work/astra-dsh-bridge`；未直接改 `workspace.json`，未删目录/session log。
- 受保护任务 `T-20261022-114003-a947` 与当前 bridge workspace `fe62c029-…` 未归档/未删除。
- 真实客户端渲染仍未验证；本回执只证明 host API 层注册/归档成功，不假报客户端可见。
