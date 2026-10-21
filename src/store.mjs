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
  /** @param {string} workspace absolute project directory */
  constructor(workspace) {
    this.workspace = resolveWorkspace(workspace)
    this.root = join(this.workspace, '.astra-dsh')
    this.dirs = {
      root: this.root,
      requests: join(this.root, 'requests'),
      tasks: join(this.root, 'tasks'),
      locks: join(this.root, 'locks'),
      logs: join(this.root, 'logs'),
    }
    for (const dir of Object.values(this.dirs)) ensureDir(dir)
    this.ensureGitExclude()
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
  createTask({ title, packet, requestId, writeScopes, model, effort, runner, reviewMode, verifyCommands }) {
    const id = timestampId('T')
    const createdAt = nowIso()
    const task = {
      schema: STORE_VERSION,
      id,
      workspace: this.workspace,
      title,
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
      turnIndex: 0,
      queue: [],
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

  saveTask(task) {
    task.updatedAt = nowIso()
    writeJson(join(this.taskDir(task.id), 'task.json'), task)
    return task
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
  inspectLock() {
    const owner = readJson(join(this.lockDir(), 'owner.json'))
    if (!owner) return null
    const expired = Date.parse(owner.expiresAt ?? 0) < Date.now()
    const dead = owner.pid !== undefined && !isPidAlive(owner.pid)
    return { ...owner, expired, dead, stale: expired || dead }
  }

  /** Acquire the single-writer workspace lock. Throws LOCK_HELD when someone else owns it. */
  acquireLock({ owner, taskId = null, ttlMs = 2 * 60 * 60 * 1000, note = '' }) {
    ensureDir(this.dirs.locks)
    const dir = this.lockDir()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        // mkdir is atomic, so exactly one process can create the lock directory.
        mkdirSync(dir)
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
        const current = this.inspectLock()
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
    const current = this.inspectLock()
    if (!current) return false
    if (token !== undefined && current.token !== token) {
      throw new BridgeError('lock token does not match the current owner', { code: 'LOCK_NOT_OWNER' })
    }
    removePath(this.lockDir())
    return true
  }

  heartbeatLock(token, ttlMs = 2 * 60 * 60 * 1000) {
    const current = this.inspectLock()
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
