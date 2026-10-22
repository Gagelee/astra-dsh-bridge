# Host backend (B) — design and status

目标：GUI 可用时，由 GUI host 拥有并驱动 DSH session，获得原生 live transcript；GUI 不可用时保留 ACP。

## 已落地（2026-10-22）

- `host-plugin/` → `@astra-dsh/host-control` 0.1.0，已安装到 desktop profile。
- Unix socket：`~/.dsh/astra-dsh/host-control.sock`（0600）；状态：`host-control.json`。
- 方法：`health`、`create`、`prompt`、`cancel`、`status`、`workspaces`、`follow`。
- `src/host-client.mjs`：桥侧 NDJSON client + `probeHostControl`。
- `astra_status` 显示 `Execution backend` 与 host control 的版本/协议/可用性。
- 测试：`test/host-control.test.mjs`、`test/host-client.test.mjs`。

## 已接入（2026-10-22）

- `TaskRunner` 在 dispatch 时探测 host；`auto` 可用则走 host，不可用回退 ACP；`host` 强制、`acp` 强制。
- host 分支：`create`（session+model+prompt）→ `follow`（解析 snapshot/live `event` 包装、assistant/message、turn/end）→ 复用 verification/auto-review/result/outbox/lock。
- 同一 host session 的 follow-up（`dsh_message`）走 `prompt`，不新建 session。
- `dsh_cancel` 对 host 调 `cancel` 并 abort follow。
- 真实 GUI host smoke：`executionBackend=host`、`live=true`、`sessionId=session-*`、任务从 running → idle、result 含 `HOST_LIVE_OK`。

## 尚未完成 / 边界

- host 任务在 bridge 退出后的自动 reconcile 尚未实现；host session 可能仍在跑，任务会保持 running（与 ACP 的 owner-exited 路径不同）。这是下一步。
- host 权限沿用 GUI 的 DSH preset（`approval/policy=ask` 时可能需要 GUI 批准）；bridge 不能替用户批准。
- 真实客户端渲染/肉眼 live 仍需在 GUI 里确认；host API 层已证明 session 是 host-owned 且 follow 有事件。

## 接入约定

- 启动/每次 dispatch 探测 host control：
  - 连接 socket + `health`
  - 校验 `protocol`、`dshHome`、capabilities
  - 目标 workspace 可解析
- `auto`：host 可用 → `executionBackend=host`；否则 ACP。
- `host`：强制 host；不可用直接失败，不静默回退。
- `acp`：强制 ACP（headless/CI）。
- 任务记录 `executionBackend`、`live`、`hostVersion`、`hostPid`。
- host 中途退出：任务 incident + `codex queue` 通知；**不自动切 ACP**。
- host 在 dispatch 之后才启动：不 retro-attach；新任务才用 host。
- 多个 GUI/profile：health 的 `dshHome` 不匹配就视为不可用/冲突。

## 安全

- 只开 Unix socket，0600；不监听 TCP。
- 不修改 DSH 宿主内部文件；host control 只调用 `ctx.sessionController` / `ctx.workspaceRegistry`。
- host session 内执行仍受 DSH 自身的 permission 语义约束。
