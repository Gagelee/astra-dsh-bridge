/**
 * The execution side of the bridge: turns durable task records into DSH ACP
 * sessions, streams progress back into the shared task board, and keeps the
 * workspace single-writer lock honest.
 */

import { accessSync, constants, copyFileSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AcpClient } from './acp-client.mjs'
import { extractQuestions, renderExecutionPrompt, renderResultArtifact, renderTaskPacket, summarizeTask } from './packet.mjs'
import { BridgeError, ensureDir, isPidAlive, nowIso, readJson, readText, runCommand, shortId, sleep, truncate, writeJson } from './util.mjs'

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
    this.active = new Map()
    this.cancelling = new Set()
    this.shuttingDown = false
    this.waiters = new Map()
    this.pendingNotifications = new Map()
    this.notificationTimer = null

    // Prefer the configured DSH home (installed setups point at ~/.dsh so the
    // DSH GUI can list these sessions). If Codex's sandbox denies writes there,
    // fall back to a workspace-scoped home so execution still works.
    this.fallbackDshHome = join(store.root, 'dsh-home')
    this.dshHome = config.dshHome ?? this.fallbackDshHome
    this.dshHomeFallbackReason = null
    if (this.dshHome !== this.fallbackDshHome) {
      try {
        ensureDir(this.dshHome)
      } catch (error) {
        this.dshHomeFallbackReason = `cannot write ${this.dshHome}: ${error.message}`
        this.dshHome = this.fallbackDshHome
      }
      if (!this.dshHomeFallbackReason && !isWritableDir(this.dshHome)) {
        this.dshHomeFallbackReason = `cannot write ${this.dshHome} (sandbox denial)`
        this.dshHome = this.fallbackDshHome
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
    try {
      return await this.spawnClientAt(this.dshHome)
    } catch (error) {
      const canFallback = this.dshHome !== this.fallbackDshHome
        && ['ACP_EXITED', 'ACP_TIMEOUT', 'ACP_SPAWN_FAILED'].includes(error?.code)
      if (!canFallback) throw error
      this.dshHomeFallbackReason = `ACP failed with ${this.dshHome}: ${error.message}`
      this.dshHome = this.fallbackDshHome
      this.attachQueueDir = null
      this.childEnv.DSH_HOME = this.dshHome
      this.prepareCredentials()
      return this.spawnClientAt(this.dshHome)
    }
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
    client.on('exit', () => {
      // The prompt promise rejects and the owning task records the interruption.
      this.client = null
      this.clientPromise = null
    })
    try {
      await client.initialize()
    } catch (error) {
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

  /** Ask the GUI-side workspace-attach plugin to group this session under its project. */
  enqueueAttach(task) {
    if (!this.attachQueueDir || !task.sessionId) return
    if (task.attachQueuedAt === this.attachQueueDir) return
    try {
      ensureDir(this.attachQueueDir)
      writeJson(join(this.attachQueueDir, `${task.id}.json`), {
        workspace: this.store.workspace,
        sessionId: task.sessionId,
        title: task.title,
        taskId: task.id,
        createdAt: nowIso(),
      })
      task.attachQueuedAt = this.attachQueueDir
      this.store.appendEvent(task, { type: 'attach_queued', sessionId: task.sessionId })
      this.store.saveTask(task)
    } catch (error) {
      this.store.appendEvent(task, { type: 'attach_queue_failed', error: truncate(error.message, 500) })
    }
  }

  /** Set model and effort only when the live session does not already match. */
  async applyModel(client, task, configOptions) {
    const desiredModel = JSON.stringify([this.config.modelProvider, task.model || this.config.model])
    const currentModel = findOption(configOptions, 'model')
    if (currentModel !== undefined && currentModel === desiredModel) {
      // Already on the requested route.
    } else {
      try {
        await client.setConfig({ sessionId: task.sessionId, configId: 'model', value: desiredModel })
      } catch (error) {
        this.store.appendEvent(task, { type: 'model_selection_failed', message: truncate(error.message, 300) })
      }
    }
    const effort = task.effort || this.config.effort
    const currentEffort = findOption(configOptions, 'reasoning_effort')
    if (effort && currentEffort !== effort) {
      try {
        await client.setConfig({ sessionId: task.sessionId, configId: 'reasoning_effort', value: effort })
      } catch (error) {
        this.store.appendEvent(task, { type: 'effort_selection_failed', message: truncate(error.message, 300) })
      }
    }
  }

  // -------------------------------------------------------------- dispatch

  /**
   * Create a task packet and start its first DSH turn in the background.
   * @param {object} args
   */
  async dispatch(args) {
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

    const prompt = renderExecutionPrompt({ task, packet })
    this.startTurn(task, prompt, { lockToken: lock.token, userMessage: null })

    return {
      taskId: task.id,
      title: task.title,
      taskKind: task.taskKind ?? 'implement',
      implementationPlan: truncate(task.implementationPlan ?? '', 6000),
      state: task.state,
      sessionId: task.sessionId,
      taskFile: join(this.store.taskDir(task.id), 'task.md'),
      message: `DSH task ${task.id} started. Poll with dsh_status or block with dsh_wait.`,
    }
  }

  /** Begin one turn. The returned promise is tracked; errors are recorded on the task. */
  startTurn(task, prompt, { lockToken, userMessage = null }) {
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
    task.queueMessage = userMessage
    this.store.saveTask(task)
    this.store.writeTurn(task, task.turnIndex, 'prompt.md', prompt)
    this.store.appendEvent(task, {
      type: 'turn_start',
      turn: task.turnIndex,
      promptChars: prompt.length,
      followUp: userMessage !== null,
    })

    const current = { text: '', lastMessage: '', messageId: null }
    const entry = {
      task,
      sessionId: task.sessionId,
      lockToken,
      startedAt: Date.now(),
      promise: null,
    }
    entry.promise = this.runTurn(task, prompt, current, lockToken)
    this.active.set(task.id, entry)
    return entry.promise
  }

  async runTurn(task, prompt, current, lockToken) {
    let heartbeat
    try {
      const client = await this.sessionFor(task)
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
      if (task.stopReason === 'cancelled' || this.cancelling.has(task.id)) {
        task.state = 'cancelled'
        task.phase = 'cancelled'
      } else {
        task.state = 'idle'
        task.phase = 'awaiting-astra'
      }
    } catch (error) {
      if (this.cancelling.has(task.id)) {
        task.state = 'cancelled'
        task.stopReason = 'cancelled'
        task.phase = 'cancelled'
      } else if (['ACP_EXITED', 'ACP_DISPOSED', 'ACP_NOT_RUNNING'].includes(error?.code)) {
        task.state = 'interrupted'
        task.stopReason = 'interrupted'
        task.phase = 'interrupted'
        task.error = 'The DSH process exited before the turn settled. Send dsh_message to resume the session.'
      } else {
        task.state = 'failed'
        task.phase = 'failed'
        task.error = error?.message ?? String(error)
        task.finalText = current.lastMessage || current.text || ''
        task.lastAssistantText = truncate(task.finalText, 6000)
      }
      this.store.appendEvent(task, { type: 'turn_error', error: truncate(task.error, 1000) })
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

      if (task.verifyCommands?.length > 0 && task.state !== 'cancelled') {
        try {
          verification = await this.runVerification(task)
          task.verification = verification
        } catch (error) {
          verification = { ranAt: nowIso(), ok: false, error: truncate(error.message, 500), checks: [] }
          task.verification = verification
          this.store.appendEvent(task, { type: 'verification_failed', error: truncate(error.message, 500) })
        }
      }

      if (task.reviewMode === 'auto') {
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

      task.endedAt = nowIso()
      task.lockToken = null
      this.store.saveTask(task)
      this.store.appendEvent(task, {
        type: 'turn_end',
        turn: task.turnIndex,
        state: task.state,
        stopReason: task.stopReason,
        reviewMode: task.reviewMode,
        autoAccepted: task.review?.mode === 'auto',
      })
      try {
        if (lockToken) this.store.releaseLock(lockToken)
      } catch {
        // A stale lock is reclaimable by the next dispatch.
      }
      this.active.delete(task.id)
      this.notifyCodex(task)

      if (!this.shuttingDown && task.state !== 'cancelled' && task.queue.length > 0) {
        await this.startNextQueued(task)
      }
    }
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

  /** Queue a same-thread Codex wake-up once a task needs Astra's attention. */
  notifyCodex(task) {
    if (this.config.notifyCodex === false) return
    if (!this.config.codexBin || !task.codexThreadId) return
    if (this.waiters.get(task.id)) return
    if (!['idle', 'failed', 'interrupted'].includes(task.state)) return
    if (task.queue?.length) return
    const pending = this.pendingNotifications.get(task.codexThreadId) ?? new Set()
    pending.add(task.id)
    this.pendingNotifications.set(task.codexThreadId, pending)
    if (this.notificationTimer === null) {
      this.notificationTimer = setTimeout(() => {
        this.notificationTimer = null
        void this.flushNotifications()
      }, 1500)
      this.notificationTimer.unref?.()
    }
  }

  /** Coalesce settled tasks per Codex thread and queue one message. */
  async flushNotifications() {
    if (this.shuttingDown) return
    const pending = this.pendingNotifications
    this.pendingNotifications = new Map()
    for (const [threadId, ids] of pending) {
      const tasks = [...ids].map((id) => {
        try {
          return this.store.loadTask(id)
        } catch {
          return null
        }
      }).filter(Boolean)
      if (tasks.length === 0) continue
      const summary = tasks.map((task) => `${task.id} (${task.state})`).join(', ')
      const message = `DSH task${tasks.length > 1 ? 's' : ''} ${summary} settled in ${this.store.workspace}. Call dsh_result and dsh_review for ${tasks.length > 1 ? 'each' : 'it'}.`
      let result
      try {
        result = await runCommand(this.config.codexBin, ['queue', '--thread', threadId, '--message', message], {
          timeoutMs: 30_000,
          maxBytes: 100_000,
        })
      } catch (error) {
        for (const task of tasks) {
          task.notifyError = truncate(error.message, 500)
          this.store.appendEvent(task, { type: 'notify_failed', error: task.notifyError })
          this.store.saveTask(task)
        }
        continue
      }
      for (const task of tasks) {
        if (result.code === 0) {
          task.notifiedAt = nowIso()
          task.notifyError = null
          this.store.appendEvent(task, { type: 'notify_queued', threadId })
        } else {
          task.notifyError = truncate((result.stderr || result.stdout || `exit ${result.code}`).trim(), 500)
          this.store.appendEvent(task, { type: 'notify_failed', error: task.notifyError })
        }
        this.store.saveTask(task)
      }
    }
  }

  onUpdate(task, current, update) {
    const kind = update?.sessionUpdate
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
  }

  // ------------------------------------------------------------ operations

  /** Send Astra's follow-up, or queue it behind the current turn. */
  async message(taskId, message, { mode = 'queue' } = {}) {
    const task = this.store.loadTask(taskId)
    if (!message || !String(message).trim()) {
      throw new BridgeError('message must not be empty', { code: 'BAD_MESSAGE' })
    }
    const record = { id: shortId(3), text: String(message), at: nowIso(), mode }
    if (task.state === 'running') {
      if (mode !== 'interrupt') {
        task.queue.push(record)
        this.store.saveTask(task)
        this.store.appendEvent(task, { type: 'message_queued', messageId: record.id })
        return { taskId, state: task.state, queued: true, queueLength: task.queue.length }
      }
      this.cancelling.add(taskId)
      this.client?.cancel(task.sessionId)
      const entry = this.active.get(taskId)
      if (entry) await Promise.race([entry.promise, sleep(20_000)])
      this.cancelling.delete(taskId)
      // Keep older queued instructions; the interrupt only preempts the turn.
      const latest = this.store.loadTask(taskId)
      latest.state = 'idle'
      latest.queue.push(record)
      this.store.saveTask(latest)
      if (!this.active.has(taskId)) await this.startNextQueued(latest)
      return { taskId, state: 'running', queued: false, interrupted: true }
    }

    // Not running: this is a new turn on the same persisted session.
    task.queue.push(record)
    this.store.saveTask(task)
    await this.startNextQueued(task)
    return {
      taskId,
      state: 'running',
      queued: false,
      turn: this.store.loadTask(taskId).turnIndex,
    }
  }

  async startNextQueued(task) {
    const latest = this.store.loadTask(task.id)
    if (this.active.has(latest.id) || latest.queue.length === 0) return
    const record = latest.queue.shift()
    this.store.saveTask(latest)
    let lock
    try {
      lock = this.store.acquireLock({
        owner: 'dsh',
        taskId: latest.id,
        ttlMs: this.config.lockTtlMs,
        note: `DSH executing ${latest.id}`,
      })
    } catch (error) {
      latest.queue.unshift(record)
      latest.state = 'idle'
      latest.phase = 'awaiting-astra'
      this.store.appendEvent(latest, { type: 'queued_turn_blocked', message: truncate(error.message, 500) })
      this.store.saveTask(latest)
      return
    }
    latest.lockToken = lock.token
    this.store.saveTask(latest)
    const packet = readText(join(this.store.taskDir(latest.id), 'task.md'), '')
    this.startTurn(latest, renderExecutionPrompt({ task: latest, packet, message: record.text }), {
      lockToken: lock.token,
      userMessage: record.text,
    })
  }

  async cancel(taskId, { keepQueue = false } = {}) {
    const task = this.store.loadTask(taskId)
    const active = this.active.get(taskId)
    if (task.state === 'running') {
      this.cancelling.add(taskId)
      if (active) this.client?.cancel(task.sessionId)
      if (active) await Promise.race([active.promise, sleep(20_000)])
      this.cancelling.delete(taskId)
    }
    const latest = this.store.loadTask(taskId)
    latest.state = 'cancelled'
    latest.phase = 'cancelled'
    latest.stopReason = 'cancelled'
    if (!keepQueue) latest.queue = []
    latest.endedAt = nowIso()
    this.store.saveTask(latest)
    this.store.appendEvent(latest, { type: 'cancelled', keepQueue })
    for (const token of [task.lockToken, active?.lockToken]) {
      if (!token) continue
      try {
        this.store.releaseLock(token)
      } catch {
        // Not the owner any more.
      }
    }
    return { taskId, state: latest.state }
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

  /** Mark an orphaned running task as interrupted when its owner process is gone. */
  reconcile(task) {
    if (task.state !== 'running') return task
    if (this.active.has(task.id)) return task
    const pid = task.runner?.pid
    const sameInstance = task.runner?.instance === this.runnerId
    if (!sameInstance && Number.isInteger(pid) && isPidAlive(pid)) return task
    task.state = 'interrupted'
    task.phase = 'interrupted'
    task.stopReason = 'interrupted'
    task.error = task.error ?? 'The bridge that owned this turn exited before it settled. Send dsh_message to resume the session.'
    task.endedAt = nowIso()
    this.store.appendEvent(task, { type: 'turn_interrupted', reason: 'owner-exited' })
    this.store.saveTask(task)
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
    return {
      taskId: task.id,
      title: task.title,
      state: task.state,
      phase: task.phase,
      running: task.state === 'running',
      awaitingAstra: AWAITING.has(task.state),
      turn: task.turnIndex,
      sessionId: task.sessionId,
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
      codexThreadId: task.codexThreadId ?? null,
      notifiedAt: task.notifiedAt ?? null,
      notifyError: task.notifyError ?? null,
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
    return {
      taskId: task.id,
      state: task.state,
      title: task.title,
      taskKind: task.taskKind ?? 'implement',
      implementationPlan: truncate(task.implementationPlan ?? '', 6000),
      sessionId: task.sessionId,
      finalText: truncate(task.finalText ?? '', 60_000),
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
    return tasks.map((task) => ({
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
    }))
  }

  /** Stop the ACP child and timers without touching persisted task state. */
  async shutdown() {
    this.shuttingDown = true
    try {
      await this.client?.dispose()
    } catch {
      // Best effort on process exit.
    }
    this.client = null
    this.clientPromise = null
  }
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
      return ['dsh_wait to block for completion', 'dsh_status for progress', 'dsh_cancel to stop']
    case 'idle':
      return ['dsh_result to read the full report', 'dsh_message to answer a question or request changes', 'dsh_review to record acceptance']
    case 'changes_requested':
      return ['dsh_message to send the next instruction', 'dsh_review accepted when satisfied']
    case 'failed':
    case 'interrupted':
      return ['dsh_message to resume the session', 'dsh_result to inspect the failure']
    case 'cancelled':
      return ['dsh_message to resume with new instructions']
    default:
      return []
  }
}
