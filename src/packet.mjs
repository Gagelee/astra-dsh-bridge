/**
 * Task packet and prompt rendering. The packet is the durable handoff artifact
 * Astra writes; the prompt is the ACP user message DSH receives. They are
 * intentionally close so what Astra reviews in `.astra-dsh` is what DSH saw.
 */

import { oneLine } from './util.mjs'

/** Normalize flexible list entries to `- text` bullets. */
function bullets(items, empty = '_(none specified)_') {
  if (!Array.isArray(items) || items.length === 0) return empty
  return items
    .map((item) => {
      if (item === null || item === undefined) return ''
      if (typeof item === 'string') return `- ${item}`
      if (typeof item === 'object') {
        if (item.path) {
          return `- \`${item.path}\`${item.note ? ` — ${item.note}` : ''}`
        }
        const text = item.text ?? item.note ?? item.description ?? JSON.stringify(item)
        return `- ${text}`
      }
      return `- ${String(item)}`
    })
    .filter(Boolean)
    .join('\n')
}

/** Render the durable task packet handed from Astra to DSH. */
export function renderTaskPacket({
  title,
  goal,
  context,
  files,
  constraints,
  acceptance,
  deliverables,
  outOfScope,
  notes,
  requestId,
  writeScopes,
  verifyCommands,
  workspace,
  createdBy = 'Astra (Codex planner)',
}) {
  const scopes = Array.isArray(writeScopes) && writeScopes.length > 0
    ? writeScopes.map((scope) => `- \`${scope}\``).join('\n')
    : '- _(whole workspace; keep changes scoped to the task)_'

  return `# ${title}

- **Task owner:** DSH (execution agent)
- **Planner:** ${createdBy}
- **Shared workspace:** \`${workspace}\`
- **Parent request:** ${requestId ? `\`${requestId}\`` : '_none_'}
- **Write scopes:**\n${scopes}

## Goal

${goal}

## Context and decisions

${context || '_No additional context was supplied._'}

## Relevant files

${bullets(files)}

## Constraints

${bullets(constraints)}

## Acceptance criteria

${bullets(acceptance, '- The requested change is implemented and verifiable in the shared workspace.')}

## Deliverables

${bullets(deliverables)}

## Verification commands

${bullets(verifyCommands, '_None supplied. Astra will verify manually._')}

## Out of scope

${bullets(outOfScope)}

## Additional notes

${notes || '_None._'}

---

## Reporting contract

End every turn with a concise factual report containing:

1. **Status** — done, partial, blocked, or needs a decision.
2. **Changes** — files created/modified/deleted.
3. **Verification** — commands run and their results.
4. **Open questions** — each on its own line prefixed with \`QUESTION:\` when you need Astra to decide.
5. **Risks / follow-ups** — anything the planner must know before the next task.

Do not claim work you did not verify. Do not commit, reset, rebase, or switch
branches unless this packet explicitly asks for it.
`
}

/** Render the ACP prompt that starts or continues a DSH turn. */
export function renderExecutionPrompt({ task, packet, message }) {
  const header = `# DSH task ${task.id} — ${task.title}

You are **DSH**, the execution agent in a two-agent workflow. **Astra** is the planner working in Codex. You share one local workspace with Astra, so every file you change is immediately reviewable by the planner.

## Coordination rules

- Work only inside the shared workspace: \`${task.workspace}\`.
- Do not edit files under \`.astra-dsh/\` — that is the bridge's control plane.
- Do not commit, reset, rebase, or switch branches unless the task packet explicitly asks.
- If you need a decision, stop and ask. Put every question on its own line starting with \`QUESTION:\`.
- Prefer small, verifiable steps and report the exact commands you ran.
- When done, end with the reporting contract from the task packet.

## Task identity

- Task: \`${task.id}\`
- Title: ${task.title}
- Durable task packet: \`.astra-dsh/tasks/${task.id}/task.md\`
- Turn: ${task.turnIndex + 1}

## Task packet (authoritative handoff)

${packet}
`
  if (!message) return header
  return `${header}\n---\n\n## Astra's follow-up for this turn\n\n${message}\n`
}

/** Render a human-readable result artifact for the latest settled turn. */
export function renderResultArtifact({ task, changes, questions = [], turnResult = '', verification = null, autoReview = null }) {
  const changed = Array.isArray(changes?.changedFiles) && changes.changedFiles.length > 0
    ? changes.changedFiles
      .map((entry) => `- \`${entry.path}\` (${entry.code}${entry.preexisting ? ', pre-existing dirty' : ''})`)
      .join('\n')
    : '- _No file changes detected._'
  const questionsBlock = questions.length > 0
    ? questions.map((question) => `- ${question}`).join('\n')
    : '- _None._'
  return `# DSH result — ${task.title}

- **Task:** \`${task.id}\`
- **State:** ${task.state}
- **Turn:** ${task.turnIndex}
- **Stop reason:** ${task.stopReason ?? 'n/a'}
- **Session:** \`${task.sessionId ?? 'n/a'}\`
- **Updated:** ${task.updatedAt}

## Final message

${turnResult || task.finalText || '_No assistant message was produced._'}

## Files changed

${changed}

## Diff stat

\`\`\`
${changes?.diffStat || '(none)'}
\`\`\`

## Verification

${renderVerification(verification)}

## Review mode

- **Mode:** ${task.reviewMode ?? 'light'}
${autoReview ? `- **Automatic review eligible:** ${autoReview.eligible ? 'yes' : 'no'}\n${autoReview.reasons?.length ? autoReview.reasons.map((reason) => `- ${reason}`).join('\n') : ''}` : ''}

## Questions for Astra

${questionsBlock}

## Notes

- Permission decisions: ${task.permissionDecisions?.length ?? 0}
- Workspace lock: ${task.lockReleased === false ? 'held by DSH' : 'released after the turn'}
`
}

/** Render bridge-run verification checks. */
function renderVerification(verification) {
  if (!verification) return '_No verification commands were configured._'
  if (!Array.isArray(verification.checks) || verification.checks.length === 0) return '_No checks ran._'
  return verification.checks.map((check) => {
    const icon = check.code === 0 && !check.timedOut ? '✅' : '❌'
    const detail = check.timedOut ? 'timed out' : `exit ${check.code}`
    return `- ${icon} \`${check.command}\` — ${detail}, ${check.durationMs}ms`
  }).join('\n')
}

/** Extract `QUESTION:` lines from DSH output. */
export function extractQuestions(text) {
  const questions = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(?:QUESTION|Question|question)\s*:\s*(.+)$/.exec(line)
    if (match) questions.push(match[1].trim())
  }
  return questions
}

/** One-line task summary used by list/status tools. */
export function summarizeTask(task) {
  return `${task.id} [${task.state}] ${oneLine(task.title, 100)}${task.sessionId ? ` · session ${task.sessionId.slice(0, 8)}` : ''}`
}
