---
name: astra-dsh
description: 当用户想把需求交给 Codex 中的 Astra 规划、查看 Astra/DSH 共享任务板、从 DSH 侧 pickup 或追踪需求、或需要确认某个 DSH 任务的真实结果时使用。DSH 负责执行，Astra 负责规划与验收；两边共享 <workspace>/.astra-dsh。
---

# 从 DSH 侧使用 Astra 任务板

Codex 中的 **Astra** 负责规划、拆解、派发和验收；DSH 负责执行。两边通过同一个本地目录协作：

```
<workspace>/.astra-dsh/
```

桥工具位于安装时打印的 `{{BRIDGE_DIR}}/`，CLI 为：

```bash
{{BRIDGE_DIR}}/bin/astra-dsh
```

如果用户已把它加入 PATH，可直接用 `astra-dsh`。

## 何时做什么

- 用户说“把这个需求交给 Astra / 交给 Codex / 让 Astra 规划一下”→ 创建 request，让 Astra pickup。
- 用户问“Astra 做到哪了 / DSH 任务什么状态 / 共享任务板有什么”→ 查看任务板。
- 用户直接让你（DSH）做某件事 → 正常执行即可；只有需要 Astra 参与规划/验收时才创建 request。
- **不要**手动编辑 `.astra-dsh/tasks/`、`task.json`、`result.md`、锁文件；这些由桥维护。创建需求用 CLI。

## 创建需求（交给 Astra）

先确定 `<workspace>` 是项目根目录的绝对路径（通常就是当前工作目录）。

```bash
{{BRIDGE_DIR}}/bin/astra-dsh request \
  --workspace "$PWD" \
  --title "支持 CSV 导出" \
  --body-file - <<'EOF'
需求：报告页支持 CSV 导出。
约束：UTF-8 BOM；文件名带日期；不新增依赖。
验收：点击导出能下载 CSV；BOM 存在；有测试。
EOF
```

也可以把需求正文写进文件：

```bash
astra-dsh request --workspace "$PWD" --title "..." --body-file ./requirement.md
```

命令会输出 `REQ-...`。告诉用户：

> 已写入共享任务板（REQ-...）。请在 Codex 里对 Astra 说“pickup 共享任务板里的需求”，它会读取并规划。

不要声称“已经通知 Astra”；桥不会主动唤醒 Codex。Astra 在下次对话/任务开始时通过 `astra_inbox` 读取。

## 查看任务板

```bash
astra-dsh inbox  --workspace "$PWD"          # 待处理需求
astra-dsh tasks  --workspace "$PWD"          # DSH 任务（含状态、改动文件数）
astra-dsh status --workspace "$PWD"          # 需求/任务/锁概览
astra-dsh show   --workspace "$PWD" REQ-...  # 需求全文与 Astra 计划
astra-dsh show   --workspace "$PWD" T-...    # 任务状态与结果
astra-dsh diff   --workspace "$PWD" --since T-...
```

任务状态含义：

| 状态 | 含义 |
|---|---|
| `running` | DSH 正在执行，工作区锁被 DSH 持有 |
| `idle` | 回合结束，等待 Astra 审阅 |
| `changes_requested` | Astra 要求返工 |
| `accepted` / `rejected` | Astra 已验收 / 拒绝（`accepted` 可能来自 auto 验证） |
| `failed` / `interrupted` | 执行失败 / 桥或进程中断；可继续会话 |
| `cancelled` | 被取消，会话保留 |

## 协作注意

- DSH 回合运行时不要编辑同一批文件；锁在 `astra-dsh status` 里可见。
- 任务包在 `tasks/<T-id>/task.md`，结果在 `result.md`，真实改动在共享目录；向用户汇报时引用真实文件，不要只复述任务描述。
- 任务包包含 Astra 的 `implementationPlan`。你的职责是按计划动手修改；可以在实现过程中进一步分析代码和边界条件、提出调整建议，但不要另做产品分析/优先级/路线图。计划有问题就用 `QUESTION:` 问 Astra。
- 任务包可能包含 `Verification commands`：桥会在回合结束后独立执行这些命令。你仍应先自行验证，但不要修改或删除 `verification.json`，它由桥维护。
- `accepted` 可能是 Astra 手动签收，也可能是 `auto` 模式在验证命令全部通过后自动签收；不要因此跳过自己回合内的验证。
- Codex 发起的执行会话会写入共享 `~/.dsh/sessions`，GUI 插件会自动把它挂到对应项目 workspace（不存在时先创建）；GUI 只用于查看，执行中的控制仍由 Codex/Astra 完成。
- 如果用户问的问题需要 Astra 决策，说明这属于 Astra 的职责，并建议在 Codex 中继续；或把补充信息写成新的 request。
- 不要删除 `.astra-dsh/`；它同时是 Astra 的审阅依据。
