/**
 * Workspace-scoped durable state for the Astra ↔ DSH bridge.
 *
 * Everything lives under `<workspace>/.astra-dsh/` so both applications read the
 * same bytes from the same shared directory:
 *
 *   requests/<REQ>/request.json|request.md|plan.md
 *   tasks/<TASK>/task.json|task.md|events.jsonl|result.md|changes.json|turns/
 *   locks/workspace.lock/owner.json
 *   logs/
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import {
  BridgeError,
  appendJsonLine,
  ensureDir,
  isPidAlive,
  nowIso,
  pathExists,
  readJson,
  readJsonLines,
  readText,
  removePath,
  resolveWorkspace,
  shortId,
  truncate,
  writeJson,
  writeText,
  runCommand,
} from './util.mjs'

export const STORE_VERSION = 1

const SNAPSHOT_EXCLUDES = new Set([
  '.git', 'node_modules', '.astra-dsh', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'target', 'coverage',
  '.DS_Store', '.cache', 'vendor',
])

/** Create a time-ordered id such as `T-20261021-151230-a1b2`. */
function timestampId(prefix) {
  const d = new Date()
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${prefix}-${stamp}-${shortId(2)}`
}

/** Parse `git status --porcelain` into path/status facts. */
function parsePorcelain(text) {
  const files = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const code = line.slice(0, 2)
    let file = line.slice(3).trim()
    if (file.includes(' -> ')) file = file.split(' -> ').pop().trim()
    if ((file.startsWith('"') && file.endsWith('"')) || file.startsWith("'")) {
      file = file.slice(1, -1)
    }
    files.push({ path: file, code })
  }
  return files
}

/** Recursively snapshot a non-git tree for change detection. */
function snapshotTree(root, limit = 20_000) {
  const files = {}
  let count = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count >= limit) return
      if (SNAPSHOT_EXCLUDES.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.size > 4 * 1024 * 1024) continue
      const rel = relative(root, full)
      files[rel] = `${stat.size}:${Math.round(stat.mtimeMs)}`
      count += 1
    }
  }
  walk(root)
  return files
}

/** The workspace boundary and all durable task-board operations. */
export class WorkspaceStore {
  /**
   * @param {string} workspace absolute project directory
   * @param {{controlOnly?: boolean}} [options] controlOnly skips git exclude
   *   bookkeeping so a watchdog sidecar cannot touch business-adjacent files.
   */
  constructor(workspace, { controlOnly = false } = {}) {
    this.workspace = resolveWorkspace(workspace)
    this.root = join(this.workspace, '.astra-dsh')
    this.dirs = {
      root: this.root,
      requests: join(this.root, 'requests'),
      tasks: join(this.root, 'tasks'),
      locks: join(this.root, 'locks'),
      logs: join(this.root, 'logs'),
      notifications: join(this.root, 'notifications'),
    }
    for (const dir of Object.values(this.dirs)) ensureDir(dir)
    if (!controlOnly) this.ensureGitExclude()
  }

  /** Keep bridge control files out of `git status` without touching tracked .gitignore. */
  ensureGitExclude() {
    if (!pathExists(join(this.workspace, '.git'))) return
    try {
      // Works for regular repositories and for worktrees, where `.git` is a file.
      let exclude
      try {
        exclude = execFileSync('git', ['-C', this.workspace, 'rev-parse', '--git-path', 'info/exclude'], {
          encoding: 'utf8',
          timeout: 10_000,
        }).trim()
        if (!isAbsolute(exclude)) exclude = join(this.workspace, exclude)
      } catch {
        exclude = join(this.workspace, '.git', 'info', 'exclude')
      }
      const current = readText(exclude, '')
      if (!current.split('\n').includes('.astra-dsh/')) {
        writeText(exclude, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}.astra-dsh/\n`)
      }
    } catch {
      // Unusual git layouts are non-fatal.
    }
  }

  // ---------------------------------------------------------------- tasks

  taskDir(id) {
    return join(this.dirs.tasks, id)
  }

  /** Create a task record and its human-readable packet. */
  createTask({ title, packet, requestId, writeScopes, model, effort, runner, reviewMode, verifyCommands, taskKind, implementationPlan, codexThreadId, guiPolicy, guiWorkspaceTitle }) {
    const id = timestampId('T')
    const createdAt = nowIso()
    const task = {
      schema: STORE_VERSION,
      id,
      workspace: this.workspace,
      title,
      taskKind: taskKind ?? 'implement',
      implementationPlan: implementationPlan ?? '',
      codexThreadId: codexThreadId ?? null,
      notifiedAt: null,
      notifyError: null,
      state: 'created',
      phase: 'packet-ready',
      createdAt,
      updatedAt: createdAt,
      requestId: requestId ?? null,
      writeScopes: writeScopes ?? [],
      model: model ?? null,
      effort: effort ?? null,
      reviewMode: reviewMode ?? 'light',
      verifyCommands: verifyCommands ?? [],
      verification: null,
      autoReview: null,
      sessionId: null,
      guiPolicy: guiPolicy ?? 'existing',
      guiWorkspaceTitle: guiWorkspaceTitle ?? null,
      attachGeneration: 0,
      attachSessionId: null,
      attachQueuedAt: null,
      turnIndex: 0,
      queue: [],
      queueRevision: 0,
      lastAssistantText: '',
      finalText: '',
      stopReason: null,
      error: null,
      usage: null,
      changedFiles: [],
      diffStat: '',
      baseline: null,
      permissionDecisions: [],
      runner: runner ?? null,
      review: null,
    }
    const dir = this.taskDir(id)
    ensureDir(dir)
    ensureDir(join(dir, 'turns'))
    writeText(join(dir, 'task.md'), packet)
    this.saveTask(task)
    return task
  }

  loadTask(id) {
    const task = readJson(join(this.taskDir(id), 'task.json'))
    if (!task) throw new BridgeError(`unknown task: ${id}`, { code: 'TASK_NOT_FOUND' })
    return task
  }

  /**
   * Persist a task snapshot without letting an older turn/notification replay
   * overwrite newer durable state. Queue mutations carry an explicit revision,
   * and a completed review is never rolled back by a stale snapshot.
   */
  saveTask(task) {
    const file = join(this.taskDir(task.id), 'task.json')
    const disk = readJson(file, null)
    if (disk) {
      const diskTurn = Number(disk.turnIndex ?? 0)
      const taskTurn = Number(task.turnIndex ?? 0)
      if (diskTurn > taskTurn) {
        // This caller is replaying an older turn. Its notification bookkeeping
        // lives in the outbox, so dropping the whole stale snapshot is safe.
        return disk
      }
      const diskRevision = Number(disk.queueRevision ?? 0)
      const taskRevision = Number(task.queueRevision ?? 0)
      if (diskRevision > taskRevision) {
        task.queue = disk.queue ?? []
        task.queueRevision = diskRevision
      } else if (task.queueRevision === undefined) {
        task.queueRevision = 0
      }
      const diskReviewAt = disk.review?.at ? Date.parse(disk.review.at) : 0
      const taskReviewAt = task.review?.at ? Date.parse(task.review.at) : 0
      if (diskTurn === taskTurn && disk.review && diskReviewAt >= taskReviewAt && ['accepted', 'changes_requested', 'rejected'].includes(disk.state)) {
        task.review = disk.review
        task.state = disk.state
        task.phase = disk.phase
        task.endedAt = disk.endedAt ?? task.endedAt
      }
      if (diskTurn === taskTurn && disk.state === 'cancelled' && ['running', 'created', 'idle'].includes(task.state)) {
        task.state = 'cancelled'
        task.phase = 'cancelled'
        task.stopReason = 'cancelled'
      }
      // Heartbeats/progress and the sidecar monitor are written by independent,
      // fresher paths. Never roll them back with an older turn snapshot.
      if (String(disk.lastAcpUpdateAt ?? '') > String(task.lastAcpUpdateAt ?? '')) {
        task.lastAcpUpdateAt = disk.lastAcpUpdateAt
      }
      if (String(disk.lastBridgeHeartbeatAt ?? '') > String(task.lastBridgeHeartbeatAt ?? '')) {
        task.lastBridgeHeartbeatAt = disk.lastBridgeHeartbeatAt
      }
      if (disk.lastTool && (!task.lastTool || String(disk.lastTool.at ?? '') > String(task.lastTool.at ?? ''))) {
        task.lastTool = disk.lastTool
      }
      if (disk.monitor !== undefined) task.monitor = disk.monitor
      if (disk.stall !== undefined && disk.stall !== null) {
        if (task.stall === undefined || task.stall === null) {
          task.stall = disk.stall
        } else if (String(disk.stall.suspectedAt ?? '') > String(task.stall.suspectedAt ?? '')) {
          task.stall = disk.stall
        } else if (String(disk.stall.suspectedAt ?? '') === String(task.stall.suspectedAt ?? '')) {
          // Same episode: keep a recovery marker written by the live turn and
          // take any additional durable fields from disk.
          task.stall = { ...disk.stall, ...task.stall }
        }
      }
      if (disk.runner && task.runner) {
        task.runner = {
          ...disk.runner,
          ...task.runner,
          lastHeartbeatAt: String(disk.runner.lastHeartbeatAt ?? '') > String(task.runner.lastHeartbeatAt ?? '')
            ? disk.runner.lastHeartbeatAt
            : task.runner.lastHeartbeatAt,
          turn: Math.max(Number(disk.runner.turn ?? 0), Number(task.runner.turn ?? 0)),
        }
      }
      if (disk.incident && !task.incident && Number(disk.incident.turn ?? 0) >= taskTurn) {
        task.incident = disk.incident
      }
      // A stale snapshot must not clear a real risk, but an explicit resolution
      // for the same turn (newer than the incident) must not be resurrected by
      // an older snapshot either.
      const latestIncidentAt = String(disk.incident?.at ?? '') > String(task.incident?.at ?? '')
        ? String(disk.incident?.at ?? '')
        : String(task.incident?.at ?? '')
      const diskResolved = Boolean(
        disk.executionMayBeActiveResolvedAt
        && Number(disk.executionMayBeActiveResolvedTurn ?? -1) === diskTurn
        && String(disk.executionMayBeActiveResolvedAt) >= latestIncidentAt
      )
      const taskResolved = Boolean(
        task.executionMayBeActiveResolvedAt
        && Number(task.executionMayBeActiveResolvedTurn ?? -1) === diskTurn
        && String(task.executionMayBeActiveResolvedAt) >= latestIncidentAt
      )
      if (diskResolved) {
        task.executionMayBeActive = false
        task.executionMayBeActiveResolvedAt = disk.executionMayBeActiveResolvedAt
        task.executionMayBeActiveResolvedTurn = disk.executionMayBeActiveResolvedTurn
        if (disk.incident
          && Number(disk.incident.turn ?? 0) >= taskTurn
          && String(disk.incident.at ?? '') >= String(task.incident?.at ?? '')) {
          task.incident = disk.incident
        }
      } else if (disk.executionMayBeActive && !taskResolved) {
        task.executionMayBeActive = true
      } else if (task.executionMayBeActive && !disk.executionMayBeActive) {
        task.executionMayBeActive = true
      }
    }
    task.updatedAt = nowIso()
    writeJson(file, task)
    return task
  }

  /** Read-modify-write against the latest durable snapshot (safe for heartbeats). */
  updateTask(id, mutate) {
    const task = this.loadTask(id)
    const next = (typeof mutate === 'function' ? mutate(task) : mutate) ?? task
    return this.saveTask(next)
  }

  /** Persist the latest human-readable incident for a task. */
  writeIncident(task, incident) {
    ensureDir(this.taskDir(task.id))
    const record = { schema: STORE_VERSION, taskId: task.id, at: nowIso(), ...incident }
    writeJson(join(this.taskDir(task.id), 'incident.json'), record)
    task.incident = record
    return record
  }

  /** Read the latest incident, including a sidecar-written control-loss file. */
  readIncident(taskId) {
    const main = readJson(join(this.taskDir(taskId), 'incident.json'), null)
    const controlLost = readJson(join(this.taskDir(taskId), 'incident-control-lost.json'), null)
    if (!main) return controlLost
    if (!controlLost) return main
    return String(controlLost.at ?? '') > String(main.at ?? '') ? controlLost : main
  }

  /** Explicitly mark the latest incident resolved after out-of-band verification. */
  resolveIncident(taskId, { resolvedBy = 'astra', note = '' } = {}) {
    const incident = this.readIncident(taskId)
    if (!incident) return null
    const resolved = {
      ...incident,
      executionMayBeActive: false,
      resolvedAt: nowIso(),
      resolvedBy,
      resolutionNote: truncate(note, 1000),
    }
    writeJson(join(this.taskDir(taskId), 'incident.json'), resolved)
    return resolved
  }

  listTasks({ state } = {}) {
    const tasks = []
    for (const id of safeReaddir(this.dirs.tasks)) {
      const task = readJson(join(this.dirs.tasks, id, 'task.json'))
      if (!task) continue
      if (state && task.state !== state) continue
      tasks.push(task)
    }
    tasks.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    return tasks
  }

  /** Append one compact progress event. */
  appendEvent(task, event) {
    const record = { t: nowIso(), ...event }
    appendJsonLine(join(this.taskDir(task.id), 'events.jsonl'), record)
    return record
  }

  readEvents(taskId, limit = 50) {
    const all = readJsonLines(join(this.taskDir(taskId), 'events.jsonl'))
    return limit > 0 ? all.slice(-limit) : all
  }

  writeTaskText(task, name, text) {
    writeText(join(this.taskDir(task.id), name), text)
  }

  writeTurn(task, turnIndex, name, text) {
    const dir = join(this.taskDir(task.id), 'turns', String(turnIndex).padStart(3, '0'))
    ensureDir(dir)
    writeText(join(dir, name), text)
  }

  // ------------------------------------------------------------- requests

  createRequest({ title, body, origin = 'dsh', priority = 'normal', createdBy = origin, linkedTasks = [] }) {
    const id = timestampId('REQ')
    const createdAt = nowIso()
    const request = {
      schema: STORE_VERSION,
      id,
      workspace: this.workspace,
      title,
      origin,
      createdBy,
      priority,
      state: 'open',
      createdAt,
      updatedAt: createdAt,
      claimedBy: null,
      claimedAt: null,
      plan: '',
      note: '',
      linkedTasks,
    }
    const dir = this.requestDir(id)
    ensureDir(dir)
    writeText(join(dir, 'request.md'), body)
    this.saveRequest(request)
    return request
  }

  requestDir(id) {
    return join(this.dirs.requests, id)
  }

  loadRequest(id) {
    const request = readJson(join(this.requestDir(id), 'request.json'))
    if (!request) throw new BridgeError(`unknown request: ${id}`, { code: 'REQUEST_NOT_FOUND' })
    request.body = readText(join(this.requestDir(id), 'request.md'), '')
    request.plan = readText(join(this.requestDir(id), 'plan.md'), request.plan ?? '')
    return request
  }

  saveRequest(request) {
    request.updatedAt = nowIso()
    writeJson(join(this.requestDir(request.id), 'request.json'), request)
    return request
  }

  writeRequestPlan(request, plan) {
    request.plan = plan
    writeText(join(this.requestDir(request.id), 'plan.md'), plan)
    return this.saveRequest(request)
  }

  listRequests({ state } = {}) {
    const requests = []
    for (const id of safeReaddir(this.dirs.requests)) {
      const request = readJson(join(this.dirs.requests, id, 'request.json'))
      if (!request) continue
      if (state && request.state !== state) continue
      requests.push(request)
    }
    requests.sort((a, b) => {
      const rank = { urgent: 0, high: 1, normal: 2, low: 3 }
      const byPriority = (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2)
      return byPriority || String(b.createdAt).localeCompare(String(a.createdAt))
    })
    return requests
  }

  // ---------------------------------------------------------------- locks

  lockDir() {
    return join(this.dirs.locks, 'workspace.lock')
  }

  /** Read the current writer lock, or null. */
  inspectLock({ includeExecutionRisk = true } = {}) {
    const owner = readJson(join(this.lockDir(), 'owner.json'))
    if (!owner) return null
    const expired = Date.parse(owner.expiresAt ?? 0) < Date.now()
    const dead = owner.pid !== undefined && !isPidAlive(owner.pid)
    let blockedByExecutionRisk = null
    if (includeExecutionRisk) blockedByExecutionRisk = this.executionRiskSummary()
    return {
      ...owner,
      expired,
      dead,
      stale: expired || dead,
      reclaimable: (expired || dead) && !blockedByExecutionRisk,
      blockedByExecutionRisk,
    }
  }

  /**
   * Scan only this workspace for tasks that may still be executing. This is the
   * gate used by every writer entry point (Astra lock, dispatch, queued turn).
   * A dead lock owner or an expired lease is NOT proof that the ACP child died.
   *
   * Rules:
   * - task.executionMayBeActive or a same-turn incident with
   *   executionMayBeActive !== false is a risk;
   * - a task/incident resolution only counts for the same turn and only when
   *   it is at least as new as the incident it resolves;
   * - an incident from an older turn never blocks a new turn/task;
   * - unreadable task/incident records fail closed with EXECUTION_RISK_UNKNOWN.
   */
  executionRisks() {
    const risks = []
    let taskIds
    try {
      taskIds = readdirSync(this.dirs.tasks, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      if (error?.code === 'ENOENT') return risks
      throw new BridgeError(`cannot list tasks to evaluate execution risk: ${error.message}`, {
        code: 'EXECUTION_RISK_UNKNOWN',
        details: { error: error.message },
      })
    }
    for (const id of taskIds) {
      let task
      let incident
      try {
        task = readJson(join(this.dirs.tasks, id, 'task.json'), null)
      } catch (error) {
        throw new BridgeError(`cannot evaluate execution risk for ${id}: ${error.message}`, {
          code: 'EXECUTION_RISK_UNKNOWN',
          details: { taskId: id, error: error.message },
        })
      }
      if (!task) continue
      try {
        incident = this.readIncident(id)
      } catch (error) {
        throw new BridgeError(`cannot read the execution-risk incident for ${id}: ${error.message}`, {
          code: 'EXECUTION_RISK_UNKNOWN',
          details: { taskId: id, error: error.message },
        })
      }

      const turn = Number(task.turnIndex ?? 0)
      const rawIncidentTurn = Number(incident?.turn)
      // A missing turn on an explicit active incident is treated as the current
      // turn (fail closed) rather than silently ignored.
      const incidentTurn = Number.isInteger(rawIncidentTurn)
        ? rawIncidentTurn
        : (incident?.executionMayBeActive === true ? turn : -1)
      const incidentApplies = Boolean(
        incident
        && incidentTurn >= turn
        && incident.executionMayBeActive !== false
      )
      const taskActive = task.executionMayBeActive === true
      if (!taskActive && !incidentApplies) continue

      const latestIncidentAt = incidentApplies ? String(incident.at ?? '') : ''
      const resolvedAt = task.executionMayBeActiveResolvedAt
      const resolvedTurn = Number(task.executionMayBeActiveResolvedTurn ?? -1)
      const taskResolved = Boolean(
        resolvedAt
        && resolvedTurn === turn
        && String(resolvedAt) >= latestIncidentAt
      )
      const incidentResolved = Boolean(
        incident
        && incident.resolvedAt
        && incident.executionMayBeActive === false
        && String(incident.resolvedAt) >= String(incident.at ?? '')
      )
      if (taskResolved || incidentResolved) continue

      risks.push({
        taskId: id,
        state: task.state ?? null,
        turn,
        sessionId: task.sessionId ?? null,
        phase: task.phase ?? null,
        incidentKind: incident?.kind ?? null,
        incidentAt: incident?.at ?? null,
        ownerPid: task.runner?.pid ?? null,
        acpPid: task.runner?.acpPid ?? null,
        executionMayBeActive: true,
        resolutionHint: 'Verify the old DSH/ACP process is stopped, then use dsh_message force=true for this task. Do not delete or steal the lock.',
      })
    }
    return risks
  }

  /** First risk (or unknown-risk marker) for status; never throws. */
  executionRiskSummary() {
    try {
      return this.executionRisks()[0] ?? null
    } catch (error) {
      return {
        unknown: true,
        code: error?.code ?? 'EXECUTION_RISK_UNKNOWN',
        error: error?.message ?? String(error),
        executionMayBeActive: true,
      }
    }
  }

  /** Throw the stable writer-gate error if this workspace has any risk task. */
  assertNoExecutionRisk() {
    const risks = this.executionRisks()
    if (risks.length > 0) throw this.executionRiskError(risks)
    return null
  }

  executionRiskError(risks) {
    const risk = risks[0]
    return new BridgeError(
      `workspace has unresolved execution risk for ${risk.taskId} (${risk.state ?? 'unknown'}, turn ${risk.turn}); refusing a new writer even if the lock is stale or missing`,
      {
        code: 'EXECUTION_MAY_BE_ACTIVE',
        details: {
          blockedByExecutionRisk: risk,
          risks: risks.slice(0, 10),
          resolution: risk.resolutionHint,
        },
      },
    )
  }

  /** Acquire the single-writer workspace lock. Throws LOCK_HELD when someone else owns it. */
  acquireLock({ owner, taskId = null, ttlMs = 2 * 60 * 60 * 1000, note = '' }) {
    const dir = this.lockDir()
    // Gate every writer entry point before touching a stale/missing lock.
    let risks = this.executionRisks()
    if (risks.length > 0) throw this.executionRiskError(risks)
    ensureDir(this.dirs.locks)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // mkdir is atomic, so exactly one process can create the lock directory.
        mkdirSync(dir)
        // Close the race with an incident written after the pre-check.
        try {
          risks = this.executionRisks()
        } catch (error) {
          removePath(dir)
          throw error
        }
        if (risks.length > 0) {
          removePath(dir)
          throw this.executionRiskError(risks)
        }
        const record = {
          owner,
          taskId,
          pid: process.pid,
          token: shortId(8),
          acquiredAt: nowIso(),
          heartbeatAt: nowIso(),
          expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          note,
        }
        writeJson(join(dir, 'owner.json'), record)
        return record
      } catch (error) {
        if (!error || error.code !== 'EEXIST') throw error
        // A risk may have appeared after the pre-check; re-check before even
        // inspecting/reclaiming a stale lock.
        const risksNow = this.executionRisks()
        if (risksNow.length > 0) throw this.executionRiskError(risksNow)
        const current = this.inspectLock({ includeExecutionRisk: false })
        if (!current) continue
        if (!current.stale) {
          throw new BridgeError(
            `workspace is locked by ${current.owner}${current.taskId ? ` for ${current.taskId}` : ''} since ${current.acquiredAt}`,
            {
              code: 'LOCK_HELD',
              details: {
                owner: current.owner,
                taskId: current.taskId,
                acquiredAt: current.acquiredAt,
                note: current.note,
                expiresAt: current.expiresAt,
              },
            },
          )
        }
        // Move the stale lock aside before deleting it so concurrent reclaimers
        // cannot both believe they removed the same directory.
        const staleDir = `${dir}.stale-${shortId(3)}`
        try {
          renameSync(dir, staleDir)
        } catch (renameError) {
          if (renameError && renameError.code === 'ENOENT') continue
          throw renameError
        }
        removePath(staleDir)
      }
    }
    throw new BridgeError('could not acquire workspace lock after repeated contention', { code: 'LOCK_CONTENTION' })
  }

  releaseLock(token) {
    const current = this.inspectLock({ includeExecutionRisk: false })
    if (!current) return false
    if (token !== undefined && current.token !== token) {
      throw new BridgeError('lock token does not match the current owner', { code: 'LOCK_NOT_OWNER' })
    }
    removePath(this.lockDir())
    return true
  }

  heartbeatLock(token, ttlMs = 2 * 60 * 60 * 1000) {
    const current = this.inspectLock({ includeExecutionRisk: false })
    if (!current) return null
    if (token !== undefined && current.token !== token) return null
    const record = {
      owner: current.owner,
      taskId: current.taskId,
      pid: current.pid,
      token: current.token,
      acquiredAt: current.acquiredAt,
      heartbeatAt: nowIso(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      note: current.note,
    }
    writeJson(join(this.lockDir(), 'owner.json'), record)
    return record
  }

  // -------------------------------------------------------------- changes

  /** Record the state of the tree before a DSH turn. */
  async captureBaseline() {
    if (!this.isGit()) {
      return { vcs: 'files', capturedAt: nowIso(), files: snapshotTree(this.workspace) }
    }
    return this.gitBaseline()
  }

  isGit() {
    return pathExists(join(this.workspace, '.git'))
  }

  async gitBaseline() {
    const head = await this.git(['rev-parse', 'HEAD'])
    const status = await this.git(['status', '--porcelain'])
    return {
      vcs: 'git',
      capturedAt: nowIso(),
      head: head.code === 0 ? head.stdout.trim() : null,
      dirty: parsePorcelain(status.stdout),
    }
  }

  /**
   * Collect the current tree state and a bounded diff since the baseline.
   * @param {object|undefined} baseline
   * @param {number} maxDiffBytes
   */
  async collectChanges(baseline, maxDiffBytes = 300_000) {
    if (!baseline) return { vcs: 'unknown', changedFiles: [], diffStat: '', diff: '', untracked: [] }
    if (baseline.vcs === 'files') {
      const after = snapshotTree(this.workspace)
      const before = baseline.files ?? {}
      const changed = []
      for (const [path, signature] of Object.entries(after)) {
        if (before[path] !== signature) changed.push({ path, code: before[path] ? 'M' : 'A' })
      }
      for (const path of Object.keys(before)) {
        if (!(path in after)) changed.push({ path, code: 'D' })
      }
      changed.sort((a, b) => a.path.localeCompare(b.path))
      return {
        vcs: 'files',
        changedFiles: changed,
        diffStat: `${changed.length} file(s) changed`,
        diff: changed.map((entry) => `${entry.code} ${entry.path}`).join('\n'),
        untracked: changed.filter((entry) => entry.code === 'A').map((entry) => entry.path),
        truncated: false,
      }
    }

    const status = await this.git(['status', '--porcelain'])
    const current = parsePorcelain(status.stdout)
    const dirtyPaths = new Set((baseline.dirty ?? []).map((entry) => entry.path))
    let diff = await this.git(['diff', 'HEAD', '--no-color', '--no-ext-diff', '--'], maxDiffBytes + 1)
    if (diff.code !== 0) diff = await this.git(['diff', '--no-color', '--no-ext-diff', '--'], maxDiffBytes + 1)
    const stat = await this.git(['diff', '--stat', 'HEAD', '--no-color'])
    const untracked = await this.git(['ls-files', '--others', '--exclude-standard'])
    const fullDiff = diff.stdout
    const changedFiles = current.map((entry) => ({
      path: entry.path,
      code: entry.code,
      preexisting: dirtyPaths.has(entry.path),
    }))
    return {
      vcs: 'git',
      headBefore: baseline.head,
      headAfter: (await this.git(['rev-parse', 'HEAD'])).stdout.trim() || null,
      changedFiles,
      preexistingDirty: [...dirtyPaths],
      diffStat: stat.code === 0 ? stat.stdout.trim() : '',
      diff: truncate(fullDiff, maxDiffBytes),
      truncated: fullDiff.length > maxDiffBytes,
      untracked: untracked.code === 0 ? untracked.stdout.split('\n').filter(Boolean) : [],
    }
  }

  async git(args, maxBytes = 1_000_000) {
    return runCommand('git', ['-C', this.workspace, ...args], {
      timeoutMs: 30_000,
      maxBytes,
    })
  }

  // ---------------------------------------------------------------- logs

  logFileName(prefix) {
    const d = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return join(this.dirs.logs, `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`)
  }

  /** Append one diagnostic JSON line without touching task state. */
  appendJsonLog(prefix, record) {
    appendJsonLine(this.logFileName(prefix), { t: nowIso(), ...record })
  }
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
