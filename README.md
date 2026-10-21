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

Astra 会调用 `dsh_dispatch`，随后用 `dsh_wait` / `dsh_result` 审阅，再决定 `dsh_review` 或继续 `dsh_message`。

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
│   └── turns/<NNN>/      # 每回合的 prompt / result
├── locks/workspace.lock/ # 单写者锁
└── logs/                 # ACP stderr 与诊断日志
```

`git` 仓库会把 `.astra-dsh/` 追加到 `.git/info/exclude`，不会污染 `git status`，也不会改受版本控制的 `.gitignore`。

## 协作协议

### 1. 任务包（Astra → DSH）

`dsh_dispatch` 的字段构成任务包，至少包含 `goal` 与一条 `acceptance`：

| 字段 | 作用 |
|---|---|
| `title` | 任务标题 |
| `goal` | 要达成的结果 |
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
| `model` / `reasoningEffort` | 本次任务使用的 DSH 模型与推理档位 |

任务包原样落盘为 `task.md`，并注入 DSH 的第一条 prompt。DSH 不需要继承 Astra 的内部推理，但能拿到执行所需的完整事实。

### 2. 回合与持久会话

- 一个任务对应一个 DSH ACP 会话，跨回合、跨桥重启持久化。
- `dsh_wait` 阻塞到当前回合结束；`dsh_status` 随时看进度；`dsh_result` 读完整报告。
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
| `full` | Astra | 同 `light`，但按完整验收流程人工审阅 | 高风险、跨模块、需求有歧义 |

`auto` 的硬性条件：

- `stopReason` 必须是 `end_turn`，任务不能是 failed/cancelled/interrupted
- DSH 没有提出 `QUESTION:`，没有排队中的追加指令
- 至少一条 `verifyCommands`，且全部 exit 0、未超时
- 有文件改动时必须声明 `writeScopes`，且所有改动都在声明的路径内

任一条件不满足，任务保持 `idle`，`autoReview.reasons` 写明原因，交给 Astra 审阅。**`auto` 不是“盲信 DSH”，而是“盲信桥独立执行的验证命令”**；`verifyCommands` 由 Astra 设计，执行结果与 stdout/stderr 都落盘。

命令在共享工作目录执行，属于受信输入；不要接受用户提供的任意命令。它们不会修改 DSH 的会话，也不替代 Astra 对高风险改动的判断。

### 4.1 交接前的评估

默认 `light`，不要每个任务都 `full`。Astra 在派发前先判断：

**必须 Astra 亲自验收（`full`）**

- 认证、权限、密钥、安全边界
- 数据迁移、删除、不可逆操作
- 公共 API、跨模块契约、架构调整
- 用户可见的交互、设计、文案
- 没有可靠自动化验证，或需求本身有歧义
- 改动跨服务、跨仓库，或预计越出 `writeScopes`

**可以交给 DSH/桥（`auto`）**

- 格式化、注释、文档
- 局部 bug fix，且已有测试覆盖
- 机械替换、生成代码、重命名
- 配置/脚本改动，且能用命令验证
- 只改测试

**默认 `light`**

- 局部、低风险、diff 可读，验收标准能用文件/diff 核对
- 桥跑 `verifyCommands`，Astra 只看 diff + 关键文件，不重跑全量测试

如果任务一开始判断为 `light`，执行中发现命中风险清单（改动越界、测试失败、DSH 提问、跨模块），再升级到 `full`。

### 4.2 等待与额度

- `dsh_wait` 是**阻塞的工具调用**。等待本身不产生模型 token；但每次超时返回都会开启一轮新的 Astra 思考，反复 wait/status 才会烧额度。
- 预计 5 分钟内完成的任务：一次 `dsh_wait` 180–300 秒即可。
- 预计更长的任务：`dsh_dispatch` 后先结束回合，告诉用户“DSH 在跑”；用户回来或隔一段时间再 `dsh_status` 一次。不要循环 wait。
- 桥在回合结束后**主动**跑 `verifyCommands`，这是本地进程执行，不消耗模型额度；`auto` 模式还会直接签收，省掉一轮 Astra 验收。
- DSH 不能主动唤醒 Codex。MCP 是拉取模型：DSH 写任务板，Astra 在下次工具调用时读取。需要“完成提醒”时，用 macOS 本地通知/终端提醒，而不是让 Astra 轮询。

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

Codex 发起的任务现在会出现在 DSH GUI 的会话列表里：

- 会话写入 `~/.dsh/sessions/<编码后的工作目录>/<session-id>/`
- 标题取任务 prompt 的首行，已带任务 ID 和标题
- 桥在创建 ACP 会话后会把 `{workspace, sessionId}` 写入 `~/.dsh/astra-dsh/attach/`
- 已安装的 GUI 插件 `@astra-dsh/workspace-attach` 会轮询这个队列，在 GUI 进程内调用 `workspaceRegistry.resolveByPath/create` 和 `workspace.attachSession`
- 如果该 workspace 还没在 DSH 里注册，插件会先创建它；因此会话会自动归到项目分组下
- 它是 DSH 执行会话的持久化记录：可以查看 transcript，但**不要在执行中从 GUI 向它发消息**；控制面仍然是 Codex/Astra
- 如果 GUI 里没出现，检查 `astra_status` 的 `dshHome`/`attachQueueDir` 是否为 `~/.dsh`，以及 Codex 配置里的 `writable_roots`

## 用户旅程

### light（默认）/ full

1. 用户在 Codex 说“把这个需求交给 DSH”。
2. Astra 读项目、拆任务，调用 `dsh_dispatch`（`reviewMode` 默认 `light`）。
3. 桥写 `task.md`、加锁、打开/恢复 DSH 会话、把任务包作为 prompt 发出，立即返回 `taskId`。
4. Astra 调 `dsh_wait` 阻塞等待；期间可 `dsh_status` 看工具调用与进度。
5. 回合结束，Astra 调 `dsh_result`，再用 `dsh_diff` / `dsh_read_file`（或自己的 shell/测试）核对真实改动。
6. 通过则 `dsh_review accepted`；不通过则 `changes_requested` + `dsh_message`/`continueTask` 返工，再回到第 4 步。
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
| `dsh_dispatch` | 创建任务包并启动 DSH 回合 |
| `dsh_list` / `dsh_status` / `dsh_wait` | 任务列表、进度、阻塞等待 |
| `dsh_message` / `dsh_cancel` | 追加指令/回答问题/打断/停止 |
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
| `ASTRA_DSH_MODEL` | `deepseek-v4-pro` | 默认执行模型 |
| `ASTRA_DSH_MODEL_PROVIDER` | `deepseek-official` | 模型提供方 |
| `ASTRA_DSH_EFFORT` | `high` | `off/low/high/max` |
| `ASTRA_DSH_PERMISSION_MODE` | `workspace-write` | DSH 自身沙箱 |
| `ASTRA_DSH_PERMISSION_POLICY` | `allow` | ACP 权限升级请求：`allow` 保持无人值守执行；`reject` 失败关闭 |
| `ASTRA_DSH_WAIT_MAX_SEC` | `300` | `dsh_wait` 上限 |
| `ASTRA_DSH_LOCK_TTL_MS` | 2h | DSH 回合锁租期 |
| `ASTRA_DSH_VERIFY_TIMEOUT_MS` | `120000` | 每条 `verifyCommands` 的超时 |

`ASTRA_DSH_PERMISSION_POLICY=allow` 只决定 ACP 权限请求的自动应答；DSH 的 `workspace-write` 沙箱仍然生效。若本机沙箱后端不可用（例如嵌套沙箱环境），DSH 可能请求升级；此时 `allow` 会让它继续，`reject` 会让它失败关闭。

## 常见问题

**DSH 报 sandbox 不可用。** 这是 DSH 自身的文件沙箱后端问题（macOS `sandbox-exec`、Linux bubblewrap/Landlock）。从普通 Codex 进程启动时通常可用；若仍不可用，可把 `ASTRA_DSH_PERMISSION_MODE` 设为 `danger-full-access`（不推荐），或保持 `allow` 让 DSH 在每次升级时请求一次性权限。Codex 自身的 sandbox 仍然约束最终可写范围。

**共享 `~/.dsh` 与 GUI 可见性。** 安装脚本把 `ASTRA_DSH_DSH_HOME` 指向 `~/.dsh`，并把 `~/.dsh` 加入 Codex 的 `sandbox_workspace_write.writable_roots`。这样 Codex 发起的 DSH 会话会写入 `~/.dsh/sessions`，DSH GUI 刷新后就能看到对应会话。

如果 Codex 沙箱仍然拒绝写 `~/.dsh`，桥会自动回退到 `<workspace>/.astra-dsh/dsh-home`，任务继续可用，但这些会话不会出现在 GUI 里，也不会写 attach 队列；`astra_status` 会显示 fallback 原因。凭证在共享模式下直接读取 `~/.dsh/.credentials.yaml`，回退模式下用符号链接，不复制密钥。

安全边界：`writable_roots` 让 Codex 的 MCP server 可以写整个 `~/.dsh`（包括会话、profile、日志）。这是为了 GUI 可见性做的取舍；如果你只想让桥写会话，可把 `writable_roots` 收窄到 `~/.dsh/sessions`、`~/.dsh/storages`、`~/.dsh/profiles`、`~/.dsh/logs` 等子目录。

**会话无法 resume。** ACP 的 resume 要求同一 `DSH_HOME`、同一工作目录、非子会话。桥会自动降级为新建会话，并在 `task.json` 里记录 `sessionRecreated: true`；任务包仍在，不会丢上下文。

**Codex 看不到工具。** 确认 `codex mcp list` 中出现 `astra_dsh`，并重启 Codex。`astra_status` 能返回诊断信息。

**Codex 能派发但自己读不了文件。** 如果 Codex 的 shell 被本机 sandbox 拦截，用 `dsh_read_file` 读取真实文件；桥进程与 Codex 同处工作区沙箱，读工作区文件是允许的。

**工具调用被 Codex 要求审批。** 安装脚本在 `[mcp_servers.astra_dsh]` 上设置了 `default_tools_approval_mode = "approve"`。若你的 Codex 版本不接受该字段，改为在 Codex 设置中允许该 MCP server 的工具。

## 测试

```bash
node --test test/*.test.mjs     # 单元 + mock ACP 集成（不消耗模型额度）
ASTRA_DSH_DSH_HOME=$HOME/.dsh node scripts/real-e2e.mjs /tmp/some-workspace
```

真实端到端测试会启动 `dsh acp`、创建一个文件并回传结果。
