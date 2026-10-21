/**
 * MCP tool surface for Codex/Astra. Every tool is workspace-scoped; the
 * workspace path is the shared project directory that Codex and DSH both see.
 */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { loadConfig } from './config.mjs'
import { WorkspaceStore } from './store.mjs'
import { TaskRunner } from './task-runner.mjs'
import { BridgeError, nowIso, oneLine, resolveWorkspace, truncate } from './util.mjs'

const WORKSPACE = {
  type: 'string',
  description: 'Absolute path to the shared project directory (the Codex working directory).',
}

const TASK_ID = { type: 'string', description: 'Task id returned by dsh_dispatch, e.g. T-20261021-151230-a1b2.' }

/** Owns one store + runner per workspace for the life of the MCP process. */
export class Bridge {
  constructor(config = loadConfig()) {
    this.config = config
    this.workspaces = new Map()
  }

  forWorkspace(workspaceInput) {
    const workspace = resolveWorkspace(workspaceInput)
    let entry = this.workspaces.get(workspace)
    if (!entry) {
      const store = new WorkspaceStore(workspace)
      const runner = new TaskRunner({ store, config: this.config })
      entry = { store, runner }
      this.workspaces.set(workspace, entry)
    }
    return entry
  }

  async close() {
    for (const entry of this.workspaces.values()) {
      await entry.runner.shutdown()
    }
    this.workspaces.clear()
  }
}

/** Tool definitions in MCP `tools/list` shape. */
export const TOOL_DEFINITIONS = [
  {
    name: 'astra_inbox',
    description:
      'Pick up shared work in this workspace. Lists requirements dropped by DSH (or Codex) and DSH tasks awaiting Astra review. Call this first when starting a planning turn or when the user says work is waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        includeClosed: { type: 'boolean', description: 'Include accepted/rejected tasks and done requests.' },
      },
      required: ['workspace'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'astra_request_read',
    description: 'Read one requirement/request from the shared board, including its full body and Astra plan.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        requestId: { type: 'string', description: 'Request id, e.g. REQ-20261021-151230-a1b2.' },
      },
      required: ['workspace', 'requestId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'astra_request_create',
    description:
      'Create a requirement on the shared board. Use when Codex receives a new user requirement that should be planned before execution; DSH can also create requests from its side.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        title: { type: 'string' },
        body: { type: 'string', description: 'Full requirement text, constraints, and any known context.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        origin: { type: 'string', enum: ['codex', 'dsh', 'user'] },
      },
      required: ['workspace', 'title', 'body'],
    },
  },
  {
    name: 'astra_request_claim',
    description:
      'Claim an open requirement for planning and optionally save the plan. Claim before decomposing it into DSH tasks so the request is not picked up twice.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        requestId: { type: 'string' },
        planMarkdown: { type: 'string', description: 'Optional planning notes or task breakdown.' },
        note: { type: 'string' },
      },
      required: ['workspace', 'requestId'],
    },
  },
  {
    name: 'astra_lock',
    description:
      'Coordinate writes to the shared workspace. Acquire before Astra edits files, release before dispatching DSH. While DSH is running it holds the lock and dsh_dispatch will refuse to start a second writer. status is always safe.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        action: { type: 'string', enum: ['acquire', 'release', 'status'] },
        note: { type: 'string', description: 'Why Astra is writing, so DSH status shows it.' },
        ttlMinutes: { type: 'number', description: 'Lock lifetime for Astra writes (default 45).' },
      },
      required: ['workspace', 'action'],
    },
  },
  {
    name: 'dsh_dispatch',
    description:
      'Hand one fully specified task to DSH. Writes the durable task packet, opens a persistent DSH session, and starts execution in the shared workspace. Returns immediately with a task id; use dsh_wait or dsh_status afterwards. The packet must include goal and acceptance criteria so DSH does not need to re-ask for context. reviewMode defaults to light: Astra reviews the diff and targeted evidence rather than re-running everything. Use auto with verifyCommands for deterministic low-risk work, and full only for high-risk or ambiguous work.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        title: { type: 'string', description: 'Short task title.' },
        goal: { type: 'string', description: 'One-paragraph definition of the outcome DSH must produce.' },
        context: {
          type: 'string',
          description: 'Background, prior decisions, user constraints, and project understanding DSH needs. Write it as markdown.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relevant file paths with a short note each, e.g. "src/app.ts — entry point".',
        },
        constraints: { type: 'array', items: { type: 'string' } },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: 'Verifiable acceptance criteria. At least one is required.',
          minItems: 1,
        },
        deliverables: { type: 'array', items: { type: 'string' } },
        outOfScope: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string', description: 'Extra markdown appended to the packet.' },
        requestId: { type: 'string', description: 'Parent request id when this task comes from the shared board.' },
        writeScopes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace-relative paths DSH is expected to touch; used for overlap warnings.',
        },
        model: { type: 'string', description: 'Optional DSH model id, e.g. deepseek-v4-pro or deepseek-v4-flash.' },
        reasoningEffort: { type: 'string', enum: ['off', 'low', 'high', 'max'] },
        reviewMode: {
          type: 'string',
          enum: ['auto', 'light', 'full'],
          description:
            'Acceptance tier. auto: bridge runs verifyCommands and auto-accepts only if every check passes, no questions, and changes stay inside writeScopes. light: bridge runs verification, Astra reviews diff/files but not a full acceptance pass. full: Astra performs the full acceptance review (default). auto requires verifyCommands.',
        },
        verifyCommands: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string' },
          description:
            'Shell commands the bridge runs after each turn (max 5, 120s each) as independent evidence. They run in the workspace; they are not DSH self-reports. Example: ["npm test -- --runInBand"].',
        },
      },
      required: ['workspace', 'title', 'goal', 'acceptance'],
    },
  },
  {
    name: 'dsh_list',
    description: 'List DSH tasks in the shared workspace with state, turn count, and changed-file counts.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        state: {
          type: 'string',
          enum: ['running', 'idle', 'failed', 'interrupted', 'cancelled', 'accepted', 'changes_requested', 'rejected'],
        },
      },
      required: ['workspace'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dsh_status',
    description:
      'Read live progress for one DSH task: state, phase, current tool, recent events, questions, usage, changed files, and workspace lock. Safe to call repeatedly while DSH works.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        taskId: TASK_ID,
        events: { type: 'number', minimum: 0, maximum: 100, description: 'Number of recent events to include (default 25).' },
      },
      required: ['workspace', 'taskId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dsh_wait',
    description:
      'Block until the current DSH turn settles (idle/failed/cancelled/interrupted) or the timeout expires, then return status plus final text. Prefer this over tight polling after dsh_dispatch.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        taskId: TASK_ID,
        timeoutSec: { type: 'number', minimum: 1, maximum: 300, description: 'Maximum block time (default 120).' },
      },
      required: ['workspace', 'taskId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dsh_message',
    description:
      'Send Astra follow-up to a DSH task: answer a QUESTION:, request changes, add constraints, or start the next turn after review. If DSH is running, mode=queue (default) delivers it immediately after the current turn; mode=interrupt cancels the current turn first. If DSH is idle, it starts a new turn on the same persistent session.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        taskId: TASK_ID,
        message: { type: 'string' },
        mode: { type: 'string', enum: ['queue', 'interrupt'] },
      },
      required: ['workspace', 'taskId', 'message'],
    },
  },
  {
    name: 'dsh_cancel',
    description: 'Stop the current DSH turn and clear queued instructions. The session log is preserved and can be resumed later with dsh_message.',
    inputSchema: {
      type: 'object',
      properties: { workspace: WORKSPACE, taskId: TASK_ID },
      required: ['workspace', 'taskId'],
    },
  },
  {
    name: 'dsh_result',
    description:
      'Read the full result of a settled DSH turn: final report, extracted questions, changed files, diff stat, and optionally the diff. Use this to review real changes in the shared workspace before accepting.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        taskId: TASK_ID,
        includeDiff: { type: 'boolean', description: 'Include the captured diff (default false).' },
      },
      required: ['workspace', 'taskId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dsh_review',
    description:
      'Record Astra review of a DSH task in the shared board: accepted, changes_requested, or rejected. Use changes_requested with notes and continueTask=true to send rework instructions immediately. Acceptance does not merge anything: Astra is responsible for final verification.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        taskId: TASK_ID,
        decision: { type: 'string', enum: ['accepted', 'changes_requested', 'rejected'] },
        notes: { type: 'string', description: 'Review findings and concrete rework instructions.' },
        continueTask: { type: 'boolean', description: 'For changes_requested, send notes to DSH as a new turn.' },
      },
      required: ['workspace', 'taskId', 'decision'],
    },
  },
  {
    name: 'dsh_diff',
    description:
      'Show current workspace changes, optionally relative to a task baseline. Useful for reviewing uncommitted work that DSH produced and for spotting files changed outside the task.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        sinceTaskId: { type: 'string', description: 'Use this task baseline; omit for the full working-tree diff.' },
        maxBytes: { type: 'number', minimum: 1000, maximum: 500000 },
      },
      required: ['workspace'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'dsh_read_file',
    description:
      'Read the exact bytes of one file from the shared workspace through the bridge, and return its sha256/size. Use this to verify DSH output when Codex\'s own shell is sandbox-blocked; do not accept work based only on DSH\'s report.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: WORKSPACE,
        path: { type: 'string', description: 'Workspace-relative path (or an absolute path inside the workspace).' },
        maxBytes: { type: 'number', minimum: 1, maximum: 200000, description: 'Maximum bytes to return (default 60000).' },
      },
      required: ['workspace', 'path'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'astra_status',
    description:
      'Bridge diagnostics: DSH binary/home/model, active ACP process, workspace writer lock, request/task counts, and board location. Use when tools misbehave or before a long planning run.',
    inputSchema: {
      type: 'object',
      properties: { workspace: WORKSPACE },
    },
    annotations: { readOnlyHint: true },
  },
]

/** Dispatch one MCP tools/call. Returns `{ text, structured, isError }`. */
export async function callTool(name, args, bridge, { signal } = {}) {
  const input = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'astra_inbox':
      return astraInbox(bridge, input)
    case 'astra_request_read':
      return requestRead(bridge, input)
    case 'astra_request_create':
      return requestCreate(bridge, input)
    case 'astra_request_claim':
      return requestClaim(bridge, input)
    case 'astra_lock':
      return astraLock(bridge, input)
    case 'dsh_dispatch':
      return dshDispatch(bridge, input)
    case 'dsh_list':
      return dshList(bridge, input)
    case 'dsh_status':
      return dshStatus(bridge, input)
    case 'dsh_wait':
      return dshWait(bridge, input, signal)
    case 'dsh_message':
      return dshMessage(bridge, input)
    case 'dsh_cancel':
      return dshCancel(bridge, input)
    case 'dsh_result':
      return dshResult(bridge, input)
    case 'dsh_review':
      return dshReview(bridge, input)
    case 'dsh_diff':
      return dshDiff(bridge, input)
    case 'dsh_read_file':
      return dshReadFile(bridge, input)
    case 'astra_status':
      return astraStatus(bridge, input)
    default:
      throw new BridgeError(`unknown tool: ${name}`, { code: 'UNKNOWN_TOOL' })
  }
}

// ------------------------------------------------------------------- tools

function astraInbox(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const requests = store.listRequests().filter((request) => input.includeClosed || !['done', 'rejected'].includes(request.state))
  const tasks = runner.list().map((task) => {
    try {
      const full = store.loadTask(task.taskId)
      const questions = full.state !== 'running' && full.finalText
        ? (String(full.finalText).match(/^\s*QUESTION\s*:/gim) ?? []).length
        : 0
      return { ...task, questionCount: questions }
    } catch {
      return { ...task, questionCount: 0 }
    }
  })
  const awaiting = tasks.filter((task) => task.awaitingAstra)
  const running = tasks.filter((task) => task.state === 'running')
  const closed = input.includeClosed ? tasks.filter((task) => ['accepted', 'rejected'].includes(task.state)) : []
  const lines = [`# Shared board — ${store.workspace}`, '']
  lines.push(`## Requirements (${requests.length})`)
  lines.push(requests.length ? requests.map((request) => `- \`${request.id}\` [${request.state}/${request.priority}] ${request.title} — origin ${request.origin}`).join('\n') : '_No open requirements._')
  lines.push('', `## Awaiting Astra review (${awaiting.length})`)
  lines.push(awaiting.length ? awaiting.map((task) => {
    const verified = task.verificationOk === null ? 'verify n/a' : task.verificationOk ? 'verify pass' : 'verify FAIL'
    const reasons = task.autoReview?.reasons?.length ? ` · auto blocked: ${oneLine(task.autoReview.reasons.join('; '), 180)}` : ''
    return `- \`${task.taskId}\` ${task.state} — ${task.title} · ${task.reviewMode} · ${verified}${task.questionCount ? ` · ${task.questionCount} question(s)` : ''}${reasons}`
  }).join('\n') : '_None._')
  lines.push('', `## Running (${running.length})`)
  lines.push(running.length ? running.map((task) => `- \`${task.taskId}\` ${task.title}`).join('\n') : '_None._')
  if (closed.length) {
    lines.push('', `## Closed (${closed.length})`)
    lines.push(closed.map((task) => `- \`${task.taskId}\` ${task.state} — ${task.title}`).join('\n'))
  }
  lines.push('', `Board: \`${store.root}\``)
  return {
    text: lines.join('\n'),
    structured: {
      workspace: store.workspace,
      board: store.root,
      requests,
      tasksAwaitingAstra: awaiting,
      runningTasks: running,
      closedTasks: closed,
    },
  }
}

function requestRead(bridge, input) {
  const { store } = bridge.forWorkspace(input.workspace)
  const request = store.loadRequest(requireString(input.requestId, 'requestId'))
  const text = `# ${request.title}\n\n- **Request:** \`${request.id}\`\n- **State:** ${request.state}\n- **Origin:** ${request.origin} · priority ${request.priority}\n- **Created:** ${request.createdAt}\n- **Claimed by:** ${request.claimedBy ?? '—'}\n\n## Requirement\n\n${request.body || '_empty_'}\n\n## Astra plan\n\n${request.plan || '_not planned yet_'}\n`
  return { text, structured: request }
}

function requestCreate(bridge, input) {
  const { store } = bridge.forWorkspace(input.workspace)
  const request = store.createRequest({
    title: requireString(input.title, 'title'),
    body: requireString(input.body, 'body'),
    origin: input.origin ?? 'codex',
    priority: input.priority ?? 'normal',
  })
  return {
    text: `Created request \`${request.id}\` (${request.title}). It is now visible to both Codex/Astra and DSH in \`${store.root}/requests\`.`,
    structured: request,
  }
}

function requestClaim(bridge, input) {
  const { store } = bridge.forWorkspace(input.workspace)
  const request = store.loadRequest(requireString(input.requestId, 'requestId'))
  if (request.state === 'done') {
    throw new BridgeError(`request ${request.id} is already done`, { code: 'REQUEST_DONE' })
  }
  request.state = 'planned'
  request.claimedBy = 'astra'
  request.claimedAt = nowIso()
  request.note = input.note ?? request.note
  if (input.planMarkdown) store.writeRequestPlan(request, String(input.planMarkdown))
  store.saveRequest(request)
  return {
    text: `Claimed \`${request.id}\` for planning. Plan file: \`${join(store.requestDir(request.id), 'plan.md')}\`.`,
    structured: request,
  }
}

function astraLock(bridge, input) {
  const { store } = bridge.forWorkspace(input.workspace)
  const action = requireString(input.action, 'action')
  if (action === 'status') {
    return { text: `${renderLock(store.inspectLock())}\n\nBoard: \`${store.root}\``, structured: { lock: store.inspectLock() } }
  }
  if (action === 'release') {
    const current = store.inspectLock()
    if (!current) return { text: 'Workspace lock already free.', structured: { lock: null } }
    if (current.owner !== 'astra') {
      throw new BridgeError(`cannot release: workspace is locked by ${current.owner}${current.taskId ? ` (${current.taskId})` : ''}`, {
        code: 'LOCK_NOT_OWNER',
        details: current,
      })
    }
    store.releaseLock()
    return { text: 'Released Astra workspace lock.', structured: { lock: null } }
  }
  if (action !== 'acquire') throw new BridgeError(`unknown lock action: ${action}`, { code: 'BAD_ACTION' })

  const ttlMinutes = Number(input.ttlMinutes ?? 45)
  const current = store.inspectLock()
  if (current?.owner === 'astra') {
    // Idempotent re-acquire: refresh the lease by replacing our own record.
    store.releaseLock()
  }
  const lock = store.acquireLock({
    owner: 'astra',
    taskId: null,
    ttlMs: Math.max(5, ttlMinutes) * 60_000,
    note: input.note ?? 'Astra editing files',
  })
  return {
    text: `Acquired Astra write lock for ${ttlMinutes} minutes. Release it with astra_lock action=release before dsh_dispatch.\n\n${renderLock(lock)}`,
    structured: { lock },
  }
}

async function dshDispatch(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const task = await runner.dispatch(input)
  if (input.requestId) {
    try {
      const request = store.loadRequest(input.requestId)
      request.state = 'in_progress'
      request.linkedTasks = [...new Set([...(request.linkedTasks ?? []), task.taskId])]
      store.saveRequest(request)
    } catch {
      // A dangling request id must not hide a successfully started task.
    }
  }
  return {
    text: `# DSH task started\n\n- **Task:** \`${task.taskId}\`\n- **State:** ${task.state}\n- **Session:** \`${task.sessionId}\`\n- **Packet:** \`${task.taskFile}\`\n\nDSH is now working in the shared workspace. Use \`dsh_wait\` (recommended) or \`dsh_status\` with this task id.`,
    structured: task,
  }
}

function dshList(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const tasks = runner.list({ state: input.state })
  const text = tasks.length
    ? [`# DSH tasks — ${store.workspace}`, '', ...tasks.map((task) => `- \`${task.taskId}\` [${task.state}] ${task.title}${task.awaitingAstra ? ' ← awaiting Astra' : ''} · ${task.reviewMode} · ${task.verificationOk === null ? 'verify n/a' : task.verificationOk ? 'verify pass' : 'verify FAIL'} · ${task.changedFileCount} file(s) changed · turn ${task.turn}`)].join('\n')
    : `No DSH tasks in \`${store.workspace}\`.`
  return { text, structured: { workspace: store.workspace, tasks } }
}

function dshStatus(bridge, input) {
  const { runner } = bridge.forWorkspace(input.workspace)
  const payload = runner.status(requireString(input.taskId, 'taskId'), { events: Number(input.events ?? 25) })
  return { text: renderStatus(payload), structured: payload }
}

async function dshWait(bridge, input, signal) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const config = bridge.config
  const timeoutSec = Math.min(Number(input.timeoutSec ?? 120), config.waitMaxSec)
  const payload = await runner.wait(requireString(input.taskId, 'taskId'), timeoutSec * 1000, signal)
  const prefix = payload.timedOut
    ? `_Still running after ${timeoutSec}s — this is a progress snapshot, not a final result._`
    : `_DSH turn settled (${payload.state})._`
  return {
    text: `${prefix}\n\n${renderStatus(payload)}\n\nBoard: \`${store.root}\``,
    structured: payload,
  }
}

function dshMessage(bridge, input) {
  const { runner } = bridge.forWorkspace(input.workspace)
  return runner.message(requireString(input.taskId, 'taskId'), requireString(input.message, 'message'), {
    mode: input.mode === 'interrupt' ? 'interrupt' : 'queue',
  }).then((result) => ({
    text: result.queued
      ? `Queued Astra's message behind DSH's current turn (${result.queueLength} in queue). It will start automatically when the current turn settles.`
      : `Message delivered to DSH; a new turn has started on the same session. Task: \`${result.taskId}\`.`,
    structured: result,
  }))
}

async function dshCancel(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const taskId = requireString(input.taskId, 'taskId')
  const result = await runner.cancel(taskId)
  return {
    text: `Cancelled \`${taskId}\`. Queued instructions were cleared; the session log is preserved. Use \`dsh_message\` to resume.\n\nBoard: \`${store.root}\``,
    structured: result,
  }
}

function dshResult(bridge, input) {
  const { runner } = bridge.forWorkspace(input.workspace)
  const payload = runner.result(requireString(input.taskId, 'taskId'), {
    includeDiff: Boolean(input.includeDiff),
  })
  return { text: payload.resultMarkdown || `No result artifact yet for ${payload.taskId}.`, structured: payload }
}

async function dshReview(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const taskId = requireString(input.taskId, 'taskId')
  const decision = requireString(input.decision, 'decision')
  const result = await runner.review(taskId, decision, input.notes ?? '', {
    continueTask: Boolean(input.continueTask),
  })
  if (decision === 'accepted') {
    try {
      const task = store.loadTask(taskId)
      if (task.requestId) {
        const request = store.loadRequest(task.requestId)
        request.state = 'done'
        store.saveRequest(request)
      }
    } catch {
      // Review is recorded even if the parent request is already gone.
    }
  }
  const tail = result.continueTask ? '\n\nRework instructions were sent to DSH as a new turn.' : ''
  return {
    text: `Recorded review for \`${taskId}\`: **${decision}**.${tail}\n\nReview file: \`${join(store.taskDir(taskId), 'review.md')}\``,
    structured: result,
  }
}

async function dshDiff(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const changes = await runner.diff({
    sinceTaskId: input.sinceTaskId,
    maxBytes: Number(input.maxBytes ?? 120_000),
  })
  const files = Array.isArray(changes.changedFiles) && changes.changedFiles.length
    ? changes.changedFiles.map((entry) => `- \`${entry.path}\` (${entry.code})`).join('\n')
    : '- _none_'
  const text = `# Workspace changes — ${store.workspace}\n\n## Files\n\n${files}\n\n## Diff stat\n\n\`\`\`\n${changes.diffStat || '(none)'}\n\`\`\`\n\n## Diff\n\n\`\`\`diff\n${changes.diff || '(none)'}\n\`\`\`${changes.truncated ? '\n\n_Diff truncated._' : ''}`
  return { text, structured: changes }
}

function dshReadFile(bridge, input) {
  const { store } = bridge.forWorkspace(input.workspace)
  const requested = requireString(input.path, 'path')
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(store.workspace, requested)
  const workspaceReal = realpathSync(store.workspace)
  const real = (() => {
    try {
      return realpathSync(absolute)
    } catch {
      throw new BridgeError(`file not found: ${requested}`, { code: 'FILE_NOT_FOUND' })
    }
  })()
  if (real !== workspaceReal && !real.startsWith(`${workspaceReal}${sep}`)) {
    throw new BridgeError(`path escapes the shared workspace: ${requested}`, { code: 'PATH_ESCAPE' })
  }
  const maxBytes = Math.min(Number(input.maxBytes ?? 60_000), 200_000)
  const buffer = readFileSync(real)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const rel = relative(workspaceReal, real) || '.'
  const binary = buffer.subarray(0, 4096).includes(0)
  const slice = buffer.subarray(0, maxBytes)
  const content = binary ? '' : slice.toString('utf8')
  const truncated = buffer.length > maxBytes
  const text = binary
    ? `# ${rel}\n\n- size: ${buffer.length}\n- sha256: \`${sha256}\`\n- binary: yes (content omitted)`
    : `# ${rel}\n\n- size: ${buffer.length}\n- sha256: \`${sha256}\`${truncated ? `\n- truncated to ${maxBytes} bytes` : ''}\n\n\`\`\`\n${content}\n\`\`\``
  return {
    text,
    structured: { path: rel, absolute: real, size: buffer.length, sha256, binary, truncated, content },
  }
}

function astraStatus(bridge, input) {
  const { store, runner } = bridge.forWorkspace(input.workspace)
  const tasks = runner.list()
  const requests = store.listRequests()
  const payload = {
    workspace: store.workspace,
    board: store.root,
    bridge: {
      version: '1.0.0',
      pid: process.pid,
      runnerId: runner.runnerId,
      dshBin: bridge.config.dshBin,
      dshHome: runner.dshHome,
      dshHomeFallbackReason: runner.dshHomeFallbackReason,
      attachQueueDir: runner.attachQueueDir,
      model: bridge.config.model,
      effort: bridge.config.effort,
      permissionMode: bridge.config.permissionMode,
      permissionPolicy: bridge.config.permissionPolicy,
    },
    acp: {
      running: Boolean(runner.client?.alive),
      sessions: runner.client ? [...runner.client.activeSessions] : [],
      activeTurns: [...runner.active.keys()],
    },
    lock: store.inspectLock(),
    counts: {
      tasks: tasks.length,
      running: tasks.filter((task) => task.state === 'running').length,
      awaitingAstra: tasks.filter((task) => task.awaitingAstra).length,
      requests: requests.length,
      openRequests: requests.filter((request) => request.state === 'open').length,
    },
  }
  const text = [
    `# Astra ↔ DSH bridge`,
    '',
    `- Workspace: \`${store.workspace}\``,
    `- Board: \`${store.root}\``,
    `- DSH: \`${bridge.config.dshBin}\` (home \`${runner.dshHome}\`)${runner.dshHomeFallbackReason ? `\n- **Fallback:** ${runner.dshHomeFallbackReason}` : ''}\n- Attach queue: \`${runner.attachQueueDir ?? 'disabled (fallback home)'}\``,
    `- Model: ${bridge.config.model} · effort ${bridge.config.effort} · sandbox ${bridge.config.permissionMode} · ACP permission ${bridge.config.permissionPolicy}`,
    `- Verification timeout: ${bridge.config.verifyTimeoutMs}ms · max 5 commands`, 
    `- ACP process: ${payload.acp.running ? `running (${payload.acp.sessions.length} session(s))` : 'not started'}`,
    `- Active turns: ${payload.acp.activeTurns.length ? payload.acp.activeTurns.join(', ') : 'none'}`,
    `- Lock: ${renderLock(payload.lock)}`,
    `- Tasks: ${payload.counts.tasks} total · ${payload.counts.running} running · ${payload.counts.awaitingAstra} awaiting Astra`,
    `- Requests: ${payload.counts.requests} total · ${payload.counts.openRequests} open`,
  ].join('\n')
  return { text, structured: payload }
}

// ----------------------------------------------------------------- helpers

function renderStatus(payload) {
  const lines = [
    `# ${payload.title}`,
    '',
    `- **Task:** \`${payload.taskId}\` — **${payload.state}** / ${payload.phase}`,
    `- **Turn:** ${payload.turn} · session \`${payload.sessionId ?? 'n/a'}\``,
    `- **Updated:** ${payload.updatedAt}${payload.stopReason ? ` · stop ${payload.stopReason}` : ''}`,
    `- **Changed files:** ${payload.changedFiles?.length ?? 0} · queue ${payload.queueLength}`,
  ]
  if (payload.usage) lines.push(`- **Context:** ${payload.usage.used ?? '?'} / ${payload.usage.size ?? '?'} tokens`)
  if (payload.lock) lines.push(`- **Lock:** ${renderLock(payload.lock)}`)
  if (payload.error) lines.push(`- **Error:** ${payload.error}`)
  if (payload.lastAssistantText) {
    lines.push('', '## Latest DSH text', '', truncate(payload.lastAssistantText, 2500))
  }
  if (payload.verification) {
    lines.push('', `## Verification (${payload.verification.ok ? 'PASS' : 'FAIL'})`)
    lines.push(payload.verification.checks?.length
      ? payload.verification.checks.map((check) => `- ${check.code === 0 && !check.timedOut ? '✅' : '❌'} \`${check.command}\` — ${check.timedOut ? 'timed out' : `exit ${check.code}`}, ${check.durationMs}ms`).join('\n')
      : '- _No checks ran._')
  }
  if (payload.autoReview?.reasons?.length) {
    lines.push('', '## Auto-review blocked', '', payload.autoReview.reasons.map((reason) => `- ${reason}`).join('\n'))
  }
  if (payload.questions?.length) {
    lines.push('', '## Questions for Astra', '', payload.questions.map((question) => `- ${question}`).join('\n'))
  }
  if (payload.changedFiles?.length) {
    lines.push('', '## Files changed', '', payload.changedFiles.slice(0, 30).map((entry) => `- \`${entry.path}\` (${entry.code})`).join('\n'))
  }
  if (payload.events?.length) {
    lines.push('', '## Recent events', '', payload.events.map(formatEvent).join('\n'))
  }
  if (payload.nextActions?.length) {
    lines.push('', `**Next:** ${payload.nextActions.join(' · ')}`)
  }
  return lines.join('\n')
}

function formatEvent(event) {
  const time = typeof event.t === 'string' ? event.t.slice(11, 19) : ''
  const detail = event.text ?? event.title ?? event.error ?? event.state ?? event.decision ?? event.status ?? ''
  return `- \`${time}\` ${event.type}${detail ? ` — ${oneLine(detail, 300)}` : ''}`
}

function renderLock(lock) {
  if (!lock) return 'free'
  return `${lock.owner}${lock.taskId ? ` (${lock.taskId})` : ''} since ${lock.acquiredAt}`
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError(`${field} is required`, { code: 'BAD_ARGUMENT' })
  }
  return value.trim()
}
