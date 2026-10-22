/**
 * The execution side of the bridge: turns durable task records into DSH ACP
 * sessions, streams progress back into the shared task board, and keeps the
 * workspace single-writer lock honest.
 */

import { accessSync, constants, copyFileSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AcpClient } from './acp-client.mjs'
import { HostControlClient, probeHostControl } from './host-client.mjs'
import {
  ATTACH_STATUS,
  DEFAULT_GUI_POLICY,
  TERMINAL_STATUSES,
  canonicalWorkspacePath,
  identityKey,
  identityMatches,
  legacyRequestPath,
  normalizeGuiPolicy,
  readAttachAck,
  removeLegacyRequest,
  renderAttachRequest,
  requestPath,
  validateAttachAck,
  writeAttachRequest,
} from './attach.mjs'
import { extractQuestions, renderExecutionPrompt, renderResultArtifact, renderTaskPacket, summarizeTask } from './packet.mjs'
import { NotificationOutbox, notificationId, renderNotificationSummary } from './notifications.mjs'
import { WatchdogSupervisor } from './watchdog-supervisor.mjs'
import {
  BridgeError,
  ensureDir,
  nowIso,
  pidState,
  readJson,
  readText,
  runCommand,
  shortId,
  sleep,
  truncate,
} from './util.mjs'

/** States in which a task is actively consuming a turn. */
const RUNNING = new Set(['running', 'created'])
/** States that wait for a planner decision. */
const AWAITING = new Set(['idle', 'changes_requested'])

/** Convert one ACP tool result block to a short human summary. */
function toolResultText(update) {
  const parts = []
  for (const block of Array.isArray(update?.content) ? update.content : []) {
    if (block?.type === 'content' && block.content?.type === 'text') parts.push(block.content.text)
    else if (block?.type === 'diff') parts.push(`diff ${block.path ?? ''}`)
    else if (block?.type === 'terminal') parts.push('terminal output attached')
  }
  return truncate(parts.join('\n'), 3000)
}

export class TaskRunner {
  /**
   * @param {object} options
   * @param {import('./store.mjs').WorkspaceStore} options.store
   * @param {ReturnType<import('./config.mjs').loadConfig>} options.config
   * @param {Record<string,string>} [options.env]
   */
  constructor({ store, config, env = process.env }) {
    this.store = store
    this.config = config
    this.runnerId = shortId(4)
    this.client = null
    this.clientPromise = null
    this.host = new HostControlClient(config.hostSocket, { connectTimeoutMs: config.hostProbeTimeoutMs, requestTimeoutMs: 30_000 })
    this.clients = new Set()
    this.active = new Map()
    this.cancelling = new Set()
    this.shuttingDown = false
    this.waiters = new Map()
    this.lastBridgeHeartbeatAt = nowIso()
    this.recoveryPromise = null
    this.stallTimer = null

    // Prefer the configured DSH home (installed setups point at ~/.dsh so the
    // DSH GUI can list these sessions). If Codex's sandbox denies writes there,
    // fall back to a workspace-scoped home so execution still works.
    this.fallbackDshHome = join(store.root, 'dsh-home')
    this.dshHome = config.dshHome ?? this.fallbackDshHome
    this.dshHomeFallbackReason = null
    if (this.dshHome !== this.fallbackDshHome) {
      let writeError = null
      try {
        ensureDir(this.dshHome)
      } catch (error) {
        writeError = error.message
      }
      if (!writeError && !isWritableDir(this.dshHome)) {
        writeError = 'sandbox denial'
      }
      if (writeError) {
        // Only degrade on clear evidence of a *write* failure, and never while
        // persisted/active sessions already live in the shared home (that would
        // silently orphan them). Otherwise keep the home and let errors surface.
        const persistedSessions = this.store.listTasks().filter((task) => task.sessionId).length
        if (persistedSessions === 0) {
          this.dshHomeFallbackReason = `cannot write ${this.dshHome}: ${writeError}`
          this.dshHome = this.fallbackDshHome
        } else {
          this.dshHomeFallbackReason = `cannot write ${this.dshHome}: ${writeError} (kept because ${persistedSessions} persisted session(s) exist)`
        }
      }
    }
    ensureDir(this.dshHome)
    this.prepareCredentials()
    this.attachQueueDir = this.dshHome === this.fallbackDshHome
      ? null
      : join(this.dshHome, 'astra-dsh', 'attach')

    // Strip variables that belong to a *different* DSH surface, then pin the
    // child's home and permission mode explicitly.
    const childEnv = { ...env }
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL']) {
      delete childEnv[key]
    }
    childEnv.DSH_HOME = this.dshHome
    childEnv.DSH_PERMISSION_MODE = config.permissionMode
    childEnv.DSH_TELEMETRY_DISABLED = childEnv.DSH_TELEMETRY_DISABLED ?? '1'
    this.childEnv = childEnv
    this.outbox = new NotificationOutbox({
      store,
      config,
      owner: `runner-${this.runnerId}`,
      log: (event, extra) => this.logWatchdog(event, extra),
    })
    this.watchdogEnv = buildWatchdogEnv(config, env, { dshHome: this.dshHome })
    this.watchdogs = new WatchdogSupervisor({ store, config, env: this.watchdogEnv })
    this.startMonitors()
    if (this.config.reconcileOnStart !== false) {
      // Non-blocking: the first tool call must not wait for old tasks. Recovery
      // is workspace-scoped and never scans another project's board.
      void this.recover().catch((error) => {
        try { this.store.appendJsonLog('bridge', { event: 'recovery_failed', error: truncate(error.message, 500) }) } catch { /* ignore */ }
      })
    }
  }

  /** Prefer the live sidecar; never report a dead persisted one as active. */
  monitorFor(task) {
    const live = this.watchdogs.status(task.id)
    if (live.watchdog !== 'inactive') return live
    const persisted = task.monitor
    if (!persisted) return live
    if (persisted.watchdog === 'active') {
      return { ...persisted, watchdog: 'stale', reason: 'no live sidecar in this bridge process' }
    }
    return persisted
  }

  logWatchdog(event, extra) {
    try {
      this.store.appendJsonLog?.('watchdog', { event, ...extra })
    } catch {
      // Diagnostics only.
    }
  }

  /** Periodic bridge heartbeat + quiet-turn detection. Never kills a turn. */
  startMonitors() {
    if (this.stallTimer) return
    const interval = Math.max(20, Math.min(this.config.progressHeartbeatMs, 60_000))
    this.stallTimer = setInterval(() => {
      this.lastBridgeHeartbeatAt = nowIso()
      for (const [taskId, entry] of this.active) {
        try {
          this.store.updateTask(taskId, (task) => {
            task.lastBridgeHeartbeatAt = nowIso()
            // Persist the latest in-memory ACP activity without writing on every
            // streamed token; stall detection reads the durable value.
            if (entry.task.lastAcpUpdateAt && String(entry.task.lastAcpUpdateAt) > String(task.lastAcpUpdateAt ?? '')) {
              task.lastAcpUpdateAt = entry.task.lastAcpUpdateAt
            }
            if (entry.task.lastTool) task.lastTool = entry.task.lastTool
            task.runner = {
              ...(task.runner ?? {}),
              instance: this.runnerId,
              pid: process.pid,
              turn: task.turnIndex,
              lastHeartbeatAt: nowIso(),
            }
            return task
          })
        } catch {
          // A vanished task must not break the monitor.
        }
        this.checkStall(taskId, entry)
      }
    }, interval)
    this.stallTimer.unref?.()
  }

  /** One suspected-stall episode per quiet period; never changes running/lock. */
  checkStall(taskId, entry) {
    if (!(this.config.stallWarningMs > 0)) return
    let task
    try {
      task = this.store.loadTask(taskId)
    } catch {
      return
    }
    if (task.state !== 'running') return
    if (task.stall?.suspectedAt && !task.stall.recoveredAt) return
    const lastActivity = Date.parse(task.lastAcpUpdateAt ?? task.startedAt ?? task.updatedAt ?? 0) || Date.now()
    const quietMs = Date.now() - lastActivity
    if (quietMs < this.config.stallWarningMs) return
    const episodeAt = nowIso()
    const tool = task.lastTool ?? null
    const stall = {
      suspectedAt: episodeAt,
      lastActivityAt: new Date(lastActivity).toISOString(),
      quietMs,
      phase: task.phase ?? null,
      tool: tool ? { title: tool.title ?? null, kind: tool.kind ?? null, at: tool.at ?? null } : null,
    }
    try {
      const fresh = this.store.updateTask(taskId, (current) => {
        current.stall = stall
        return current
      })
      entry.task.stall = fresh.stall
      this.store.appendEvent(fresh, {
        type: 'suspected_stall',
        quietMs,
        phase: stall.phase,
        tool: stall.tool?.title ?? null,
        note: 'turn remains running; this is a warning, not a failure',
      })
      this.enqueueNotification(fresh, 'suspected-stall', {
        detail: `No ACP update for ${Math.round(quietMs / 1000)}s while phase=${stall.phase}${stall.tool?.title ? `, current tool=${stall.tool.title}` : ''}. The turn is still running; no automatic cancel/resume was performed.`,
        episodeAt,
      })
    } catch (error) {
      try { this.store.appendEvent(task, { type: 'stall_check_failed', error: truncate(error.message, 500) }) } catch { /* ignore */ }
    }
  }

  /** Recover this workspace's abnormal/pending records after a bridge restart. */
  async recover() {
    if (this.recoveryPromise) return this.recoveryPromise
    this.recoveryPromise = (async () => {
      this.outbox.recover()
      if (this.config.reconcileOnStart === false) return { reconciled: 0 }
      let reconciled = 0
      for (const task of this.store.listTasks()) {
        if (task.state !== 'running' || this.active.has(task.id)) continue
        const before = task.state
        const after = this.reconcile(task)
        if (after.state !== before) reconciled += 1
      }
      return { reconciled }
    })()
    return this.recoveryPromise
  }

  /** Make the user's DSH credentials readable from the workspace-scoped home. */
  prepareCredentials() {
    const dest = join(this.dshHome, '.credentials.yaml')
    if (existsSync(dest)) return
    const source = this.config.credentialsSource
    if (!source || !existsSync(source)) return
    try {
      symlinkSync(source, dest)
    } catch {
      try {
        copyFileSync(source, dest)
      } catch {
        // DSH may still authenticate from DEEPSEEK_API_KEY in the environment.
      }
    }
  }

  /** Spawn and initialize the ACP process, sharing it across tasks in this workspace. */
  async ensureClient() {
    if (this.client?.alive) return this.client
    if (!this.clientPromise) {
      this.clientPromise = this.spawnClient().finally(() => {
        if (!this.client?.alive) this.clientPromise = null
      })
    }
    return this.clientPromise
  }

  async spawnClient() {
    // No runtime home switch: an ACP exit/timeout is not evidence of a write
    // failure, and switching would silently orphan any sessions already living
    // in the shared home. The only degradation is the constructor's explicit
    // write-failure check (and only when no persisted session exists yet).
    return this.spawnClientAt(this.dshHome)
  }

  async spawnClientAt(home) {
    const client = new AcpClient({
      command: this.config.dshBin,
      args: ['acp'],
      cwd: this.store.workspace,
      env: { ...this.childEnv, DSH_HOME: home },
      logPath: this.store.logFileName('acp'),
      permissionPolicy: this.config.permissionPolicy,
    })
    client.on('permission', ({ sessionId, decision, toolCall }) => {
      const entry = [...this.active.values()].find((candidate) => candidate.sessionId === sessionId)
      if (!entry?.task) return
      const task = entry.task
      const record = {
        t: nowIso(),
        toolCallId: toolCall?.toolCallId ?? null,
        decision,
      }
      task.permissionDecisions.push(record)
      this.store.appendEvent(task, { type: 'permission', decision, toolCallId: record.toolCallId })
      this.store.saveTask(task)
    })
    this.clients.add(client)
    client.on('exit', () => {
      // The prompt promise rejects and the owning task records the interruption.
      this.clients.delete(client)
      if (this.client === client) {
        this.client = null
        this.clientPromise = null
      }
    })
    try {
      await client.initialize()
    } catch (error) {
      this.clients.delete(client)
      await client.dispose()
      throw error
    }
    this.client = client
    return client
  }

  /** Resolve or create the persisted DSH session for a task. */
  async sessionFor(task) {
    const client = await this.ensureClient()
    let recreated = false
    if (task.sessionId && client.activeSessions.has(task.sessionId)) {
      this.enqueueAttach(task)
      return client
    }
    if (task.sessionId) {
      try {
        const resumed = await client.resumeSession({ sessionId: task.sessionId, cwd: this.store.workspace })
        await this.applyModel(client, task, resumed?.configOptions)
        this.enqueueAttach(task)
        return client
      } catch (error) {
        const message = String(error?.message ?? error)
        if (message.includes('already active')) {
          throw new BridgeError(
            `DSH session ${task.sessionId} is already active in another bridge/process. Close that bridge or cancel the task there before continuing.`,
            { code: 'ACP_SESSION_BUSY' },
          )
        }
        this.store.appendEvent(task, {
          type: 'session_resume_failed',
          message: truncate(message, 500),
        })
        recreated = true
        task.sessionId = null
      }
    }
    if (!task.sessionId) {
      const session = await client.newSession({ cwd: this.store.workspace })
      task.sessionId = session.sessionId
      task.sessionRecreated = recreated
      task.phase = 'session-ready'
      this.store.saveTask(task)
      this.store.appendEvent(task, {
        type: recreated ? 'session_recreated' : 'session_created',
        sessionId: task.sessionId,
      })
      await this.applyModel(client, task, session.configOptions)
      this.enqueueAttach(task)
    }
    return client
  }

  /**
   * Ask the GUI-side workspace-attach plugin to group this session under its
   * project. The request is idempotent per (task, session, generation): the
   * bridge re-delivers when the session changes, the DSH home changes, or the
   * request file is gone. Policy is honoured here and in the plugin:
   * `off` never writes, `existing` never creates a workspace, `create` may.
   */
  enqueueAttach(task) {
    if (!this.attachQueueDir || !task.sessionId) return
    const policy = ['existing', 'create', 'off'].includes(task.guiPolicy) ? task.guiPolicy : DEFAULT_GUI_POLICY
    if (policy === 'off') return
    const generation = Number(task.attachGeneration ?? 0)
    let canonical
    try {
      canonical = canonicalWorkspacePath(this.store.workspace)
    } catch (error) {
      this.store.appendEvent(task, { type: 'attach_queue_failed', error: truncate(error.message, 500) })
      return
    }
    const identity = { taskId: task.id, sessionId: task.sessionId, generation }
    const requestFile = requestPath(this.attachQueueDir, identity, canonical)
    // Idempotent: same identity already queued, or a matching terminal ACK
    // already answered it (so resume/re-attach does not re-deliver).
    if (existsSync(requestFile)) return
    if (this.hasMatchingTerminalAck(identity, canonical)) return
    try {
      ensureDir(this.attachQueueDir)
      // Drop a legacy-name request for the same task so it is not double-processed.
      removeLegacyRequest(this.attachQueueDir, task.id)
      const request = renderAttachRequest({
        taskId: task.id,
        sessionId: task.sessionId,
        generation,
        workspace: this.store.workspace,
        title: task.guiWorkspaceTitle ?? null,
        policy,
      })
      writeAttachRequest(this.attachQueueDir, request)
      task.attachSessionId = task.sessionId
      task.attachGeneration = generation
      task.attachQueuedAt = requestFile
      this.store.appendEvent(task, {
        type: 'attach_queued',
        sessionId: task.sessionId,
        policy,
        identity: identityKey(request.identity),
      })
      this.store.saveTask(task)
    } catch (error) {
      this.store.appendEvent(task, { type: 'attach_queue_failed', error: truncate(error.message, 500) })
    }
  }

  /** Whether a terminal ACK matching this identity + workspace already exists. */
  hasMatchingTerminalAck(identity, canonical) {
    const ack = readAttachAck(this.attachQueueDir, identity, canonical)
    if (!ack || !validateAttachAck(ack).ok) return false
    if (!identityMatches(ack.identity, identity)) return false
    if (ack.canonicalWorkspace !== canonical) return false
    return TERMINAL_STATUSES.has(ack.status)
  }

  /** Re-deliver GUI attach for a task (dsh_gui_retry). Never starts a turn. */
  retryGui(taskId) {
    const task = this.store.loadTask(taskId)
    const policy = task.guiPolicy ?? DEFAULT_GUI_POLICY
    if (!this.attachQueueDir) {
      return { enqueued: false, reason: `DSH home fell back to a private directory (${this.dshHomeFallbackReason ?? 'fallback home'}), so there is no shared GUI queue.` }
    }
    if (!task.sessionId) {
      return { enqueued: false, reason: 'the task has no session to deliver.' }
    }
    if (policy === 'off') {
      return { enqueued: false, reason: 'guiPolicy=off disables GUI delivery for this task.' }
    }
    let canonical
    try {
      canonical = canonicalWorkspacePath(this.store.workspace)
    } catch (error) {
      return { enqueued: false, reason: `cannot resolve workspace: ${error.message}` }
    }
    const generation = Number(task.attachGeneration ?? 0) + 1
    const identity = { taskId: task.id, sessionId: task.sessionId, generation }
    try {
      ensureDir(this.attachQueueDir)
      removeLegacyRequest(this.attachQueueDir, task.id)
      const request = renderAttachRequest({
        taskId: task.id,
        sessionId: task.sessionId,
        generation,
        workspace: this.store.workspace,
        title: task.guiWorkspaceTitle ?? null,
        policy,
      })
      writeAttachRequest(this.attachQueueDir, request)
    } catch (error) {
      this.store.appendEvent(task, { type: 'attach_retry_failed', error: truncate(error.message, 500) })
      this.store.saveTask(task)
      return {
        enqueued: false,
        reason: `could not write attach request: ${error.message}`,
        attachQueueDir: this.attachQueueDir,
        guiPolicy: policy,
        sessionId: task.sessionId,
      }
    }
    task.attachGeneration = generation
    task.attachSessionId = task.sessionId
    task.attachQueuedAt = requestPath(this.attachQueueDir, identity, canonical)
    this.store.appendEvent(task, { type: 'attach_retry', generation })
    this.store.saveTask(task)
    return {
      enqueued: true,
      taskId,
      sessionId: task.sessionId,
      guiPolicy: policy,
      attachQueueDir: this.attachQueueDir,
      generation,
    }
  }

  /** Read the GUI plugin heartbeat (plugin-only writer) for astra_status. */
  guiPluginHealth() {
    if (!this.attachQueueDir) return null
    try {
      const heartbeat = readJson(join(this.dshHome, 'astra-dsh', 'heartbeat.json'), null)
      if (!heartbeat || typeof heartbeat !== 'object') return null
      return {
        version: typeof heartbeat.version === 'string' ? heartbeat.version : null,
        heartbeatAt: typeof heartbeat.at === 'string' ? heartbeat.at : null,
        pid: Number.isInteger(heartbeat.pid) ? heartbeat.pid : null,
        stale: typeof heartbeat.at === 'string' && Date.now() - Date.parse(heartbeat.at) > 60_000,
      }
    } catch {
      return null
    }
  }

  /** Read the current GUI attach state for a task, from the durable ACK. */
  guiStatusOf(task) {
    if (!this.attachQueueDir) return { status: ATTACH_STATUS.PRIVATE_HOME, detail: this.dshHomeFallbackReason ?? 'fallback home' }
    const policy = task.guiPolicy ?? DEFAULT_GUI_POLICY
    if (policy === 'off') return { status: ATTACH_STATUS.OFF, detail: 'guiPolicy=off (no GUI delivery)' }
    if (!task.sessionId) return { status: null, detail: 'no session' }
    let canonical
    try {
      canonical = canonicalWorkspacePath(this.store.workspace)
    } catch (error) {
      return { status: null, detail: `workspace does not resolve: ${error.message}` }
    }
    const identity = { taskId: task.id, sessionId: task.sessionId, generation: Number(task.attachGeneration ?? 0) }
    const ack = readAttachAck(this.attachQueueDir, identity, canonical)
    if (ack && validateAttachAck(ack).ok && identityMatches(ack.identity, identity) && ack.canonicalWorkspace === canonical) {
      return { status: ack.status, detail: ack.lastError ?? ack.phase ?? null, ack }
    }
    if (existsSync(requestPath(this.attachQueueDir, identity, canonical))) {
      return { status: ATTACH_STATUS.QUEUED, detail: 'awaiting GUI plugin' }
    }
    if (existsSync(legacyRequestPath(this.attachQueueDir, task.id))) {
      return { status: ATTACH_STATUS.QUEUED, detail: 'awaiting GUI plugin (legacy request)' }
    }
    return { status: null, detail: 'not queued' }
  }

  /**
   * Set model and effort only when the live session does not already match.
   * An explicit model request (and any Flash route) fails closed: silently
   * running the turn on a different model is worse than failing the dispatch.
   */
  async applyModel(client, task, configOptions) {
    const requestedModel = task.model || this.config.model
    const desiredModel = JSON.stringify([this.config.modelProvider, requestedModel])
    const currentModel = findOption(configOptions, 'model')
    const explicit = Boolean(task.model)
    // The requested route is always explicit configuration (task override or
    // ASTRA_DSH_MODEL). A failed model switch must never silently continue on a
    // different model, so every model-selection failure fails closed.
    const failClosed = Boolean(explicit || requestedModel)
    task.requestedModel = requestedModel
    task.modelProvider = this.config.modelProvider
    if (currentModel !== undefined) task.actualModel = currentModel
    if (currentModel !== undefined && currentModel === desiredModel) {
      task.modelSelection = 'matched'
    } else {
      try {
        const result = await client.setConfig({ sessionId: task.sessionId, configId: 'model', value: desiredModel })
        const returned = findOption(result?.configOptions, 'model')
        if (returned !== undefined) {
          task.actualModel = returned
          if (returned !== desiredModel) {
            throw new BridgeError(
              `DSH accepted model ${returned} but ${desiredModel} was requested`,
              { code: 'MODEL_SELECTION_FAILED' },
            )
          }
        }
        if (returned === undefined) task.actualModel = null
        task.modelSelection = returned === undefined ? 'set-unverified' : 'verified'
        task.modelError = null
      } catch (error) {
        const message = truncate(error?.message ?? String(error), 500)
        task.modelError = message
        task.modelSelection = 'failed'
        this.store.appendEvent(task, {
          type: 'model_selection_failed',
          requestedModel,
          desiredModel,
          actualModel: task.actualModel ?? null,
          provider: this.config.modelProvider,
          failClosed,
          error: message,
        })
        try {
          this.store.updateTask(task.id, (fresh) => {
            fresh.requestedModel = requestedModel
            fresh.actualModel = task.actualModel ?? fresh.actualModel ?? null
            fresh.modelSelection = 'failed'
            fresh.modelError = message
            return fresh
          })
        } catch { /* the throw below still fails the dispatch */ }
        if (failClosed) {
          throw new BridgeError(
            `Refusing to continue on an unverified model: ${message}`,
            {
              code: 'MODEL_SELECTION_FAILED',
              details: { requestedModel, actualModel: task.actualModel ?? null, provider: this.config.modelProvider },
            },
          )
        }
        return
      }
    }
    const effort = task.effort || this.config.effort
    const currentEffort = findOption(configOptions, 'reasoning_effort')
    if (effort && currentEffort !== effort) {
      try {
        await client.setConfig({ sessionId: task.sessionId, configId: 'reasoning_effort', value: effort })
        task.effortSelection = 'set'
        task.effortError = null
      } catch (error) {
        task.effortSelection = 'failed'
        task.effortError = truncate(error.message, 300)
        this.store.appendEvent(task, { type: 'effort_selection_failed', message: task.effortError })
      }
    }
  }

  /** Choose host execution when the GUI control plane is healthy; ACP otherwise. */
  async selectExecutionBackend() {
    const configured = this.config.executionBackend ?? 'auto'
    if (configured === 'acp') return { backend: 'acp' }
    const health = await probeHostControl(this.config.hostSocket, { timeoutMs: this.config.hostProbeTimeoutMs })
    const usable = health.available === true
      && health.protocol === 1
      && Array.isArray(health.capabilities)
      && health.capabilities.includes('session.create')
      && health.capabilities.includes('session.follow')
    if (usable) return { backend: 'host', health }
    if (configured === 'host') {
      throw new BridgeError(
        `ASTRA_DSH_EXECUTION_BACKEND=host but host control is unavailable: ${health.error ?? 'protocol/capability mismatch'}`,
        { code: 'HOST_UNAVAILABLE', details: health },
      )
    }
    return { backend: 'acp', reason: health.error ?? 'host control unavailable' }
  }

  /** Begin a host-owned turn. The host Agent owns the Session; the bridge only follows it. */
  async startHostTurn(task, prompt, { lockToken, userMessage = null, create = true } = {}) {
    if (this.active.has(task.id)) {
      throw new BridgeError(`task ${task.id} already has a turn in flight`, { code: 'TASK_RUNNING' })
    }
    task.turnIndex += 1
    task.state = 'running'
    task.phase = 'host:starting'
    task.executionBackend = 'host'
    task.live = true
    task.startedAt = task.startedAt ?? nowIso()
    task.endedAt = null
    task.stopReason = null
    task.error = null
    task.finalText = ''
    task.lastAssistantText = ''
    task.verification = null
    task.autoReview = null
    task.review = null
    task.incident = null
    task.executionMayBeActive = false
    task.lastTool = null
    task.lastHostUpdateAt = nowIso()
    task.queueMessage = userMessage
    task.runner = {
      ...(task.runner ?? {}),
      instance: this.runnerId,
      pid: process.pid,
      turn: task.turnIndex,
      startedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      backend: 'host',
    }
    this.store.saveTask(task)
    this.store.writeTurn(task, task.turnIndex, 'prompt.md', prompt)
    this.store.appendEvent(task, { type: 'turn_start', turn: task.turnIndex, promptChars: prompt.length, followUp: userMessage !== null, backend: 'host' })

    let created = null
    try {
      if (create) {
        created = await this.host.request('create', {
          cwd: this.store.workspace,
          model: task.model || this.config.model,
          provider: this.config.modelProvider,
          reasoningEffort: task.effort || this.config.effort,
          prompt,
        }, { timeoutMs: 60_000 })
        task.sessionId = created.sessionId
        task.hostSessionId = created.sessionId
        task.modelSelection = created.selected ? 'host-selected' : 'host-unverified'
        task.actualModel = created.selected ? `${created.selected.provider ?? this.config.modelProvider}/${created.selected.model ?? (task.model || this.config.model)}` : null
        task.requestedModel = `${this.config.modelProvider}/${task.model || this.config.model}`
        task.modelError = created.selected ? null : 'host did not return a selected model'
        this.store.appendEvent(task, {
          type: 'host_session',
          sessionId: task.sessionId,
          requestedModel: task.requestedModel,
          actualModel: task.actualModel,
        })
      } else {
        if (!task.sessionId) throw new BridgeError('host follow-up has no sessionId', { code: 'HOST_NO_SESSION' })
        await this.host.request('prompt', { sessionId: task.sessionId, text: prompt }, { timeoutMs: 30_000 })
        this.store.appendEvent(task, { type: 'host_prompt', sessionId: task.sessionId, followUp: true })
      }
    } catch (error) {
      task.state = 'failed'
      task.phase = 'failed'
      task.error = `${create ? 'host session creation' : 'host prompt'} failed: ${error?.message ?? String(error)}`
      task.stopReason = 'failed'
      task.executionMayBeActive = false
      this.store.appendEvent(task, { type: create ? 'host_create_failed' : 'host_prompt_failed', error: truncate(task.error, 1000) })
      this.store.releaseLock(lockToken)
      this.store.saveTask(task)
      throw new BridgeError(task.error, { code: error?.code ?? 'HOST_CREATE_FAILED', details: error?.details ?? null })
    }
    task.hostTurn = task.turnIndex
    task.phase = 'host:running'
    this.store.saveTask(task)

    const entry = {
      task,
      sessionId: task.sessionId,
      lockToken,
      startedAt: Date.now(),
      backend: 'host',
      controller: new AbortController(),
      promise: null,
    }
    this.active.set(task.id, entry)
    entry.promise = this.runHostTurn(task, entry)
    return entry
  }

  /** Follow a host-owned turn until turn/end, then settle through the common path. */
  async runHostTurn(task, entry) {
    const current = { text: '', lastMessage: '', turnEnded: false, stopReason: null, error: null, lastTool: null }
    try {
      for await (const frame of this.host.follow(task.sessionId, { signal: entry.controller.signal })) {
        this.onHostFrame(task, current, frame)
        if (current.turnEnded) break
      }
      if (!current.turnEnded) {
        throw new BridgeError('host follow stream ended before turn/end', { code: 'HOST_FOLLOW_ENDED' })
      }
      task.stopReason = current.stopReason ?? 'unknown'
      task.finalText = current.lastMessage || current.text
      task.lastAssistantText = truncate(task.finalText, 6000)
      task.executionMayBeActive = false
      if (current.stopReason === 'cancelled' || task.stopReason === 'cancelled') {
        task.state = 'cancelled'
        task.phase = 'cancelled'
        task.cancelConfirmed = true
      } else if (current.error || current.stopReason === 'error') {
        task.state = 'failed'
        task.phase = 'failed'
        task.error = current.error ?? 'host turn failed'
      } else {
        task.state = 'idle'
        task.phase = 'host:awaiting-astra'
      }
    } catch (error) {
      const cancelled = this.cancelling.has(task.id)
      task.state = cancelled ? 'cancelled' : 'interrupted'
      task.phase = cancelled ? 'cancelled' : 'interrupted'
      task.stopReason = cancelled ? 'cancelled' : 'interrupted'
      task.error = cancelled
        ? 'host turn was cancelled'
        : `host follow failed before turn/end; the host Agent may still be running. ${error?.message ?? String(error)}`.trim()
      task.finalText = current.lastMessage || current.text || ''
      task.lastAssistantText = truncate(task.finalText, 6000)
      task.executionMayBeActive = !cancelled
      task.cancelConfirmed = cancelled
      this.store.appendEvent(task, {
        type: 'host_incident',
        errorCode: error?.code ?? 'HOST_FOLLOW_ERROR',
        error: truncate(task.error, 1000),
        executionMayBeActive: task.executionMayBeActive,
      })
      if (cancelled) this.cancelling.delete(task.id)
    } finally {
      await this.settleHostTurn(task, { current, lockToken: entry.lockToken })
      this.active.delete(task.id)
      if (task.state === 'idle' && !this.shuttingDown && task.queue?.length > 0) {
        await this.startNextQueued(task)
      }
    }
  }

  /** Turn host frames into the same task fields the ACP path exposes. */
  onHostFrame(task, current, frame) {
    task.lastHostUpdateAt = nowIso()
    task.lastAcpUpdateAt = task.lastHostUpdateAt
    task.runner = { ...(task.runner ?? {}), lastHeartbeatAt: nowIso() }
    // Live durable frames arrive wrapped as { type: 'event', event }, while
    // snapshot records use the same wrapper. Unwrap before classifying.
    if (frame?.type === 'event' && frame.event) {
      this.onHostFrame(task, current, frame.event)
      return
    }
    const frameTurn = frame?.data?.turn
    if (Number.isInteger(frameTurn) && Number.isInteger(task.hostTurn) && frameTurn < task.hostTurn) return
    if (frame?.type === 'snapshot') {
      for (const record of Array.isArray(frame.records) ? frame.records : []) {
        // Host history records wrap the durable event: { type: 'event', event }.
        this.onHostFrame(task, current, record?.event ?? record)
      }
      return
    }
    if (frame?.type === 'assistant/message') {
      const message = frame?.data?.message
      const parts = Array.isArray(message?.content) ? message.content : []
      const text = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n').trim()
      if (text) {
        current.text = current.text ? `${current.text}\n${text}` : text
        current.lastMessage = text
        task.lastAssistantText = truncate(current.lastMessage, 6000)
        task.phase = 'host:assistant'
      }
      return
    }
    if (frame?.type === 'turn/end') {
      current.turnEnded = true
      const reason = frame?.data?.reason ?? {}
      current.stopReason = reason.kind ?? 'unknown'
      if (reason.kind === 'error') current.error = reason.error?.message ?? reason.error ?? 'host turn failed'
      task.phase = 'host:turn-end'
      return
    }
    if (typeof frame?.type === 'string' && frame.type.startsWith('tool/')) {
      current.lastTool = frame?.data?.name ?? frame?.data?.tool ?? frame.type
      task.lastTool = current.lastTool
      task.phase = `host:tool:${current.lastTool}`
    }
  }

  /** Settle a host turn through verification, auto-review, result, notification and lock release. */
  async settleHostTurn(task, { current, lockToken }) {
    let changes = null
    let verification = null
    try {
      changes = await this.store.collectChanges(task.baseline)
      task.changedFiles = changes.changedFiles
      task.diffStat = changes.diffStat
      task.headAfter = changes.headAfter ?? task.headAfter
      this.store.writeTaskText(task, 'changes.json', `${JSON.stringify(changes, undefined, 2)}\n`)
    } catch (error) {
      this.store.appendEvent(task, { type: 'changes_failed', error: truncate(error.message, 500) })
    }
    if (task.verifyCommands?.length > 0 && task.state !== 'cancelled' && !task.executionMayBeActive) {
      try {
        verification = await this.runVerification(task)
        task.verification = verification
      } catch (error) {
        verification = { ranAt: nowIso(), ok: false, error: truncate(error.message, 500), checks: [] }
        task.verification = verification
        this.store.appendEvent(task, { type: 'verification_failed', error: truncate(error.message, 500) })
      }
    }
    if (task.reviewMode === 'auto' && task.state === 'idle') {
      try {
        const auto = this.evaluateAutoReview(task, verification, changes)
        task.autoReview = auto
        if (auto.eligible) {
          task.state = 'accepted'
          task.phase = 'accepted'
          task.review = { decision: 'accepted', mode: 'auto', notes: auto.notes, at: nowIso() }
          this.writeReviewArtifact(task)
          this.markRequestState(task, 'done')
          this.store.appendEvent(task, { type: 'auto_review', decision: 'accepted', checks: verification?.checks?.length ?? 0 })
        } else {
          this.store.appendEvent(task, { type: 'auto_review_skipped', reasons: auto.reasons })
        }
      } catch (error) {
        this.store.appendEvent(task, { type: 'auto_review_error', error: truncate(error.message, 500) })
      }
    }
    try {
      const questions = extractQuestions(task.finalText)
      const artifact = renderResultArtifact({
        task,
        changes,
        questions,
        turnResult: task.finalText,
        verification,
        autoReview: task.autoReview,
      })
      this.store.writeTaskText(task, 'result.md', artifact)
      this.store.writeTurn(task, task.turnIndex, 'result.md', artifact)
    } catch (error) {
      this.store.appendEvent(task, { type: 'result_render_failed', error: truncate(error.message, 500) })
    }
    const retainLock = task.executionMayBeActive === true
    task.endedAt = nowIso()
    if (!retainLock) task.lockToken = null
    this.store.saveTask(task)
    this.store.appendEvent(task, {
      type: 'turn_end',
      turn: task.turnIndex,
      state: task.state,
      stopReason: task.stopReason,
      reviewMode: task.reviewMode,
      autoAccepted: task.review?.mode === 'auto',
      executionMayBeActive: task.executionMayBeActive === true,
      backend: 'host',
    })
    if (task.state === 'idle' && task.queue.length === 0) this.enqueueNotification(task, 'settled')
    if (retainLock) {
      this.store.appendEvent(task, { type: 'lock_retained', reason: 'host execution may still be active; refusing a second writer' })
    } else {
      try { if (lockToken) this.store.releaseLock(lockToken) } catch { /* reclaimable */ }
    }
    if (task.state === 'failed' || task.state === 'interrupted') {
      if (task.queue?.length > 0) {
        this.store.appendEvent(task, { type: 'queue_retained', count: task.queue.length, reason: 'abnormal host turn; queued writes wait for Astra' })
      }
    }
  }

  // -------------------------------------------------------------- dispatch

  /**
   * Create a task packet and start its first DSH turn in the background.
   * @param {object} args
   */
  async dispatch(args) {
    // Fail before creating a task record or spawning any ACP prompt.
    this.store.assertNoExecutionRisk()
    const title = requireString(args.title, 'title')
    const goal = requireString(args.goal, 'goal')
    const acceptance = Array.isArray(args.acceptance) && args.acceptance.length > 0
      ? args.acceptance
      : null
    if (!acceptance) {
      throw new BridgeError('acceptance must contain at least one verifiable criterion', { code: 'BAD_TASK' })
    }
    const reviewMode = normalizeReviewMode(args.reviewMode)
    const verifyCommands = normalizeVerifyCommands(args.verifyCommands)
    if (reviewMode === 'auto' && verifyCommands.length === 0) {
      throw new BridgeError('reviewMode=auto requires at least one verifyCommands entry', { code: 'BAD_TASK' })
    }
    const taskKind = normalizeTaskKind(args.taskKind)
    const implementationPlan = requireString(args.implementationPlan, 'implementationPlan')
    const writeScopes = normalizeScopes(args.writeScopes)
    if (taskKind === 'implement' && writeScopes.length === 0) {
      throw new BridgeError('taskKind=implement requires at least one writeScopes entry', { code: 'BAD_TASK' })
    }
    const guiPolicy = normalizeGuiPolicy(args.guiPolicy)
    const guiWorkspaceTitle = typeof args.guiWorkspaceTitle === 'string' && args.guiWorkspaceTitle.trim() !== ''
      ? args.guiWorkspaceTitle.trim()
      : null
    const packet = renderTaskPacket({
      ...args,
      title,
      goal,
      acceptance,
      implementationPlan,
      taskKind,
      writeScopes,
      verifyCommands,
      workspace: this.store.workspace,
    })
    const task = this.store.createTask({
      title,
      packet,
      requestId: args.requestId,
      writeScopes,
      model: args.model,
      effort: args.reasoningEffort ?? args.effort,
      reviewMode,
      verifyCommands,
      taskKind,
      implementationPlan,
      codexThreadId: args.codexThreadId ?? null,
      guiPolicy,
      guiWorkspaceTitle,
      runner: { instance: this.runnerId, pid: process.pid },
    })

    let lock
    try {
      lock = this.store.acquireLock({
        owner: 'dsh',
        taskId: task.id,
        ttlMs: this.config.lockTtlMs,
        note: `DSH executing ${task.id}`,
      })
    } catch (error) {
      task.state = 'failed'
      task.error = `could not start: ${error.message}`
      this.store.appendEvent(task, { type: 'dispatch_failed', message: task.error })
      this.store.saveTask(task)
      throw error
    }

    task.lockToken = lock.token
    task.baseline = await this.store.captureBaseline()
    task.runner.startedAt = nowIso()
    this.store.saveTask(task)

    const selected = await this.selectExecutionBackend()
    task.executionBackend = selected.backend
    task.live = selected.backend === 'host'
    if (selected.backend === 'host') {
      task.guiStatus = 'host-native'
      task.hostVersion = selected.health?.version ?? null
      task.hostPid = selected.health?.pid ?? null
    }
    this.store.saveTask(task)

    const prompt = renderExecutionPrompt({ task, packet })
    if (selected.backend === 'host') {
      try {
        await this.startHostTurn(task, prompt, { lockToken: lock.token, userMessage: null })
        this.markRequestState(task, 'in_progress')
      } catch (error) {
        // startHostTurn already persisted the failure and released the lock.
        throw error
      }
    } else {
      try {
        // Create the session before returning so the planner gets a usable id.
        await this.sessionFor(task)
        this.markRequestState(task, 'in_progress')
      } catch (error) {
        task.state = 'failed'
        task.error = `could not open a DSH session: ${error.message}`
        this.store.appendEvent(task, { type: 'dispatch_failed', message: task.error })
        this.store.releaseLock(lock.token)
        this.store.saveTask(task)
        throw error
      }
      await this.startTurn(task, prompt, { lockToken: lock.token, userMessage: null })
    }

    const monitor = this.watchdogs.status(task.id)
    const notification = this.outbox.summarize(task.id)
    const degraded = []
    if (!task.codexThreadId) degraded.push('no Codex thread id was supplied in MCP _meta; completion cannot wake Astra')
    if (this.config.notifyCodex === false) degraded.push('completion wake-up is disabled by ASTRA_DSH_NOTIFY_CODEX=0')
    else if (!this.config.codexBin) degraded.push('codex binary was not found; completion wake-up is degraded')
    if (!this.config.watchdog) degraded.push('watchdog disabled by ASTRA_DSH_WATCHDOG=0; a bridge crash relies on in-process reconcile only')
    if (monitor.watchdog === 'degraded') degraded.push(monitor.reason)
    return {
      taskId: task.id,
      title: task.title,
      taskKind: task.taskKind ?? 'implement',
      implementationPlan: truncate(task.implementationPlan ?? '', 6000),
      state: task.state,
      sessionId: task.sessionId,
      executionBackend: task.executionBackend ?? 'acp',
      live: task.live === true,
      guiPolicy: task.guiPolicy ?? DEFAULT_GUI_POLICY,
      monitor,
      notification,
      degraded,
      taskFile: join(this.store.taskDir(task.id), 'task.md'),
      message: `DSH task ${task.id} started on ${task.executionBackend ?? 'acp'}${task.live ? ' (native live GUI session)' : ''}. The bridge will notify this Codex thread when it settles; use dsh_status only for diagnostics.${degraded.length ? ` DEGRADED: ${degraded.join('; ')}` : ''}`,
    }
  }

  /** Begin one turn. The returned promise is tracked; errors are recorded on the task. */
  async startTurn(task, prompt, { lockToken, userMessage = null }) {
    if (this.active.has(task.id)) {
      throw new BridgeError(`task ${task.id} already has a turn in flight`, { code: 'TASK_RUNNING' })
    }
    task.turnIndex += 1
    task.state = 'running'
    task.phase = 'starting'
    task.startedAt = task.startedAt ?? nowIso()
    task.endedAt = null
    task.stopReason = null
    task.error = null
    task.finalText = ''
    task.lastAssistantText = ''
    task.verification = null
    task.autoReview = null
    task.review = null
    task.incident = null
    task.executionMayBeActive = false
    task.executionMayBeActiveResolvedAt = null
    task.executionMayBeActiveResolvedTurn = null
    task.stall = null
    task.lastTool = null
    task.lastAcpUpdateAt = nowIso()
    task.lastBridgeHeartbeatAt = nowIso()
    task.queueMessage = userMessage
    task.runner = {
      ...(task.runner ?? {}),
      instance: this.runnerId,
      pid: process.pid,
      turn: task.turnIndex,
      startedAt: nowIso(),
      lastHeartbeatAt: nowIso(),
      acpPid: this.client?.child?.pid ?? task.runner?.acpPid ?? null,
    }
    this.store.saveTask(task)
    this.store.writeTurn(task, task.turnIndex, 'prompt.md', prompt)
    this.store.appendEvent(task, {
      type: 'turn_start',
      turn: task.turnIndex,
      promptChars: prompt.length,
      followUp: userMessage !== null,
    })

    const current = { text: '', lastMessage: '', messageId: null, lastTool: null }
    const entry = {
      task,
      sessionId: task.sessionId,
      lockToken,
      startedAt: Date.now(),
      promise: null,
    }
    this.active.set(task.id, entry)
    // Start the independent sidecar before the prompt so a bridge crash during
    // the very first tool call is still observable.
    await this.watchdogs.start(task)
    entry.promise = this.runTurn(task, prompt, current, lockToken)
    // Return the tracked entry, not the turn promise: dispatch must reply while
    // the turn is still running (the settlement is delivered via the outbox).
    return entry
  }

  async runTurn(task, prompt, current, lockToken) {
    let heartbeat
    let client = null
    try {
      client = await this.sessionFor(task)
      try {
        const acpPid = client?.child?.pid ?? null
        task.runner = { ...(task.runner ?? {}), acpPid, lastHeartbeatAt: nowIso() }
        this.store.updateTask(task.id, (fresh) => {
          fresh.runner = {
            ...(fresh.runner ?? {}),
            instance: this.runnerId,
            pid: process.pid,
            turn: fresh.turnIndex,
            acpPid,
            lastHeartbeatAt: nowIso(),
          }
          return fresh
        })
      } catch { /* monitor metadata must not fail a prompt */ }
      heartbeat = setInterval(() => {
        try {
          this.store.heartbeatLock(lockToken, this.config.lockTtlMs)
        } catch {
          // The lock is advisory; a lost heartbeat must not crash the turn.
        }
      }, 60_000)
      heartbeat.unref?.()

      const result = await client.prompt({
        sessionId: task.sessionId,
        text: prompt,
        onUpdate: (update) => this.onUpdate(task, current, update),
        onPermission: () => this.config.permissionPolicy,
      })
      task.stopReason = result?.stopReason ?? 'unknown'
      task.finalText = current.lastMessage || current.text
      task.lastAssistantText = truncate(task.finalText, 6000)
      task.executionMayBeActive = false
      if (task.stopReason === 'cancelled' || this.cancelling.has(task.id)) {
        task.state = 'cancelled'
        task.phase = 'cancelled'
        task.cancelConfirmed = task.stopReason === 'cancelled'
        const prior = this.store.loadTask(task.id)
        if (this.cancelling.has(task.id) && (prior.executionMayBeActive === true || prior.phase === 'cancel-unconfirmed')) {
          this.clearCancelRisk(task)
        }
        this.cancelling.delete(task.id)
      } else {
        task.state = 'idle'
        task.phase = 'awaiting-astra'
      }
    } catch (error) {
      const cancelled = this.cancelling.has(task.id)
      if (cancelled) {
        const mayBeActive = this.transportMayBeActive(error, client)
        task.state = 'cancelled'
        task.stopReason = 'cancelled'
        task.phase = mayBeActive ? 'cancel-unconfirmed' : 'cancelled'
        task.executionMayBeActive = mayBeActive
        task.cancelConfirmed = !mayBeActive
        if (mayBeActive) {
          task.error = 'Cancellation was requested but the ACP turn did not confirm it stopped; execution may still be active.'
          this.recordTurnIncident(task, current, error, { transport: true, mayActive: true, notify: false })
        } else {
          const prior = this.store.loadTask(task.id)
          if (prior.executionMayBeActive === true || prior.phase === 'cancel-unconfirmed') {
            this.clearCancelRisk(task)
          }
        }
        this.cancelling.delete(task.id)
      } else {
        const transport = isTransportFailure(error)
        const mayBeActive = this.transportMayBeActive(error, client)
        task.state = transport ? 'interrupted' : 'failed'
        task.stopReason = transport ? 'interrupted' : 'failed'
        task.phase = transport ? 'interrupted' : 'failed'
        task.error = transport
          ? `The DSH ACP connection failed before the turn settled${mayBeActive ? '; execution may still be active' : ''}. ${error?.message ?? ''}`.trim()
          : (error?.message ?? String(error))
        task.finalText = current.lastMessage || current.text || ''
        task.lastAssistantText = truncate(task.finalText, 6000)
        task.executionMayBeActive = mayBeActive
        this.recordTurnIncident(task, current, error, { transport, mayActive: mayBeActive })
        this.store.appendEvent(task, {
          type: 'turn_error',
          errorCode: error?.code ?? 'ERROR',
          error: truncate(task.error, 1000),
          executionMayBeActive: mayBeActive,
        })
      }
      if (cancelled) this.store.appendEvent(task, { type: 'turn_error', error: 'cancelled by user' })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      let changes = null
      let verification = null
      try {
        changes = await this.store.collectChanges(task.baseline)
        task.changedFiles = changes.changedFiles
        task.diffStat = changes.diffStat
        task.headAfter = changes.headAfter ?? task.headAfter
        this.store.writeTaskText(task, 'changes.json', `${JSON.stringify(changes, undefined, 2)}\n`)
      } catch (error) {
        this.store.appendEvent(task, { type: 'changes_failed', error: truncate(error.message, 500) })
      }

      // Verification can take minutes. The incident/outbox record was already
      // persisted in the catch path, so Astra can be woken immediately. Skip it
      // entirely when the ACP turn may still be writing to the workspace.
      if (task.verifyCommands?.length > 0 && task.state !== 'cancelled' && !task.executionMayBeActive) {
        try {
          verification = await this.runVerification(task)
          task.verification = verification
        } catch (error) {
          verification = { ranAt: nowIso(), ok: false, error: truncate(error.message, 500), checks: [] }
          task.verification = verification
          this.store.appendEvent(task, { type: 'verification_failed', error: truncate(error.message, 500) })
        }
      }

      if (task.reviewMode === 'auto' && task.state === 'idle') {
        try {
          const auto = this.evaluateAutoReview(task, verification, changes)
          task.autoReview = auto
          if (auto.eligible) {
            task.state = 'accepted'
            task.phase = 'accepted'
            task.review = {
              decision: 'accepted',
              mode: 'auto',
              notes: auto.notes,
              at: nowIso(),
            }
            this.writeReviewArtifact(task)
            this.markRequestState(task, 'done')
            this.store.appendEvent(task, {
              type: 'auto_review',
              decision: 'accepted',
              checks: verification?.checks?.length ?? 0,
            })
          } else {
            this.store.appendEvent(task, {
              type: 'auto_review_skipped',
              reasons: auto.reasons,
            })
          }
        } catch (error) {
          this.store.appendEvent(task, { type: 'auto_review_error', error: truncate(error.message, 500) })
        }
      }

      try {
        const questions = extractQuestions(task.finalText)
        const artifact = renderResultArtifact({
          task,
          changes,
          questions,
          turnResult: task.finalText,
          verification,
          autoReview: task.autoReview,
        })
        this.store.writeTaskText(task, 'result.md', artifact)
        this.store.writeTurn(task, task.turnIndex, 'result.md', artifact)
      } catch (error) {
        this.store.appendEvent(task, { type: 'result_render_failed', error: truncate(error.message, 500) })
      }

      const retainLock = task.executionMayBeActive === true
      task.endedAt = nowIso()
      if (!retainLock) task.lockToken = null
      this.store.saveTask(task)
      this.store.appendEvent(task, {
        type: 'turn_end',
        turn: task.turnIndex,
        state: task.state,
        stopReason: task.stopReason,
        reviewMode: task.reviewMode,
        autoAccepted: task.review?.mode === 'auto',
        executionMayBeActive: task.executionMayBeActive === true,
      })
      // The in-memory queue can predate a message queued *during* this turn.
      // The durable revision is authoritative for the normal end_turn path.
      const latest = this.store.loadTask(task.id)
      task.queue = Array.isArray(latest.queue) ? latest.queue : []
      task.queueRevision = latest.queueRevision ?? task.queueRevision
      // Persist the settle event before dsh_wait can return, so an immediate
      // status call sees notification degradation/receipt state rather than a
      // transient "ok". The outbox id deduplicates any later call.
      if (task.state === 'idle' && task.queue.length === 0) {
        this.enqueueNotification(task, 'settled')
      }
      if (retainLock) {
        this.store.appendEvent(task, {
          type: 'lock_retained',
          reason: 'execution may still be active; refusing a second writer',
        })
      } else {
        try {
          if (lockToken) this.store.releaseLock(lockToken)
        } catch {
          // A stale lock is reclaimable by the next dispatch.
        }
      }
      this.active.delete(task.id)
      await this.watchdogs.stop(task.id, `turn-${task.state}`)

      if (task.state === 'failed' || task.state === 'interrupted') {
        if (task.queue?.length > 0) {
          this.store.appendEvent(task, {
            type: 'queue_retained',
            count: task.queue.length,
            reason: 'abnormal turn; queued writes wait for Astra',
          })
        }
      } else if (task.state === 'idle' && !this.shuttingDown) {
        if (task.queue.length > 0) {
          this.store.appendEvent(task, { type: 'queue_continue', count: task.queue.length })
          await this.startNextQueued(task)
        }
      }
    }
  }

  /** Persist the incident and notification need before slow verification runs. */
  recordTurnIncident(task, current, error, { transport, mayActive, notify = true }) {
    const details = error?.details ?? {}
    const kind = transport
      ? (error?.code === 'ACP_EXITED' || error?.code === 'ACP_SPAWN_FAILED' ? 'acp-exit' : 'acp-disconnect')
      : 'turn-failed'
    try {
      const incident = this.store.writeIncident(task, {
        id: `INC-${task.id}-t${task.turnIndex}-${kind}`,
        kind,
        severity: mayActive ? 'critical' : 'error',
        turn: task.turnIndex,
        sessionId: task.sessionId,
        phase: task.phase,
        lastTool: current.lastTool ?? task.lastTool ?? null,
        partialText: truncate(current.text || current.lastMessage || '', 12_000),
        errorCode: error?.code ?? 'ERROR',
        errorMessage: truncate(error?.message ?? String(error), 2000),
        exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
        signal: details.signal ?? null,
        stderrSummary: truncate(details.stderrSummary ?? '', 1200),
        executionMayBeActive: mayActive,
        runner: task.runner ?? null,
        at: nowIso(),
      })
      task.incident = incident
      task.lastTool = current.lastTool ?? task.lastTool ?? null
      this.store.updateTask(task.id, (fresh) => {
        fresh.incident = incident
        fresh.executionMayBeActive = mayActive
        fresh.executionMayBeActiveResolvedAt = null
        fresh.executionMayBeActiveResolvedTurn = null
        fresh.partialText = truncate(current.text || current.lastMessage || '', 12_000)
        fresh.lastTool = current.lastTool ?? fresh.lastTool ?? null
        return fresh
      })
      this.store.appendEvent(task, {
        type: 'incident',
        kind,
        errorCode: error?.code ?? 'ERROR',
        executionMayBeActive: mayActive,
      })
    } catch (incidentError) {
      try {
        this.store.appendEvent(task, { type: 'incident_write_failed', error: truncate(incidentError.message, 500) })
      } catch { /* last resort */ }
    }
    if (notify) {
      this.enqueueNotification(task, task.state === 'interrupted' ? 'interrupted' : 'failed', {
        detail: `${kind}: ${error?.message ?? 'turn failed'}${mayActive ? ' (execution may still be active)' : ''}`,
      })
    }
  }

  /** Whether an ACP failure could still leave the agent running. */
  transportMayBeActive(error, client) {
    const code = error?.code
    if (['ACP_EXITED', 'ACP_SPAWN_FAILED', 'ACP_DISPOSED'].includes(code)) return false
    if (!isTransportFailure(error)) return false
    const state = pidState(client?.child?.pid)
    return state !== 'dead'
  }

  /** Run bridge-owned verification commands, independent of DSH's self-report. */
  async runVerification(task) {
    const checks = []
    const commands = task.verifyCommands.slice(0, 5)
    for (const command of commands) {
      const started = Date.now()
      const shell = process.platform === 'win32' ? 'cmd' : '/bin/sh'
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
      const result = await runCommand(shell, args, {
        cwd: this.store.workspace,
        timeoutMs: this.config.verifyTimeoutMs,
        maxBytes: 200_000,
      })
      checks.push({
        command,
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: Date.now() - started,
        stdout: truncate(result.stdout, 20_000),
        stderr: truncate(result.stderr, 20_000),
      })
    }
    const verification = {
      ranAt: nowIso(),
      ok: checks.length > 0 && checks.every((check) => !check.timedOut && check.code === 0),
      checks,
    }
    this.store.writeTaskText(task, 'verification.json', `${JSON.stringify(verification, undefined, 2)}\n`)
    this.store.appendEvent(task, {
      type: 'verification',
      ok: verification.ok,
      checks: checks.length,
    })
    return verification
  }

  /** Decide whether a task can be closed without a human/Astra review turn. */
  evaluateAutoReview(task, verification, changes) {
    const reasons = []
    if (task.state !== 'idle') reasons.push(`task state is ${task.state}`)
    if (task.stopReason !== 'end_turn') reasons.push(`stop reason is ${task.stopReason ?? 'unknown'}`)
    if (task.error) reasons.push(`task error: ${truncate(task.error, 300)}`)
    if (task.queue?.length > 0) reasons.push('queued follow-up instructions are pending')
    if (extractQuestions(task.finalText).length > 0) reasons.push('DSH asked one or more questions')
    if (!verification) reasons.push('no verification commands were configured')
    else if (!verification.ok) reasons.push('verification commands did not all pass')

    const changed = changes?.changedFiles ?? []
    const scopes = task.writeScopes ?? []
    if (changed.length > 0 && scopes.length === 0) {
      reasons.push('changed files exist but writeScopes was not declared')
    }
    for (const file of changed) {
      if (scopes.length > 0 && !withinWriteScopes(file.path, scopes)) {
        reasons.push(`changed file is outside writeScopes: ${file.path}`)
      }
    }

    return {
      eligible: reasons.length === 0,
      reasons,
      checkedAt: nowIso(),
      notes: reasons.length === 0
        ? `Auto-accepted: ${verification.checks.length} verification check(s) passed; ${changed.length} file(s) changed.`
        : undefined,
      verificationOk: verification?.ok ?? null,
    }
  }

  /** Persist the review artifact for either an automatic or manual decision. */
  writeReviewArtifact(task) {
    this.store.writeTaskText(
      task,
      'review.md',
      `# Review — ${task.id}\n\n- **Decision:** ${task.review.decision}\n- **Mode:** ${task.review.mode ?? 'manual'}\n- **At:** ${task.review.at}\n\n${task.review.notes ?? ''}\n`,
    )
  }

  /** Keep the parent requirement in sync with the task state. */
  markRequestState(task, state) {
    if (!task.requestId) return
    try {
      const request = this.store.loadRequest(task.requestId)
      request.state = state
      request.linkedTasks = [...new Set([...(request.linkedTasks ?? []), task.id])]
      this.store.saveRequest(request)
    } catch {
      // A dangling request id must not fail the task.
    }
  }

  /**
   * Persist one wake-up event. Completion events may be suppressed while
   * dsh_wait is active; abnormal events are never suppressed. The thread is
   * always the dispatch-time MCP thread stored on the task.
   */
  enqueueNotification(task, kind, { detail = null, episodeAt = null } = {}) {
    const idSuffix = kind === 'suspected-stall' && episodeAt ? episodeAt : null
    if (this.config.notifyCodex === false) {
      this.store.appendEvent(task, { type: 'notify_suppressed', reason: 'ASTRA_DSH_NOTIFY_CODEX=0', kind })
      return null
    }
    if (!task.codexThreadId) {
      const record = this.outbox.markDegraded({
        taskId: task.id,
        turn: task.turnIndex,
        kind,
        idSuffix,
        reason: 'no Codex thread id was captured at dispatch time; Astra cannot be woken for this event',
      })
      this.store.appendEvent(task, { type: 'notify_degraded', kind, reason: record.lastError })
      try {
        this.store.updateTask(task.id, (fresh) => {
          fresh.notificationHealth = 'degraded'
          fresh.notificationDegradedReason = record.lastError
          return fresh
        })
      } catch { /* task may already be gone */ }
      return record
    }
    if (!this.config.codexBin) {
      const record = this.outbox.markDegraded({
        taskId: task.id,
        turn: task.turnIndex,
        kind,
        threadId: task.codexThreadId,
        idSuffix,
        reason: 'codex binary was not found; completion wake-up is degraded',
      })
      this.store.appendEvent(task, { type: 'notify_degraded', kind, reason: record.lastError })
      return record
    }
    if (kind === 'settled' && this.waiters.get(task.id)) {
      this.store.appendEvent(task, { type: 'notify_suppressed', reason: 'dsh_wait active', kind })
      return null
    }
    const message = kind === 'settled'
      ? `DSH task ${task.id} (${task.state}) settled in ${this.store.workspace}. Call dsh_result and dsh_review for it.`
      : `DSH task ${task.id} (${task.state}) needs attention in ${this.store.workspace}. Call dsh_status and dsh_result before deciding next steps.`
    const record = this.outbox.enqueue({
      taskId: task.id,
      turn: task.turnIndex,
      kind,
      threadId: task.codexThreadId,
      message,
      stateAtEnqueue: task.state,
      detail,
      episodeAt,
      idSuffix,
    })
    this.store.appendEvent(task, {
      type: 'notify_enqueued',
      kind,
      notificationId: notificationId(task.id, task.turnIndex, kind, idSuffix),
      threadId: task.codexThreadId,
    })
    return record
  }

  /** Notification summary for one task or the whole workspace. */
  notificationSummary(taskId = null) {
    return this.outbox.summarize(taskId)
  }

  /** Record real ACP progress and close any suspected-stall episode. */
  noteAcpProgress(task) {
    const wasStalled = Boolean(task.stall?.suspectedAt && !task.stall.recoveredAt)
    task.lastAcpUpdateAt = nowIso()
    if (wasStalled) {
      task.stall = {
        ...task.stall,
        recoveredAt: nowIso(),
        recoveryMs: Date.now() - (Date.parse(task.stall.suspectedAt) || Date.now()),
      }
      this.store.appendEvent(task, {
        type: 'stall_recovered',
        suspectedAt: task.stall.suspectedAt,
        quietMs: task.stall.recoveryMs,
      })
    }
    return wasStalled
  }

  onUpdate(task, current, update) {
    const kind = update?.sessionUpdate
    const recovered = this.noteAcpProgress(task)
    switch (kind) {
      case 'agent_message_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : ''
        if (update.messageId !== current.messageId) {
          current.messageId = update.messageId ?? null
          current.lastMessage = ''
        }
        current.lastMessage += text
        current.text += text
        task.lastAssistantText = truncate(current.lastMessage, 6000)
        task.phase = 'responding'
        this.store.appendEvent(task, { type: 'message', text: truncate(text, 4000) })
        this.store.saveTask(task)
        break
      }
      case 'agent_thought_chunk': {
        const text = update.content?.type === 'text' ? update.content.text : ''
        if (text) this.store.appendEvent(task, { type: 'thought', text: truncate(text, 500) })
        break
      }
      case 'tool_call': {
        task.phase = `tool:${update.title ?? 'unknown'}`
        current.lastTool = {
          toolCallId: update.toolCallId ?? null,
          title: update.title ?? null,
          kind: update.kind ?? null,
          at: nowIso(),
        }
        task.lastTool = current.lastTool
        this.store.appendEvent(task, {
          type: 'tool_call',
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind,
          input: truncate(JSON.stringify(update.rawInput ?? {}), 2500),
        })
        this.store.saveTask(task)
        break
      }
      case 'tool_call_update': {
        task.lastAcpUpdateAt = nowIso()
        this.store.appendEvent(task, {
          type: 'tool_result',
          toolCallId: update.toolCallId,
          status: update.status,
          text: toolResultText(update),
        })
        break
      }
      case 'usage_update': {
        task.usage = { used: update.used, size: update.size }
        this.store.saveTask(task)
        break
      }
      case 'plan': {
        this.store.appendEvent(task, { type: 'plan', text: truncate(JSON.stringify(update), 3000) })
        break
      }
      default: {
        this.store.appendEvent(task, { type: 'update', kind: kind ?? 'unknown' })
      }
    }
    if (recovered) this.store.saveTask(task)
  }

  // ------------------------------------------------------------ operations

  /** Send Astra's follow-up, or queue it behind the current turn. */
  async message(taskId, message, { mode = 'queue', force = false } = {}) {
    let task = this.store.loadTask(taskId)
    if (task.state === 'running') {
      this.reconcile(task)
      task = this.store.loadTask(taskId)
    }
    if (!message || !String(message).trim()) {
      throw new BridgeError('message must not be empty', { code: 'BAD_MESSAGE' })
    }
    if (this.executionMayBeActive(task)) {
      const incident = task.incident ?? this.store.readIncident(taskId) ?? null
      if (!force) {
        throw new BridgeError(
          'This task may still be executing after a control-connection failure. Refusing to resume or let a second writer take over until the old DSH/ACP process is verified stopped. Use force=true only after out-of-band verification.',
          { code: 'EXECUTION_MAY_BE_ACTIVE', details: { taskId, incident } },
        )
      }
      // Explicit, non-automatic recovery after the caller verified the old ACP
      // is gone. This is the only path allowed to clear the retained lock.
      const resolved = this.store.resolveIncident(taskId, {
        resolvedBy: 'dsh_message force=true',
        note: 'caller asserted the old DSH/ACP process is stopped',
      })
      const resolvedAt = resolved?.resolvedAt ?? nowIso()
      const cleared = this.store.updateTask(taskId, (fresh) => {
        fresh.executionMayBeActive = false
        fresh.executionMayBeActiveResolvedAt = resolvedAt
        fresh.executionMayBeActiveResolvedTurn = fresh.turnIndex
        fresh.incidentResolvedAt = resolvedAt
        fresh.incident = resolved ?? fresh.incident
        fresh.lockToken = null
        return fresh
      })
      appendEventSafe(this.store, cleared, {
        type: 'incident_resolved',
        resolvedBy: 'dsh_message force=true',
        executionMayBeActive: false,
      })
      if (task.lockToken) {
        const lock = this.store.inspectLock()
        if (lock && lock.owner === 'dsh' && lock.taskId === taskId) {
          try {
            this.store.releaseLock(task.lockToken)
          } catch {
            // A different owner keeps its lock; startNextQueued will report it.
          }
        }
      }
    }
    const record = { id: shortId(3), text: String(message), at: nowIso(), mode }
    if (task.state === 'running') {
      if (mode !== 'interrupt') {
        const latest = this.store.updateTask(taskId, (fresh) => {
          if (fresh.state !== 'running') return fresh
          if (!Array.isArray(fresh.queue)) fresh.queue = []
          fresh.queue.push(record)
          fresh.queueRevision = Number(fresh.queueRevision ?? 0) + 1
          return fresh
        })
        this.store.appendEvent(latest, { type: 'message_queued', messageId: record.id })
        return { taskId, state: latest.state, queued: true, queueLength: latest.queue.length }
      }
      this.cancelling.add(taskId)
      const entry = this.active.get(taskId)
      if (!entry) {
        this.cancelling.delete(taskId)
        const blocked = this.store.updateTask(taskId, (fresh) => {
          fresh.executionMayBeActive = true
          fresh.cancelConfirmed = false
          fresh.cancelRequestedAt = nowIso()
          fresh.phase = 'cancel-unconfirmed'
          return fresh
        })
        this.store.appendEvent(blocked, {
          type: 'cancel_unconfirmed',
          reason: 'this bridge does not own the in-flight turn; lock retained',
        })
        throw new BridgeError(
          'This bridge does not own the in-flight turn, so cancellation cannot be confirmed. The workspace lock is retained.',
          { code: 'CANCEL_UNCONFIRMED', details: { taskId } },
        )
      }
      if (task.executionBackend === 'host') {
        try { await this.host.request('cancel', { sessionId: task.sessionId }, { timeoutMs: 10_000 }) } catch { /* abort still stops follow */ }
        entry.controller?.abort()
      } else {
        this.client?.cancel(task.sessionId)
      }
      await Promise.race([entry.promise, sleep(this.config.cancelGraceMs)])
      if (this.active.has(taskId)) {
        const blocked = this.store.updateTask(taskId, (fresh) => {
          fresh.executionMayBeActive = true
          fresh.cancelConfirmed = false
          fresh.cancelRequestedAt = nowIso()
          fresh.phase = 'cancel-unconfirmed'
          return fresh
        })
        this.store.appendEvent(blocked, {
          type: 'cancel_unconfirmed',
          reason: 'ACP did not settle before the cancel grace period; lock retained',
        })
        throw new BridgeError(
          'Cancellation was requested but ACP did not confirm the turn stopped. Refusing to start another turn or release the lock while execution may still be active.',
          { code: 'CANCEL_UNCONFIRMED', details: { taskId, graceMs: this.config.cancelGraceMs } },
        )
      }
      this.cancelling.delete(taskId)
      const afterCancel = this.store.loadTask(taskId)
      if (this.executionMayBeActive(afterCancel)) {
        throw new BridgeError(
          'The interrupted turn settled without ACP confirming it stopped. Refusing to start another turn while execution may still be active.',
          { code: 'CANCEL_UNCONFIRMED', details: { taskId } },
        )
      }
      // Keep older queued instructions; the interrupt only preempts the turn.
      const latest = this.store.updateTask(taskId, (fresh) => {
        fresh.state = 'idle'
        if (!Array.isArray(fresh.queue)) fresh.queue = []
        fresh.queue.push(record)
        fresh.queueRevision = Number(fresh.queueRevision ?? 0) + 1
        return fresh
      })
      if (!this.active.has(taskId)) await this.startNextQueued(latest)
      return { taskId, state: 'running', queued: false, interrupted: true }
    }

    // Not running: this is a new turn on the same persisted session.
    const latest = this.store.updateTask(taskId, (fresh) => {
      if (!Array.isArray(fresh.queue)) fresh.queue = []
      fresh.queue.push(record)
      fresh.queueRevision = Number(fresh.queueRevision ?? 0) + 1
      return fresh
    })
    await this.startNextQueued(latest)
    const after = this.store.loadTask(taskId)
    if (!this.active.has(taskId)) {
      return {
        taskId,
        state: after.state,
        queued: false,
        blocked: true,
        turn: after.turnIndex,
        executionRisk: this.store.executionRiskSummary(),
      }
    }
    return {
      taskId,
      state: 'running',
      queued: false,
      turn: after.turnIndex,
    }
  }

  async startNextQueued(task) {
    const latest = this.store.loadTask(task.id)
    if (!Array.isArray(latest.queue)) latest.queue = []
    if (this.active.has(latest.id) || latest.queue.length === 0) return
    if (this.executionMayBeActive(latest)) {
      this.store.appendEvent(latest, {
        type: 'queued_turn_blocked',
        message: 'execution may still be active; refusing to start a second writer',
      })
      return
    }
    const record = latest.queue[0]
    this.store.updateTask(latest.id, (fresh) => {
      fresh.queueRevision = Number(fresh.queueRevision ?? 0) + 1
      fresh.queue.shift()
      return fresh
    })
    let lock
    try {
      lock = this.store.acquireLock({
        owner: 'dsh',
        taskId: latest.id,
        ttlMs: this.config.lockTtlMs,
        note: `DSH executing ${latest.id}`,
      })
    } catch (error) {
      const restored = this.store.updateTask(latest.id, (fresh) => {
        fresh.queueRevision = Number(fresh.queueRevision ?? 0) + 1
        fresh.queue.unshift(record)
        fresh.state = 'idle'
        fresh.phase = 'awaiting-astra'
        return fresh
      })
      this.store.appendEvent(restored, { type: 'queued_turn_blocked', message: truncate(error.message, 500) })
      return
    }
    const locked = this.store.updateTask(latest.id, (fresh) => {
      fresh.lockToken = lock.token
      return fresh
    })
    const packet = readText(join(this.store.taskDir(locked.id), 'task.md'), '')
    const prompt = renderExecutionPrompt({ task: locked, packet, message: record.text })
    if (locked.executionBackend === 'host') {
      await this.startHostTurn(locked, prompt, { lockToken: lock.token, userMessage: record.text, create: false })
    } else {
      await this.startTurn(locked, prompt, { lockToken: lock.token, userMessage: record.text })
    }
  }

  /** Late ACP confirmation resolves a previously unconfirmed user cancel. */
  clearCancelRisk(task) {
    const resolvedAt = nowIso()
    const resolved = this.store.resolveIncident(task.id, {
      resolvedBy: 'cancel-confirmed',
      note: 'ACP settled the turn after the cancel grace period',
    })
    task.executionMayBeActive = false
    task.executionMayBeActiveResolvedAt = resolvedAt
    task.executionMayBeActiveResolvedTurn = task.turnIndex
    task.cancelConfirmed = true
    task.phase = 'cancelled'
    if (resolved) task.incident = resolved
    appendEventSafe(this.store, task, {
      type: 'cancel_confirmed_late',
      resolvedAt,
      executionMayBeActive: false,
    })
  }

  async cancel(taskId, { keepQueue = false } = {}) {
    let task = this.store.loadTask(taskId)
    if (task.state === 'running') {
      this.reconcile(task)
      task = this.store.loadTask(taskId)
    }
    const active = this.active.get(taskId)
    let settled = true
    if (task.state === 'running') {
      if (!active) {
        // Another bridge/runner owns the turn (or ownership cannot be proven).
        // Do not pretend it stopped or release its lock.
        settled = false
      } else if (task.executionBackend === 'host') {
        this.cancelling.add(taskId)
        try {
          await this.host.request('cancel', { sessionId: task.sessionId }, { timeoutMs: 10_000 })
        } catch (error) {
          this.store.appendEvent(task, { type: 'host_cancel_failed', error: truncate(error?.message ?? String(error), 500) })
        }
        active.controller.abort()
        await Promise.race([active.promise, sleep(this.config.cancelGraceMs)])
        settled = !this.active.has(taskId)
        if (settled) this.cancelling.delete(taskId)
      } else {
        this.cancelling.add(taskId)
        this.client?.cancel(task.sessionId)
        await Promise.race([active.promise, sleep(this.config.cancelGraceMs)])
        settled = !this.active.has(taskId)
        // On timeout keep `cancelling` set so the eventual ACP failure is still
        // classified as a user cancel, not a fresh incident.
        if (settled) this.cancelling.delete(taskId)
      }
    }
    const latest = this.store.updateTask(taskId, (fresh) => {
      fresh.state = 'cancelled'
      fresh.stopReason = 'cancelled'
      fresh.cancelConfirmed = settled
      fresh.cancelRequestedAt = nowIso()
      if (!settled) {
        fresh.executionMayBeActive = true
        fresh.phase = 'cancel-unconfirmed'
      } else {
        fresh.phase = 'cancelled'
      }
      if (!keepQueue) {
        fresh.queue = []
        fresh.queueRevision = Number(fresh.queueRevision ?? 0) + 1
      }
      fresh.endedAt = nowIso()
      return fresh
    })
    this.store.appendEvent(latest, { type: 'cancelled', keepQueue, confirmed: settled })
    const retainLock = !settled || this.executionMayBeActive(latest)
    if (retainLock) {
      this.store.appendEvent(latest, {
        type: 'lock_retained',
        reason: settled
          ? 'execution may still be active; dsh_cancel did not release the lock'
          : 'ACP did not confirm cancellation before the grace period; lock retained',
      })
    } else {
      for (const token of [task.lockToken, active?.lockToken]) {
        if (!token) continue
        try {
          this.store.releaseLock(token)
        } catch {
          // Not the owner any more.
        }
      }
      try {
        this.store.updateTask(taskId, (fresh) => {
          fresh.lockToken = null
          return fresh
        })
      } catch { /* already gone */ }
    }
    return {
      taskId,
      state: latest.state,
      lockRetained: retainLock,
      cancelConfirmed: !retainLock,
      executionMayBeActive: retainLock,
    }
  }

  /** Block until the current turn settles or the timeout expires. */
  async wait(taskId, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs
    this.waiters.set(taskId, (this.waiters.get(taskId) ?? 0) + 1)
    try {
      while (true) {
        if (signal?.aborted) {
          throw new BridgeError('wait cancelled by the client', { code: 'CANCELLED' })
        }
        const task = this.store.loadTask(taskId)
        this.reconcile(task)
        if (!RUNNING.has(task.state)) {
          return { ...this.statusPayload(task), timedOut: false }
        }
        if (Date.now() >= deadline) {
          return { ...this.statusPayload(task), timedOut: true }
        }
        await sleep(300)
      }
    } finally {
      const remaining = (this.waiters.get(taskId) ?? 1) - 1
      if (remaining > 0) this.waiters.set(taskId, remaining)
      else this.waiters.delete(taskId)
    }
  }

  /** True when the last control failure could have left the turn executing. */
  incidentFor(task) {
    const incident = task.incident ?? this.store.readIncident(task.id)
    if (!incident) return null
    return Number(incident.turn ?? 0) >= Number(task.turnIndex ?? 0) ? incident : null
  }

  executionMayBeActive(task) {
    if (!task) return false
    if (task.executionMayBeActive === true) return true
    try {
      const incident = this.incidentFor(task)
      if (!incident) return false
      // A prior-turn incident cannot describe a newer turn.
      if (Number(incident.turn ?? 0) < Number(task.turnIndex ?? 0)) return false
      if (
        task.executionMayBeActiveResolvedAt
        && Number(task.executionMayBeActiveResolvedTurn ?? -1) === Number(task.turnIndex ?? 0)
        && String(task.executionMayBeActiveResolvedAt) >= String(incident.at ?? '')
      ) {
        return false
      }
      return Boolean(incident.executionMayBeActive)
    } catch {
      return false
    }
  }

  /**
   * Mark an orphaned running task interrupted. We only assert death when the
   * owning PID is definitively gone (never on EPERM/unknown) or when this very
   * runner knows it does not own an active turn. A dead runner is not proof the
   * ACP child is gone, so a live/unverifiable ACP PID sets executionMayBeActive
   * and the workspace lock is retained for a human/Astra decision.
   */
  reconcile(task, { notify = true } = {}) {
    if (task.state !== 'running') return task
    if (this.active.has(task.id)) return task
    const runner = task.runner ?? {}
    const sameInstance = runner.instance === this.runnerId
    const ownerPid = pidState(runner.pid)
    if (!sameInstance && (ownerPid === 'alive' || ownerPid === 'unknown')) {
      // The owner (or a PID that may have been reused) still exists. A stale
      // heartbeat is not enough evidence to declare it dead.
      return task
    }
    const acpPid = runner.acpPid
    const acpStatus = Number.isInteger(acpPid) ? pidState(acpPid) : 'unknown'
    const mayBeActive = sameInstance
      ? (acpStatus === 'alive' || Boolean(this.client?.alive))
      : acpStatus !== 'dead'
    task.state = 'interrupted'
    task.phase = 'interrupted'
    task.stopReason = 'interrupted'
    task.executionMayBeActive = mayBeActive
    task.executionMayBeActiveResolvedAt = null
    task.executionMayBeActiveResolvedTurn = null
    task.error = mayBeActive
      ? 'The bridge that owned this turn exited while DSH may still be executing. Execution may be active; do not resume or start a second writer until it is verified stopped.'
      : 'The bridge that owned this turn exited before it settled. Send dsh_message to resume the session.'
    task.endedAt = nowIso()
    if (mayBeActive) {
      // Keep this task's original lock/token: it is the only signal preventing
      // a concurrent writer while the old ACP turn may still be running. Never
      // adopt an Astra/other-task lock.
      const lock = this.store.inspectLock()
      if (lock && lock.owner === 'dsh' && lock.taskId === task.id) {
        task.lockToken = task.lockToken ?? lock.token ?? null
      }
    }
    try {
      const incident = this.store.writeIncident(task, {
        id: `INC-${task.id}-t${task.turnIndex}-owner-exited`,
        kind: 'owner-exited',
        severity: mayBeActive ? 'critical' : 'error',
        turn: task.turnIndex,
        sessionId: task.sessionId,
        phase: task.phase,
        lastTool: task.lastTool ?? null,
        partialText: truncate(task.lastAssistantText ?? task.finalText ?? '', 12_000),
        errorCode: 'BRIDGE_OWNER_EXITED',
        errorMessage: task.error,
        ownerPid: runner.pid ?? null,
        ownerInstance: runner.instance ?? null,
        acpPid: acpPid ?? null,
        executionMayBeActive: mayBeActive,
        runner,
        at: nowIso(),
      })
      task.incident = incident
    } catch { /* the state transition still matters */ }
    this.store.appendEvent(task, {
      type: 'turn_interrupted',
      reason: sameInstance ? 'runner-lost-turn' : 'owner-exited',
      executionMayBeActive: mayBeActive,
      runnerInstance: runner.instance ?? null,
      ownerPidStatus: ownerPid,
      acpPidStatus: acpStatus,
    })
    this.store.saveTask(task)
    if (notify) {
      this.enqueueNotification(task, 'interrupted', {
        detail: task.error,
      })
    }
    return task
  }

  status(taskId, { events = 25 } = {}) {
    const task = this.store.loadTask(taskId)
    this.reconcile(task)
    return this.statusPayload(task, events)
  }

  statusPayload(task, events = 25) {
    const recent = events > 0
      ? this.store.readEvents(task.id, events).map(compactEvent)
      : []
    const questions = extractQuestions(task.finalText || task.lastAssistantText)
    const gui = this.guiStatusOf(task)
    const incident = this.incidentFor(task)
    const executionMayBeActive = this.executionMayBeActive(task)
    const notification = this.outbox.summarize(task.id)
    const lastActivityAt = task.lastAcpUpdateAt ?? task.startedAt ?? null
    const quietMs = lastActivityAt ? Math.max(0, Date.now() - (Date.parse(lastActivityAt) || Date.now())) : null
    const health = taskHealth(task, {
      incident,
      executionMayBeActive,
      executionRisk: this.store.executionRiskSummary(),
      executionMayBeActiveResolvedAt: task.executionMayBeActiveResolvedAt ?? null,
      executionMayBeActiveResolvedTurn: task.executionMayBeActiveResolvedTurn ?? null,
      cancelConfirmed: task.cancelConfirmed ?? null,
      cancelRequestedAt: task.cancelRequestedAt ?? null,
      notification,
      quietMs,
      stallWarningMs: this.config.stallWarningMs,
    })
    return {
      taskId: task.id,
      title: task.title,
      state: task.state,
      phase: task.phase,
      running: task.state === 'running',
      awaitingAstra: AWAITING.has(task.state),
      turn: task.turnIndex,
      sessionId: task.sessionId,
      executionBackend: task.executionBackend ?? 'acp',
      live: task.live === true,
      hostSessionId: task.hostSessionId ?? null,
      hostVersion: task.hostVersion ?? null,
      hostPid: task.hostPid ?? null,
      model: task.model || this.config.model,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt ?? null,
      endedAt: task.endedAt ?? null,
      stopReason: task.stopReason,
      error: task.error,
      reviewMode: task.reviewMode ?? 'light',
      dshHome: this.dshHome,
      dshHomeFallbackReason: this.dshHomeFallbackReason,
      attachQueueDir: this.attachQueueDir,
      guiPolicy: task.guiPolicy ?? DEFAULT_GUI_POLICY,
      guiStatus: gui.status,
      guiStatusDetail: gui.detail ?? null,
      codexThreadId: task.codexThreadId ?? null,
      notifiedAt: task.notifiedAt ?? null,
      notifyError: task.notifyError ?? null,
      requestedModel: task.requestedModel ?? null,
      actualModel: task.actualModel ?? null,
      modelSelection: task.modelSelection ?? null,
      modelError: task.modelError ?? null,
      lastAcpUpdateAt: task.lastAcpUpdateAt ?? null,
      lastBridgeHeartbeatAt: task.lastBridgeHeartbeatAt ?? null,
      lastTool: task.lastTool ?? null,
      quietMs,
      stall: task.stall ?? null,
      suspectedStall: Boolean(task.stall?.suspectedAt && !task.stall?.recoveredAt),
      incident,
      executionMayBeActive,
      executionRisk: this.store.executionRiskSummary(),
      executionMayBeActiveResolvedAt: task.executionMayBeActiveResolvedAt ?? null,
      executionMayBeActiveResolvedTurn: task.executionMayBeActiveResolvedTurn ?? null,
      cancelConfirmed: task.cancelConfirmed ?? null,
      cancelRequestedAt: task.cancelRequestedAt ?? null,
      notification,
      monitor: this.monitorFor(task),
      health,
      verification: task.verification ?? null,
      autoReview: task.autoReview ?? null,
      queueLength: task.queue?.length ?? 0,
      usage: task.usage ?? null,
      lastAssistantText: truncate(task.lastAssistantText ?? '', 3000),
      questions,
      changedFiles: task.changedFiles ?? [],
      diffStat: task.diffStat ?? '',
      permissionDecisions: task.permissionDecisions ?? [],
      review: task.review ?? null,
      lock: this.store.inspectLock(),
      events: recent,
      nextActions: nextActions(task),
      taskFile: join(this.store.taskDir(task.id), 'task.md'),
      resultFile: join(this.store.taskDir(task.id), 'result.md'),
    }
  }

  result(taskId, { includeDiff = false, maxDiffBytes = 120_000 } = {}) {
    const task = this.store.loadTask(taskId)
    this.reconcile(task)
    const changes = readJson(join(this.store.taskDir(task.id), 'changes.json'), null)
    if (changes && !includeDiff) delete changes.diff
    const gui = this.guiStatusOf(task)
    return {
      taskId: task.id,
      state: task.state,
      title: task.title,
      taskKind: task.taskKind ?? 'implement',
      implementationPlan: truncate(task.implementationPlan ?? '', 6000),
      sessionId: task.sessionId,
      executionBackend: task.executionBackend ?? 'acp',
      live: task.live === true,
      hostVersion: task.hostVersion ?? null,
      guiPolicy: task.guiPolicy ?? DEFAULT_GUI_POLICY,
      guiStatus: gui.status,
      guiStatusDetail: gui.detail ?? null,
      finalText: truncate(task.finalText ?? '', 60_000),
      partialText: truncate(task.partialText ?? '', 12_000),
      incident: this.incidentFor(task),
      executionMayBeActive: this.executionMayBeActive(task),
      executionRisk: this.store.executionRiskSummary(),
      notification: this.outbox.summarize(task.id),
      lastAcpUpdateAt: task.lastAcpUpdateAt ?? null,
      lastBridgeHeartbeatAt: task.lastBridgeHeartbeatAt ?? null,
      lastTool: task.lastTool ?? null,
      questions: extractQuestions(task.finalText),
      changedFiles: task.changedFiles ?? [],
      diffStat: task.diffStat ?? '',
      changes,
      verification: task.verification ?? null,
      autoReview: task.autoReview ?? null,
      reviewMode: task.reviewMode ?? 'light',
      resultMarkdown: truncate(readText(join(this.store.taskDir(task.id), 'result.md'), ''), 60_000),
      review: task.review ?? null,
      taskFile: join(this.store.taskDir(task.id), 'task.md'),
      resultFile: join(this.store.taskDir(task.id), 'result.md'),
    }
  }

  async review(taskId, decision, notes, { continueTask = false } = {}) {
    if (!['accepted', 'changes_requested', 'rejected'].includes(decision)) {
      throw new BridgeError('decision must be accepted, changes_requested, or rejected', { code: 'BAD_REVIEW' })
    }
    const task = this.store.loadTask(taskId)
    if (task.state === 'running') {
      throw new BridgeError(`task ${taskId} is still running; wait for it to settle before reviewing`, { code: 'TASK_RUNNING' })
    }
    task.review = { decision, mode: 'manual', notes: notes ?? '', at: nowIso() }
    task.autoReview = null
    task.state = decision
    task.phase = decision
    task.endedAt = nowIso()
    this.writeReviewArtifact(task)
    this.markRequestState(task, decision === 'accepted' ? 'done' : 'in_progress')
    this.store.appendEvent(task, { type: 'review', decision, mode: 'manual', notes: truncate(notes ?? '', 2000) })
    this.store.saveTask(task)
    if (continueTask && notes) {
      await this.message(taskId, notes)
    }
    return { taskId, state: this.store.loadTask(taskId).state, decision, continueTask }
  }

  async diff({ sinceTaskId, maxBytes = 120_000 } = {}) {
    let baseline
    if (sinceTaskId) {
      baseline = this.store.loadTask(sinceTaskId).baseline
    } else if (this.store.isGit()) {
      baseline = { vcs: 'git', head: null, dirty: [] }
    } else {
      baseline = { vcs: 'files', files: {} }
    }
    return this.store.collectChanges(baseline, maxBytes)
  }

  list({ state } = {}) {
    const tasks = this.store.listTasks({ state })
    for (const task of tasks) this.reconcile(task)
    return tasks.map((task) => {
      const gui = this.guiStatusOf(task)
      return {
        taskId: task.id,
        title: task.title,
        taskKind: task.taskKind ?? 'implement',
        state: task.state,
        turn: task.turnIndex,
        updatedAt: task.updatedAt,
        summary: summarizeTask(task),
        awaitingAstra: AWAITING.has(task.state),
        changedFileCount: task.changedFiles?.length ?? 0,
        reviewMode: task.reviewMode ?? 'light',
        verificationOk: task.verification?.ok ?? null,
        autoReview: task.autoReview ?? null,
        guiPolicy: task.guiPolicy ?? DEFAULT_GUI_POLICY,
        guiStatus: gui.status,
        sessionId: task.sessionId ?? null,
        executionMayBeActive: this.executionMayBeActive(task),
        incidentKind: this.incidentFor(task)?.kind ?? null,
        notificationHealth: this.outbox.summarize(task.id).health,
      }
    })
  }

  /** Stop timers, sidecars, outbox scheduling, and the ACP child. */
  async shutdown() {
    this.shuttingDown = true
    if (this.stallTimer) {
      clearInterval(this.stallTimer)
      this.stallTimer = null
    }
    try { this.outbox.close() } catch { /* already closed */ }
    try { await this.watchdogs.stopAll('bridge-shutdown') } catch { /* best effort */ }
    // Explicit bridge shutdown is allowed to clean up every ACP child this
    // process spawned, including clients retired after a transport fault. The
    // fault-detection path itself never kills a possibly executing ACP.
    const clients = [...this.clients]
    this.clients.clear()
    await Promise.allSettled(clients.map((client) => client.dispose()))
    this.client = null
    this.clientPromise = null
  }
}

/**
 * Controlled environment for the watchdog sidecar. Do not spread process.env:
 * the sidecar needs bridge retry/CLI settings plus the allowlisted process
 * basics, and must not inherit arbitrary credentials from the MCP process.
 * MOCK_* keys are included only because fault-injection tests pass them
 * explicitly through the MCP child env; production normally has none.
 */
export function buildWatchdogEnv(config, sourceEnv = process.env, { dshHome = null } = {}) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS']) {
    if (sourceEnv[key] !== undefined) env[key] = String(sourceEnv[key])
  }
  // Only the mock CLI knobs used by notification fault-injection tests; the
  // sidecar has no reason to inherit arbitrary MOCK_* variables.
  for (const key of ['MOCK_CODEX_OUT', 'MOCK_CODEX_STATE', 'MOCK_CODEX_FAIL_TIMES', 'MOCK_CODEX_SLEEP_MS']) {
    if (sourceEnv[key] !== undefined) env[key] = String(sourceEnv[key])
  }
  env.ASTRA_DSH_WATCHDOG_SIDECAR = '1'
  env.ASTRA_DSH_WATCHDOG = config.watchdog ? '1' : '0'
  env.ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS = String(config.watchdogReadyTimeoutMs)
  env.ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS = String(config.watchdogNotifyBudgetMs)
  env.ASTRA_DSH_WATCHDOG_NOTIFY_MAX_ATTEMPTS = String(config.watchdogNotifyMaxAttempts)
  env.ASTRA_DSH_NOTIFY_CODEX = config.notifyCodex ? '1' : '0'
  env.ASTRA_DSH_NOTIFY_RETRY_BASE_MS = String(config.notifyRetryBaseMs)
  env.ASTRA_DSH_NOTIFY_RETRY_MAX_MS = String(config.notifyRetryMaxMs)
  env.ASTRA_DSH_NOTIFY_LEASE_MS = String(config.notifyLeaseMs)
  env.ASTRA_DSH_NOTIFY_CLI_TIMEOUT_MS = String(config.notifyCliTimeoutMs)
  env.ASTRA_DSH_DSH_BIN = String(config.dshBin)
  if (config.codexBin) env.ASTRA_DSH_CODEX_BIN = String(config.codexBin)
  if (config.credentialsSource) env.ASTRA_DSH_CREDENTIALS = String(config.credentialsSource)
  env.ASTRA_DSH_DSH_HOME = dshHome ?? config.dshHome ?? sourceEnv.ASTRA_DSH_DSH_HOME ?? ''
  if (sourceEnv.ASTRA_DSH_HOME) env.ASTRA_DSH_HOME = String(sourceEnv.ASTRA_DSH_HOME)
  return env
}

function appendEventSafe(store, task, event) {
  try {
    store.appendEvent(task, event)
  } catch {
    // Diagnostics must never block an explicit recovery.
  }
}

function taskHealth(task, { incident, executionMayBeActive, notification, quietMs, stallWarningMs }) {
  const reasons = []
  let status = 'ok'
  let severity = 'info'
  if (executionMayBeActive) {
    status = 'execution-may-be-active'
    severity = 'critical'
    reasons.push('control connection failed while the ACP turn may still be running; a lock is retained')
  } else if (task.state === 'interrupted') {
    status = 'interrupted'
    severity = 'error'
    reasons.push('the bridge lost the turn before it settled')
  } else if (task.state === 'failed') {
    status = 'failed'
    severity = 'error'
    reasons.push(task.error ? truncate(task.error, 300) : 'the turn failed')
  } else if (task.state === 'running' && task.stall?.suspectedAt && !task.stall?.recoveredAt) {
    status = 'suspected-stall'
    severity = 'warning'
    reasons.push(`no ACP update for ${Math.round((quietMs ?? task.stall.quietMs ?? 0) / 1000)}s; still running, not cancelled`)
  } else if (task.state === 'running') {
    status = 'running'
    severity = 'info'
  }
  if (notification?.health === 'degraded') {
    if (status === 'ok') status = 'notification-degraded'
    severity = severity === 'info' ? 'warning' : severity
    reasons.push(notification.lastError ?? 'notification delivery is degraded')
  } else if (notification?.health === 'retrying' && status === 'ok') {
    status = 'notification-retrying'
    severity = 'warning'
    reasons.push('completion wake-up is retrying after a CLI failure')
  }
  if (incident?.at && !reasons.length) reasons.push(`${incident.kind ?? 'incident'} at ${incident.at}`)
  return { status, severity, reasons, executionMayBeActive: Boolean(executionMayBeActive), incidentAt: incident?.at ?? null }
}

const TRANSPORT_FAILURES = new Set([
  'ACP_EXITED',
  'ACP_DISPOSED',
  'ACP_NOT_RUNNING',
  'ACP_SPAWN_FAILED',
  'ACP_STDIN_ERROR',
  'ACP_STREAM_CLOSED',
  'ACP_STREAM_ERROR',
  'ACP_PROTOCOL_CORRUPT',
])

function isTransportFailure(error) {
  return TRANSPORT_FAILURES.has(error?.code)
}

function normalizeTaskKind(value) {
  if (value === undefined || value === null || value === '') return 'implement'
  if (!['implement', 'verify'].includes(value)) {
    throw new BridgeError('taskKind must be implement or verify', { code: 'BAD_TASK' })
  }
  return value
}

function normalizeScopes(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new BridgeError('writeScopes must be an array of workspace-relative paths', { code: 'BAD_TASK' })
  }
  return value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
}

function normalizeReviewMode(value) {
  if (value === undefined || value === null || value === '') return 'light'
  if (!['auto', 'light', 'full'].includes(value)) {
    throw new BridgeError('reviewMode must be auto, light, or full', { code: 'BAD_TASK' })
  }
  return value
}

function normalizeVerifyCommands(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new BridgeError('verifyCommands must be an array of shell commands', { code: 'BAD_TASK' })
  }
  const commands = value
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)
  if (commands.length > 5) {
    throw new BridgeError('verifyCommands accepts at most 5 commands', { code: 'BAD_TASK' })
  }
  for (const command of commands) {
    if (command.length > 2000) {
      throw new BridgeError('one verifyCommands entry is longer than 2000 characters', { code: 'BAD_TASK' })
    }
  }
  return commands
}

function withinWriteScopes(file, scopes) {
  const normalized = String(file).replace(/^\.\//, '').replace(/\/+$/, '')
  return scopes.some((scope) => {
    const value = String(scope).replace(/^\.\//, '').replace(/\/+$/, '')
    return normalized === value || normalized.startsWith(`${value}/`)
  })
}

function isWritableDir(dir) {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function findOption(configOptions, id) {
  if (!Array.isArray(configOptions)) return undefined
  const option = configOptions.find((entry) => entry?.id === id)
  return option?.currentValue
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BridgeError(`${field} is required`, { code: 'BAD_TASK' })
  }
  return value.trim()
}

function compactEvent(event) {
  const out = { t: event.t, type: event.type }
  if (event.text) out.text = truncate(event.text, 600)
  if (event.title) out.title = event.title
  if (event.status) out.status = event.status
  if (event.turn) out.turn = event.turn
  if (event.state) out.state = event.state
  if (event.stopReason) out.stopReason = event.stopReason
  if (event.error) out.error = truncate(event.error, 600)
  if (event.decision) out.decision = event.decision
  return out
}

function nextActions(task) {
  switch (task.state) {
    case 'running':
      return ['dsh_status for progress', 'dsh_cancel to stop']
    case 'idle':
      return ['dsh_result to read the full report', 'dsh_message to answer a question or request changes', 'dsh_review to record acceptance']
    case 'changes_requested':
      return ['dsh_message to send the next instruction', 'dsh_review accepted when satisfied']
    case 'failed':
      return ['dsh_result to inspect the failure', 'dsh_message to resume the session']
    case 'interrupted':
      return task.executionMayBeActive
        ? ['verify the old DSH/ACP process is stopped before resuming', 'dsh_status to inspect the incident and retained lock']
        : ['dsh_result to inspect the incident', 'dsh_message to resume the session']
    case 'cancelled':
      return ['dsh_message to resume with new instructions']
    default:
      return []
  }
}
