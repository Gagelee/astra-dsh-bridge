import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { WorkspaceStore } from '../src/store.mjs'
import { isPidAlive, nowIso, sleep } from '../src/util.mjs'
import {
  MOCK_ACP_FAULTS,
  MOCK_CODEX,
  MOCK_CODEX_OUT,
  makeWorkspace,
  readMockCodexCalls,
  readNotifications,
  readTaskFile,
  readTaskRecord,
  startMcp,
  waitFor,
} from './helpers.mjs'

chmodSync(MOCK_ACP_FAULTS, 0o755)

function faultEnv(workspace, extra = {}) {
  return {
    ASTRA_DSH_DSH_BIN: MOCK_ACP_FAULTS,
    ASTRA_DSH_DSH_HOME: join(workspace, '.astra-dsh', 'mock-dsh-home'),
    ASTRA_DSH_HOME: join(workspace, '.mock-bridge-home'),
    ASTRA_DSH_CREDENTIALS: join(workspace, 'missing-credentials.yaml'),
    ASTRA_DSH_MODEL: 'mock-model',
    ASTRA_DSH_EFFORT: 'low',
    ASTRA_DSH_PERMISSION_POLICY: 'allow',
    ASTRA_DSH_CODEX_BIN: MOCK_CODEX,
    ASTRA_DSH_NOTIFY_CODEX: '1',
    ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '30',
    ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '200',
    ASTRA_DSH_NOTIFY_LEASE_MS: '1000',
    ASTRA_DSH_PROGRESS_HEARTBEAT_MS: '50',
    ASTRA_DSH_STALL_WARN_MS: '0',
    ASTRA_DSH_WATCHDOG: '1',
    MOCK_CODEX_OUT: MOCK_CODEX_OUT(workspace),
    ...extra,
  }
}

async function newBridge(prefix, extra = {}) {
  const workspace = await makeWorkspace(prefix)
  writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
  const mcp = startMcp({ cwd: workspace, env: faultEnv(workspace, extra) })
  await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
  return { workspace, mcp, env: faultEnv(workspace, extra) }
}

function dispatchArgs(workspace, goal = 'Use the mock fault agent.') {
  return {
    workspace,
    title: 'Resilience task',
    goal,
    implementationPlan: 'Exercise one mock turn.',
    acceptance: ['the mock turn settles'],
    writeScopes: ['dsh-output.txt'],
  }
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.on('exit', resolve))
  return child.pid
}

function notificationFor(workspace, taskId, kind) {
  return readNotifications(workspace).find((record) => record.taskId === taskId && record.kind === kind) ?? null
}

describe('interruption awareness', () => {
  it('settles a prompt on ACP exit, keeps partial output, wakes the same thread, and does not run queued writes', async () => {
    const { workspace, mcp } = await newBridge('astra-res-interrupt-', { MOCK_FAULT: 'exit-during-prompt' })
    try {
      const threadId = 'thread-resume-interrupt'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Exit during the turn.'), {
        threadId,
        sessionId: threadId,
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      const taskId = dispatched.structured.taskId

      const queued = await mcp.call('dsh_message', {
        workspace,
        taskId,
        message: 'This queued write must not start after an abnormal turn.',
      })
      assert.equal(queued.isError, false, queued.text)
      assert.equal(queued.structured.queued, true)

      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 20 })
      assert.equal(waited.structured.state, 'interrupted')
      assert.equal(waited.structured.executionMayBeActive, false)
      assert.match(waited.structured.lastAssistantText, /PARTIAL_OUTPUT/)
      assert.match(waited.structured.incident.errorMessage, /exited/i)
      assert.equal(waited.structured.incident.kind, 'acp-exit')
      assert.equal(waited.structured.incident.exitCode, 7)
      assert.match(waited.structured.incident.partialText, /PARTIAL_OUTPUT/)
      assert.ok(!String(waited.structured.incident.stderrSummary).includes('sk-abcdefghijklmnop'))
      assert.match(waited.structured.incident.stderrSummary, /redacted/)

      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.queue.length, 1, 'queued instruction is retained for Astra')
      assert.equal(stored.turnIndex, 1)
      await sleep(500)
      const still = readTaskRecord(workspace, taskId)
      assert.equal(still.turnIndex, 1, 'an abnormal turn must not auto-start the queue')
      const prompts = readTaskFile(workspace, taskId, 'fault-prompts.jsonl')
      // The ACP fixture writes its marker into the workspace cwd.
      const fixturePrompts = readFileSync(join(workspace, 'fault-prompts.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      assert.equal(fixturePrompts.length, 1)
      assert.equal(prompts, null)
      assert.ok(existsSync(join(workspace, '.astra-dsh', 'tasks', taskId, 'incident.json')))

      const lock = await mcp.call('astra_status', { workspace })
      assert.equal(lock.structured.lock, null, 'a definitively exited ACP releases the lock')

      await waitFor(() => {
        const calls = readMockCodexCalls(workspace)
        return calls.find((call) => !call.fail && call.args[0] === 'queue' && call.args[2] === threadId)
      }, { label: 'interruption notification to the dispatch thread' })
      const calls = readMockCodexCalls(workspace).filter((call) => !call.fail)
      const args = calls[0].args
      assert.equal(args[0], 'queue')
      assert.equal(args[1], '--thread')
      assert.equal(args[2], threadId)
      assert.match(args[4], new RegExp(taskId))
      assert.match(args[4], /interrupted/)
      const record = notificationFor(workspace, taskId, 'interrupted')
      assert.equal(record.status, 'sent')
      assert.equal(record.receipt.threadId, threadId)
    } finally {
      await mcp.close()
    }
  })

  it('settles a broken stdout stream, keeps partial output, and retains the possibly active lock', async () => {
    const { workspace, mcp } = await newBridge('astra-res-stdout-close-', { MOCK_FAULT: 'close-stdout' })
    try {
      const threadId = 'thread-stdout-close'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Break stdout mid-turn.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 20 })
      assert.equal(waited.structured.state, 'interrupted')
      assert.equal(waited.structured.executionMayBeActive, true)
      assert.equal(waited.structured.incident.kind, 'acp-disconnect')
      assert.equal(waited.structured.incident.executionMayBeActive, true)
      assert.match(waited.structured.incident.partialText, /PARTIAL_OUTPUT/)
      assert.match(waited.text, /Execution may still be active/)
      const refused = await mcp.call('dsh_message', {
        workspace,
        taskId,
        message: 'Do not resume until the old process is verified stopped.',
      })
      assert.equal(refused.isError, true)
      assert.match(refused.text, /EXECUTION_MAY_BE_ACTIVE|may still be executing/)
      const status = await mcp.call('astra_status', { workspace })
      assert.equal(status.structured.lock.owner, 'dsh')
      assert.equal(status.structured.lock.taskId, taskId)
      await waitFor(() => {
        const record = notificationFor(workspace, taskId, 'interrupted')
        return record?.status === 'sent' ? record : null
      }, { timeoutMs: 8000, label: 'stdout-close interruption notification' })
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.executionMayBeActive, true)
      assert.equal(stored.lockToken !== null, true)
      assert.ok(isPidAlive(stored.runner?.acpPid), 'transport fault detection must leave the ACP process alive')
    } finally {
      await mcp.close()
    }
  })

  it('continues the queue after a normal end_turn', async () => {
    const { workspace, mcp } = await newBridge('astra-res-queue-', {
      MOCK_FAULT: 'slow-tool',
      MOCK_SLOW_MS: '1000',
    })
    try {
      const threadId = 'thread-normal-queue'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Finish a slow first turn.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      const queued = await mcp.call('dsh_message', {
        workspace,
        taskId,
        message: 'ASK_QUESTION in the normal queued turn.',
      })
      assert.equal(queued.isError, false, queued.text)
      assert.equal(queued.structured.queued, true)
      const finished = await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId })
        return status.structured.state === 'idle' && status.structured.turn === 2 ? status : null
      }, { timeoutMs: 15_000, label: 'normal queue continuation' })
      assert.equal(finished.structured.queueLength, 0)
      assert.match(finished.structured.lastAssistantText, /turn=2/)
      assert.ok(finished.structured.events.some((event) => event.type === 'queue_continue'))
    } finally {
      await mcp.close()
    }
  })

  it('reports a disabled watchdog explicitly instead of claiming independent monitoring', async () => {
    const { workspace, mcp } = await newBridge('astra-res-watchdog-off-', {
      MOCK_FAULT: 'silent',
      MOCK_SILENT_MS: '60000',
      ASTRA_DSH_WATCHDOG: '0',
    })
    try {
      const dispatched = await mcp.call('dsh_dispatch', dispatchArgs(workspace, 'Run without an independent watchdog.'))
      assert.equal(dispatched.isError, false, dispatched.text)
      assert.ok(dispatched.structured.degraded.some((reason) => /watchdog disabled/i.test(reason)))
      assert.match(dispatched.text, /watchdog disabled/i)
      const status = await mcp.call('astra_status', { workspace })
      assert.equal(status.structured.bridge.watchdog, false)
      assert.match(status.text, /Watchdog: DISABLED/)
      const taskId = dispatched.structured.taskId
      const taskStatus = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(taskStatus.structured.monitor.watchdog, 'disabled')
      await mcp.call('dsh_cancel', { workspace, taskId }, 30_000)
    } finally {
      await mcp.close()
    }
  })

  it('retains the lock when cancel is not confirmed before the grace period', async () => {
    const { workspace, mcp } = await newBridge('astra-res-cancel-timeout-', {
      MOCK_FAULT: 'silent',
      MOCK_SILENT_MS: '60000',
      MOCK_IGNORE_CANCEL: '1',
      ASTRA_DSH_CANCEL_GRACE_MS: '300',
    })
    try {
      const threadId = 'thread-cancel-timeout'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Ignore cancel and keep running.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      await waitFor(async () => (await mcp.call('dsh_status', { workspace, taskId })).structured.state === 'running', {
        label: 'running turn before unconfirmed cancel',
      })
      const cancelled = await mcp.call('dsh_cancel', { workspace, taskId }, 15_000)
      assert.equal(cancelled.structured.state, 'cancelled')
      assert.equal(cancelled.structured.cancelConfirmed, false)
      assert.equal(cancelled.structured.lockRetained, true)
      assert.equal(cancelled.structured.executionMayBeActive, true)
      assert.match(cancelled.text, /did not confirm|not confirm/i)
      const status = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(status.structured.executionMayBeActive, true)
      assert.equal(status.structured.lock.owner, 'dsh')
      assert.equal(status.structured.lock.taskId, taskId)
      assert.equal(status.structured.phase, 'cancel-unconfirmed')
      assert.match(status.text, /Execution may still be active/)
    } finally {
      await mcp.close()
    }
  })

  it('refuses to release a lock when another live runner owns the turn', async () => {
    const workspace = await makeWorkspace('astra-res-cancel-foreign-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const store = new WorkspaceStore(workspace)
    const task = store.createTask({
      title: 'Foreign running task',
      packet: '# foreign\n',
      writeScopes: ['dsh-output.txt'],
      runner: { instance: 'other-live-runner', pid: process.pid, turn: 1, acpPid: process.pid },
      codexThreadId: 'thread-foreign',
    })
    task.state = 'running'
    task.turnIndex = 1
    const lock = store.acquireLock({ owner: 'dsh', taskId: task.id, ttlMs: 60_000 })
    task.lockToken = lock.token
    store.saveTask(task)

    const mcp = startMcp({ cwd: workspace, env: faultEnv(workspace, { MOCK_FAULT: 'ok' }) })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const cancelled = await mcp.call('dsh_cancel', { workspace, taskId: task.id }, 20_000)
      assert.equal(cancelled.structured.state, 'cancelled')
      assert.equal(cancelled.structured.cancelConfirmed, false)
      assert.equal(cancelled.structured.lockRetained, true)
      assert.match(cancelled.text, /did not confirm|not confirm/i)
      const status = await mcp.call('astra_status', { workspace })
      assert.equal(status.structured.lock.owner, 'dsh')
      assert.equal(status.structured.lock.taskId, task.id)
      const stored = readTaskRecord(workspace, task.id)
      assert.equal(stored.executionMayBeActive, true)
    } finally {
      await mcp.close()
    }
  })

  it('clears the risk and lock when ACP confirms cancel after the grace period', async () => {
    const { workspace, mcp } = await newBridge('astra-res-cancel-late-', {
      MOCK_FAULT: 'silent',
      MOCK_SILENT_MS: '60000',
      MOCK_IGNORE_CANCEL_MS: '700',
      ASTRA_DSH_CANCEL_GRACE_MS: '100',
    })
    try {
      const threadId = 'thread-cancel-late'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Confirm cancel after the grace period.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      await waitFor(async () => (await mcp.call('dsh_status', { workspace, taskId })).structured.state === 'running', {
        label: 'running before late cancel',
      })
      const cancelled = await mcp.call('dsh_cancel', { workspace, taskId }, 10_000)
      assert.equal(cancelled.structured.cancelConfirmed, false)
      assert.equal(cancelled.structured.lockRetained, true)
      const settled = await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId })
        return status.structured.state === 'cancelled'
          && status.structured.executionMayBeActive === false
          && status.structured.lock === null ? status : null
      }, { timeoutMs: 6000, label: 'late cancel confirmation clears risk and lock' })
      assert.equal(settled.structured.cancelConfirmed, true)
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.executionMayBeActive, false)
      assert.ok(stored.executionMayBeActiveResolvedAt)
      assert.ok(stored.incident === null || stored.incident.executionMayBeActive === false)
    } finally {
      await mcp.close()
    }
  })

  it('does not send an abnormal alert for a user cancellation', async () => {
    const { workspace, mcp } = await newBridge('astra-res-cancel-', {
      MOCK_FAULT: 'silent',
      MOCK_SILENT_MS: '60000',
    })
    try {
      const threadId = 'thread-user-cancel'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Hold until cancelled.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId })
        return status.structured.state === 'running'
      }, { label: 'running turn before cancel' })

      const cancelled = await mcp.call('dsh_cancel', { workspace, taskId }, 30_000)
      assert.equal(cancelled.structured.state, 'cancelled')
      assert.equal(cancelled.structured.lockRetained, false)
      await sleep(400)

      assert.equal(readMockCodexCalls(workspace).length, 0, 'user cancel must not wake Astra as an incident')
      const records = readNotifications(workspace)
      assert.ok(!records.some((record) => ['failed', 'interrupted', 'control-lost'].includes(record.kind) && record.status === 'sent'))
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.state, 'cancelled')
      assert.equal(stored.incident ?? null, null)
      assert.equal(stored.executionMayBeActive, false)
    } finally {
      await mcp.close()
    }
  })

  it('makes a missing dispatch thread explicitly degraded in dispatch and status', async () => {
    const { workspace, mcp } = await newBridge('astra-res-nothread-', { MOCK_FAULT: 'ok' })
    try {
      const dispatched = await mcp.call('dsh_dispatch', dispatchArgs(workspace, 'Complete normally without a thread.'))
      assert.equal(dispatched.isError, false, dispatched.text)
      assert.ok(dispatched.structured.degraded.some((reason) => /thread/i.test(reason)))
      assert.match(dispatched.text, /DEGRADED/)
      const taskId = dispatched.structured.taskId
      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 20 })
      assert.equal(waited.structured.state, 'idle')
      assert.equal(waited.structured.notification.health, 'degraded')
      assert.ok(waited.structured.notification.counts.degraded >= 1)
      assert.match(waited.structured.notification.lastError, /thread/i)
      const status = await mcp.call('astra_status', { workspace })
      assert.match(status.text, /notifications degraded/i)
      assert.equal(readMockCodexCalls(workspace).length, 0)
      const record = notificationFor(workspace, taskId, 'settled')
      assert.equal(record.status, 'degraded')
      assert.match(record.lastError, /thread/i)
    } finally {
      await mcp.close()
    }
  })
})

describe('explicit force recovery', () => {
  it('clears a sidecar control-loss incident, releases only this task lock, and starts a new Flash turn', async () => {
    const workspace = await makeWorkspace('astra-res-force-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const store = new WorkspaceStore(workspace)
    const deadOwner = await deadPid()
    const deadAcp = await deadPid()
    const task = store.createTask({
      title: 'Force recovery task',
      packet: '# force recovery\n',
      writeScopes: ['dsh-output.txt'],
      model: 'deepseek-flash',
      runner: { instance: 'dead-sidecar-runner', pid: deadOwner, turn: 1, acpPid: deadAcp },
      codexThreadId: 'thread-force',
    })
    task.state = 'interrupted'
    task.turnIndex = 1
    task.startedAt = nowIso()
    // The lock is acquired before the transport fault; simulate that real order
    // so the new execution-risk gate does not reject test setup.
    const lock = store.acquireLock({ owner: 'dsh', taskId: task.id, ttlMs: 60_000, note: 'possibly active' })
    task.lockToken = lock.token
    task.executionMayBeActive = true
    const incident = store.writeIncident(task, {
      kind: 'control-lost',
      turn: 1,
      sessionId: null,
      executionMayBeActive: true,
      message: 'Bridge control connection was lost while DSH may still be executing.',
      at: nowIso(),
    })
    task.incident = incident
    store.saveTask(task)
    writeFileSync(
      join(workspace, '.astra-dsh', 'tasks', task.id, 'incident-control-lost.json'),
      `${JSON.stringify(incident, null, 2)}\n`,
    )

    const mcp = startMcp({ cwd: workspace, env: faultEnv(workspace, { MOCK_FAULT: 'ok', ASTRA_DSH_MODEL: 'deepseek-flash' }) })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const refused = await mcp.call('dsh_message', { workspace, taskId: task.id, message: 'resume' })
      assert.equal(refused.isError, true)
      assert.match(refused.text, /EXECUTION_MAY_BE_ACTIVE|may still be executing/)

      const forced = await mcp.call('dsh_message', {
        workspace,
        taskId: task.id,
        message: 'Resume after out-of-band verification.',
        force: true,
      })
      assert.equal(forced.isError, false, forced.text)
      const finished = await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId: task.id })
        return status.structured.state === 'idle' && status.structured.turn === 2 ? status : null
      }, { timeoutMs: 10_000, label: 'forced Flash turn settles' })

      const stored = readTaskRecord(workspace, task.id)
      const resolvedIncident = JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'tasks', task.id, 'incident.json'), 'utf8'))
      assert.equal(stored.executionMayBeActive, false)
      assert.equal(stored.incident, null)
      assert.equal(resolvedIncident.executionMayBeActive, false)
      assert.ok(resolvedIncident.resolvedAt)
      assert.equal(stored.model, 'deepseek-flash')
      assert.equal(stored.requestedModel, 'deepseek-flash')
      assert.equal(stored.lockToken, null)
      assert.equal(finished.structured.lock, null, 'the retained same-task lock is gone after the new turn')
      assert.equal(finished.structured.executionMayBeActive, false)
      assert.ok(existsSync(join(workspace, '.astra-dsh', 'tasks', task.id, 'incident-control-lost.json')))
    } finally {
      await mcp.close()
    }
  })
})

describe('workspace writer gate', () => {
  it('rejects new dispatch and Astra lock while a possibly active task exists, then allows writers after force recovery', async () => {
    const workspace = await makeWorkspace('astra-res-writer-gate-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    writeFileSync(join(workspace, 'sentinel.txt'), 'must remain\n')
    const store = new WorkspaceStore(workspace)
    const deadOwner = await deadPid()
    const task = store.createTask({
      title: 'Possibly active task',
      packet: '# active\n',
      writeScopes: ['dsh-output.txt'],
      model: 'deepseek-flash',
      runner: { instance: 'dead-risk-runner', pid: deadOwner, turn: 1, acpPid: process.pid },
      codexThreadId: 'thread-writer-gate',
    })
    task.state = 'interrupted'
    task.turnIndex = 1
    task.startedAt = nowIso()
    const lock = store.acquireLock({ owner: 'dsh', taskId: task.id, ttlMs: 60_000 })
    task.lockToken = lock.token
    task.executionMayBeActive = true
    const incident = store.writeIncident(task, {
      kind: 'control-lost',
      turn: 1,
      executionMayBeActive: true,
      message: 'may still be executing',
      at: nowIso(),
    })
    task.incident = incident
    store.saveTask(task)
    writeFileSync(join(store.lockDir(), 'owner.json'), JSON.stringify({
      ...lock,
      pid: 2_147_483_647,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    const oldToken = lock.token

    const mcp = startMcp({ cwd: workspace, env: faultEnv(workspace, { MOCK_FAULT: 'ok', ASTRA_DSH_MODEL: 'deepseek-flash' }) })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const dispatched = await mcp.call('dsh_dispatch', dispatchArgs(workspace, 'Must not start while another task may run.'))
      assert.equal(dispatched.isError, true)
      assert.match(dispatched.text, /EXECUTION_MAY_BE_ACTIVE|unresolved execution risk/)
      assert.equal(existsSync(join(workspace, 'fault-prompts.jsonl')), false, 'rejected dispatch must not start an ACP prompt')

      const astraLock = await mcp.call('astra_lock', { workspace, action: 'acquire', note: 'must be blocked' })
      assert.equal(astraLock.isError, true)
      assert.match(astraLock.text, /EXECUTION_MAY_BE_ACTIVE|unresolved execution risk/)

      const onDisk = JSON.parse(readFileSync(join(store.lockDir(), 'owner.json'), 'utf8'))
      assert.equal(onDisk.token, oldToken, 'rejected writers must preserve the old lock token')
      assert.equal(readFileSync(join(workspace, 'sentinel.txt'), 'utf8'), 'must remain\n')
      assert.equal(readdirSync(join(workspace, '.astra-dsh', 'tasks')).filter((name) => name.startsWith('T-')).length, 1,
        'rejected dispatch must not create a new task')

      const status = await mcp.call('astra_status', { workspace })
      assert.equal(status.structured.executionRisk.taskId, task.id)
      assert.equal(status.structured.lock.blockedByExecutionRisk.taskId, task.id)
      assert.equal(status.structured.lock.reclaimable, false)
      const lockStatus = await mcp.call('astra_lock', { workspace, action: 'status' })
      assert.equal(lockStatus.structured.executionRisk.taskId, task.id)
      assert.match(lockStatus.text, /Execution risk:/)

      const forced = await mcp.call('dsh_message', {
        workspace,
        taskId: task.id,
        message: 'Resume only after out-of-band verification.',
        force: true,
      })
      assert.equal(forced.isError, false, forced.text)
      await waitFor(async () => {
        const current = await mcp.call('dsh_status', { workspace, taskId: task.id })
        return current.structured.state === 'idle' && current.structured.turn === 2 ? current : null
      }, { timeoutMs: 10_000, label: 'force recovery new turn' })
      const after = await mcp.call('astra_status', { workspace })
      assert.equal(after.structured.executionRisk, null)
      assert.equal(after.structured.lock, null)
      const writer = await mcp.call('astra_lock', { workspace, action: 'acquire', note: 'safe after resolution' })
      assert.equal(writer.isError, false, writer.text)
      await mcp.call('astra_lock', { workspace, action: 'release' })
    } finally {
      await mcp.close()
    }
  })
})

describe('model selection safety', () => {
  it('fails the dispatch instead of silently running on another model when Flash cannot be set', async () => {
    const { workspace, mcp } = await newBridge('astra-res-modelfail-', {
      MOCK_FAULT: 'set-config-fails',
      ASTRA_DSH_MODEL: 'deepseek-flash',
    })
    try {
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Must not run on Pro.'), {
        threadId: 'thread-model-fail',
        sessionId: 'thread-model-fail',
      })
      assert.equal(dispatched.isError, true)
      assert.match(dispatched.text, /MODEL_SELECTION_FAILED|Refusing to continue/)
      assert.equal(existsSync(join(workspace, 'fault-prompts.jsonl')), false, 'no prompt ran on an unverified model')
      const names = readdirSync(join(workspace, '.astra-dsh', 'tasks')).filter((name) => name.startsWith('T-'))
      assert.equal(names.length, 1)
      const stored = readTaskRecord(workspace, names[0])
      assert.equal(stored.state, 'failed')
      assert.equal(stored.model, null, 'the task model request is not rewritten')
      assert.equal(stored.modelSelection, 'failed')
      assert.equal(stored.requestedModel, 'deepseek-flash')
      assert.match(stored.modelError, /flash unavailable|model selection rejected/i)
    } finally {
      await mcp.close()
    }
  })
})

describe('progress health', () => {
  it('warns before recovery, keeps running, then records recovery without a timing race', async () => {
    const workspace = await makeWorkspace('astra-res-stall-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const startedFile = join(workspace, 'stall-started.flag')
    const recoverFile = join(workspace, 'stall-recover.flag')
    const mcp = startMcp({
      cwd: workspace,
      env: faultEnv(workspace, {
        MOCK_FAULT: 'silent',
        MOCK_SILENT_MS: '60000',
        MOCK_SILENT_STARTED_FILE: startedFile,
        MOCK_SILENT_RECOVER_FILE: recoverFile,
        ASTRA_DSH_STALL_WARN_MS: '200',
      }),
    })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const threadId = 'thread-stall'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Run a quiet long tool then recover.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      await waitFor(() => existsSync(startedFile), { label: 'mock tool started barrier' })
      const stallNotice = await waitFor(() => {
        const candidates = readNotifications(workspace).filter((record) => record.taskId === taskId && record.kind === 'suspected-stall')
        const sent = candidates.find((record) => record.status === 'sent')
        return sent ?? null
      }, { timeoutMs: 6000, label: 'first stall warning sent before recovery' })
      assert.ok(stallNotice.episodeAt)
      const stalled = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(stalled.structured.state, 'running', 'a suspected stall must not become interrupted')
      assert.equal(stalled.structured.suspectedStall, true)
      assert.equal(stalled.structured.health.status, 'suspected-stall')
      assert.equal(stalled.structured.health.severity, 'warning')
      assert.equal(stalled.structured.lastTool.title, 'bash')
      assert.equal(stalled.structured.lock.owner, 'dsh')
      assert.match(stalled.text, /Suspected stall \(warning, not a failure\)/)

      writeFileSync(recoverFile, 'recover\n')
      const waited = await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId })
        return status.structured.state === 'idle' ? status : null
      }, { timeoutMs: 8000, label: 'stall recovery settle' })
      assert.ok(waited.structured.stall.recoveredAt)
      assert.equal(waited.structured.suspectedStall, false)
      assert.equal(waited.structured.turn, 1)
      const events = waited.structured.events.map((event) => event.type)
      assert.ok(events.includes('suspected_stall'))
      assert.ok(events.includes('stall_recovered'))
      assert.equal(readNotifications(workspace).filter((record) => record.taskId === taskId && record.kind === 'suspected-stall').length, 1)
    } finally {
      await mcp.close()
    }
  })

  it('creates a new stall episode notification after recovery in the same turn', async () => {
    const workspace = await makeWorkspace('astra-res-stall-twice-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const startedFile = join(workspace, 'stall-started.flag')
    const recover1 = join(workspace, 'stall-recover-1.flag')
    const recover2 = join(workspace, 'stall-recover-2.flag')
    const mcp = startMcp({
      cwd: workspace,
      env: faultEnv(workspace, {
        MOCK_FAULT: 'stall-twice',
        MOCK_SILENT_MS: '60000',
        MOCK_SILENT_STARTED_FILE: startedFile,
        MOCK_SILENT_RECOVER_FILE: recover1,
        MOCK_SILENT_RECOVER_FILE_2: recover2,
        ASTRA_DSH_STALL_WARN_MS: '150',
      }),
    })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const threadId = 'thread-stall-twice'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Stall, recover, stall again.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      await waitFor(() => existsSync(startedFile), { label: 'stall-twice tool started' })
      const first = await waitFor(() => {
        const sent = readNotifications(workspace).filter((record) => record.taskId === taskId && record.kind === 'suspected-stall' && record.status === 'sent')
        return sent[0] ?? null
      }, { timeoutMs: 6000, label: 'first episode sent' })
      writeFileSync(recover1, 'recover1\n')
      const second = await waitFor(() => {
        const sent = readNotifications(workspace).filter((record) => record.taskId === taskId && record.kind === 'suspected-stall' && record.status === 'sent')
        return sent.length >= 2 ? sent[1] : null
      }, { timeoutMs: 6000, label: 'second episode sent after recovery' })
      assert.notEqual(second.id, first.id)
      assert.notEqual(second.episodeAt, first.episodeAt)
      const running = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(running.structured.state, 'running')
      assert.equal(running.structured.turn, 1)
      writeFileSync(recover2, 'recover2\n')
      const done = await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId })
        return status.structured.state === 'idle' ? status : null
      }, { timeoutMs: 8000, label: 'second recovery settles' })
      assert.equal(done.structured.turn, 1)
      assert.equal(readNotifications(workspace).filter((record) => record.taskId === taskId && record.kind === 'suspected-stall').length, 2)
    } finally {
      await mcp.close()
    }
  })

  it('suppresses a pending stall notification when recovery happens before delivery', async () => {
    const workspace = await makeWorkspace('astra-res-stall-suppressed-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const startedFile = join(workspace, 'stall-started.flag')
    const recoverFile = join(workspace, 'stall-recover.flag')
    const mcp = startMcp({
      cwd: workspace,
      env: faultEnv(workspace, {
        MOCK_FAULT: 'silent',
        MOCK_SILENT_MS: '60000',
        MOCK_SILENT_STARTED_FILE: startedFile,
        MOCK_SILENT_RECOVER_FILE: recoverFile,
        ASTRA_DSH_STALL_WARN_MS: '150',
        MOCK_CODEX_FAIL_TIMES: '1',
        MOCK_CODEX_STATE: join(workspace, 'stall-suppressed-codex-count'),
        ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '200',
        ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '200',
      }),
    })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const threadId = 'thread-stall-suppressed'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Recover before the warning retry.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      await waitFor(() => existsSync(startedFile), { label: 'suppressed-stall tool started' })
      await waitFor(() => {
        const record = readNotifications(workspace).find((candidate) => candidate.taskId === taskId && candidate.kind === 'suspected-stall')
        return record?.status === 'retrying' ? record : null
      }, { timeoutMs: 6000, label: 'stall notification waiting for retry' })
      writeFileSync(recoverFile, 'recover\n')
      const suppressed = await waitFor(() => {
        const record = readNotifications(workspace).find((candidate) => candidate.taskId === taskId && candidate.kind === 'suspected-stall')
        return record?.status === 'suppressed' ? record : null
      }, { timeoutMs: 6000, label: 'stall notification suppressed after recovery' })
      assert.match(suppressed.suppressedReason, /recover|no longer|running/i)
      const successfulStallCalls = readMockCodexCalls(workspace, { onlyOk: true })
        .filter((call) => /suspected-stall/.test(call.args[4]))
      assert.equal(successfulStallCalls.length, 0)
      const status = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(status.structured.state, 'idle')
      assert.ok(status.structured.stall.recoveredAt)
    } finally {
      await mcp.close()
    }
  })
})

describe('durable notification recovery', () => {
  it('retries after a CLI failure and recovers the outbox after a bridge restart', async () => {
    const workspace = await makeWorkspace('astra-res-notify-restart-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const threadId = 'thread-restart-notify'
    const stateFile = join(workspace, 'codex-count')
    const firstEnv = faultEnv(workspace, {
      MOCK_FAULT: 'ok',
      MOCK_CODEX_FAIL_TIMES: '1',
      MOCK_CODEX_STATE: stateFile,
      ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '60000',
      ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '60000',
    })
    let mcp = startMcp({ cwd: workspace, env: firstEnv })
    let taskId
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Settle once.'), {
        threadId,
        sessionId: threadId,
      })
      taskId = dispatched.structured.taskId
      // Poll status instead of dsh_wait: dsh_wait intentionally suppresses the
      // normal completion wake-up, which is exactly what this test must send.
      await waitFor(async () => {
        const status = await mcp.call('dsh_status', { workspace, taskId })
        return status.structured.state === 'idle'
      }, { label: 'first turn settle' })
      await waitFor(() => notificationFor(workspace, taskId, 'settled')?.status === 'retrying', {
        timeoutMs: 5000,
        label: 'first notification failure recorded',
      })
      const pending = notificationFor(workspace, taskId, 'settled')
      assert.ok(pending.attempts >= 1)
      assert.ok(Date.parse(pending.nextAttemptAt) > Date.now())
    } finally {
      await mcp.close()
    }

    const secondEnv = faultEnv(workspace, {
      MOCK_FAULT: 'ok',
      MOCK_CODEX_FAIL_TIMES: '0',
      MOCK_CODEX_STATE: stateFile,
      ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '30',
    })
    mcp = startMcp({ cwd: workspace, env: secondEnv })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      await mcp.call('astra_status', { workspace })
      const recovered = await waitFor(() => {
        const record = notificationFor(workspace, taskId, 'settled')
        return record?.status === 'sent' ? record : null
      }, { timeoutMs: 8000, label: 'outbox recovery after restart' })
      assert.equal(recovered.receipt.threadId, threadId)
      const calls = readMockCodexCalls(workspace, { onlyOk: true })
      assert.equal(calls.length, 1, 'recovery must not create a duplicate task or second wake-up')
      assert.equal(calls[0].args[2], threadId)
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.state, 'idle')
      assert.equal(stored.turnIndex, 1)
    } finally {
      await mcp.close()
    }
  })

  it('stops the watchdog sidecar when the turn ends normally', async () => {
    const { workspace, mcp } = await newBridge('astra-res-watchdog-stop-', { MOCK_FAULT: 'slow-tool' })
    try {
      const threadId = 'thread-watchdog-stop'
      const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Finish quickly.'), {
        threadId,
        sessionId: threadId,
      })
      const taskId = dispatched.structured.taskId
      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 20 })
      assert.equal(waited.structured.state, 'idle')
      const pid = waited.structured.monitor?.pid
      assert.ok(Number.isInteger(pid), 'watchdog pid was recorded')
      assert.ok(waited.structured.monitor?.readyAt, 'watchdog must report a ready ACK before active')
      await waitFor(() => !isPidAlive(pid), { timeoutMs: 5000, label: 'sidecar exit after normal turn' })
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.turnIndex, 1)
    } finally {
      await mcp.close()
    }
  })
})

describe('bridge crash watchdog', () => {
  it('records control loss and notifies the dispatch thread without touching a possibly active lock', async () => {
    const { workspace, mcp } = await newBridge('astra-res-sigkill-', {
      MOCK_FAULT: 'silent',
      MOCK_SILENT_MS: '60000',
    })
    const threadId = 'thread-sigkill-watchdog'
    const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Keep running while the bridge dies.'), {
      threadId,
      sessionId: threadId,
    })
    assert.equal(dispatched.isError, false, dispatched.text)
    const taskId = dispatched.structured.taskId
    const running = await waitFor(async () => {
      const status = await mcp.call('dsh_status', { workspace, taskId })
      return status.structured.state === 'running' && status.structured.monitor?.pid ? status : null
    }, { label: 'running task with a watchdog' })
    const watchdogPid = running.structured.monitor.pid
    const acpPid = readTaskRecord(workspace, taskId).runner?.acpPid
    const lockBefore = await mcp.call('astra_status', { workspace })
    assert.equal(lockBefore.structured.lock.owner, 'dsh')

    await mcp.kill('SIGKILL')

    try {
      await waitFor(() => {
        const calls = readMockCodexCalls(workspace, { onlyOk: true })
        return calls.find((call) => call.args[2] === threadId && /control-lost/.test(call.args[4]))
      }, { timeoutMs: 10_000, label: 'watchdog control-loss notification' })
      await waitFor(() => !isPidAlive(watchdogPid), { timeoutMs: 5000, label: 'watchdog sidecar exit' })

      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.state, 'running', 'the sidecar must not rewrite task state')
      assert.equal(stored.turnIndex, 1)
      const lockFile = join(workspace, '.astra-dsh', 'locks', 'workspace.lock', 'owner.json')
      assert.ok(existsSync(lockFile), 'the possibly active lock must not be released')
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
      assert.equal(lock.owner, 'dsh')
      assert.equal(lock.taskId, taskId)

      const incident = JSON.parse(readFileSync(
        join(workspace, '.astra-dsh', 'tasks', taskId, 'incident-control-lost.json'),
        'utf8',
      ))
      assert.equal(incident.kind, 'control-lost')
      assert.equal(incident.executionMayBeActive, true)
      assert.match(incident.message, /may still be executing/i)
      const record = notificationFor(workspace, taskId, 'control-lost')
      assert.equal(record.status, 'sent')
      assert.equal(record.receipt.threadId, threadId)
      const calls = readMockCodexCalls(workspace, { onlyOk: true }).filter((call) => /control-lost/.test(call.args[4]))
      assert.equal(calls.length, 1)
    } finally {
      if (Number.isInteger(acpPid) && isPidAlive(acpPid)) {
        try { process.kill(acpPid, 'SIGKILL') } catch { /* test child already gone */ }
      }
    }
  })

  it('retries its own control-loss notification after the bridge is gone until the CLI succeeds', async () => {
    const workspace = await makeWorkspace('astra-res-sidecar-retry-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const mcp = startMcp({
      cwd: workspace,
      env: faultEnv(workspace, {
        MOCK_FAULT: 'silent',
        MOCK_SILENT_MS: '60000',
        MOCK_CODEX_FAIL_TIMES: '2',
        MOCK_CODEX_STATE: join(workspace, 'sidecar-codex-count'),
        ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '50',
        ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '200',
        ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS: '8000',
        ASTRA_DSH_WATCHDOG_NOTIFY_MAX_ATTEMPTS: '10',
      }),
    })
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
    const threadId = 'thread-sidecar-retry'
    const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Survive a dead bridge and a flaky CLI.'), {
      threadId,
      sessionId: threadId,
    })
    const taskId = dispatched.structured.taskId
    const running = await waitFor(async () => {
      const status = await mcp.call('dsh_status', { workspace, taskId })
      return status.structured.state === 'running' && status.structured.monitor?.pid ? status : null
    }, { label: 'running task with watchdog before SIGKILL' })
    const watchdogPid = running.structured.monitor.pid
    const acpPid = readTaskRecord(workspace, taskId).runner?.acpPid
    const otherId = 'T-other-sidecar~t1~settled'
    writeFileSync(join(workspace, '.astra-dsh', 'notifications', `${otherId}.json`), `${JSON.stringify({
      schema: 1,
      id: otherId,
      taskId: 'T-other-sidecar',
      turn: 1,
      kind: 'settled',
      threadId: 'thread-other',
      message: 'must not be sent by this sidecar',
      status: 'pending',
      attempts: 0,
      createdAt: nowIso(),
      nextAttemptAt: nowIso(),
    }, null, 2)}\n`)
    await mcp.kill('SIGKILL')
    try {
      await waitFor(() => readMockCodexCalls(workspace).filter((call) => call.fail).length >= 1, {
        timeoutMs: 5000,
        label: 'first sidecar CLI failure',
      })
      assert.ok(isPidAlive(watchdogPid), 'sidecar must stay alive while its notification is retrying')
      const record = await waitFor(() => {
        const candidate = notificationFor(workspace, taskId, 'control-lost')
        return candidate?.status === 'sent' ? candidate : null
      }, { timeoutMs: 12_000, label: 'sidecar retry receipt without a new bridge' })
      const calls = readMockCodexCalls(workspace)
      assert.equal(calls.filter((call) => call.fail).length, 2)
      const success = calls.find((call) => !call.fail && call.args[2] === threadId)
      assert.ok(success)
      assert.match(success.args[4], new RegExp(taskId))
      assert.equal(record.attempts, 3)
      assert.equal(record.receipt.threadId, threadId)
      await waitFor(() => !isPidAlive(watchdogPid), { timeoutMs: 5000, label: 'sidecar exits after success' })
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.state, 'running')
      assert.ok(existsSync(join(workspace, '.astra-dsh', 'locks', 'workspace.lock', 'owner.json')))
      const other = JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'notifications', `${otherId}.json`), 'utf8'))
      assert.equal(other.status, 'pending', 'sidecar must only flush its own control-loss event')
      assert.equal(readMockCodexCalls(workspace, { onlyOk: true }).some((call) => /thread-other/.test(call.args[2] ?? '')), false)
    } finally {
      if (Number.isInteger(acpPid) && isPidAlive(acpPid)) {
        try { process.kill(acpPid, 'SIGKILL') } catch { /* test child already gone */ }
      }
    }
  })

  it('exits with an explicit retrying record when the sidecar retry budget is exhausted', async () => {
    const workspace = await makeWorkspace('astra-res-sidecar-budget-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const mcp = startMcp({
      cwd: workspace,
      env: faultEnv(workspace, {
        MOCK_FAULT: 'silent',
        MOCK_SILENT_MS: '60000',
        MOCK_CODEX_FAIL_TIMES: '999',
        MOCK_CODEX_STATE: join(workspace, 'budget-codex-count'),
        ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '50',
        ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '100',
        ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS: '1000',
        ASTRA_DSH_WATCHDOG_NOTIFY_MAX_ATTEMPTS: '2',
      }),
    })
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
    const threadId = 'thread-sidecar-budget'
    const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Exhaust the sidecar retry budget.'), {
      threadId,
      sessionId: threadId,
    })
    const taskId = dispatched.structured.taskId
    const running = await waitFor(async () => {
      const status = await mcp.call('dsh_status', { workspace, taskId })
      return status.structured.state === 'running' && status.structured.monitor?.pid ? status : null
    }, { label: 'running task before budget SIGKILL' })
    const watchdogPid = running.structured.monitor.pid
    const acpPid = readTaskRecord(workspace, taskId).runner?.acpPid
    const otherId = 'T-other-sidecar~t1~settled'
    writeFileSync(join(workspace, '.astra-dsh', 'notifications', `${otherId}.json`), `${JSON.stringify({
      schema: 1,
      id: otherId,
      taskId: 'T-other-sidecar',
      turn: 1,
      kind: 'settled',
      threadId: 'thread-other',
      message: 'must not be sent by this sidecar',
      status: 'pending',
      attempts: 0,
      createdAt: nowIso(),
      nextAttemptAt: nowIso(),
    }, null, 2)}\n`)
    await mcp.kill('SIGKILL')
    try {
      const record = await waitFor(() => {
        const candidate = notificationFor(workspace, taskId, 'control-lost')
        return candidate && ['pending', 'retrying', 'sending'].includes(candidate.status)
          && /budget exhausted/i.test(candidate.lastError ?? '') ? candidate : null
      }, { timeoutMs: 8000, label: 'sidecar budget-exhausted record' })
      assert.equal(record.status, 'retrying')
      assert.match(record.lastError, /future bridge start will resume/i)
      await waitFor(() => !isPidAlive(watchdogPid), { timeoutMs: 5000, label: 'sidecar exits after budget' })
      const stored = readTaskRecord(workspace, taskId)
      assert.equal(stored.state, 'running')
      assert.ok(existsSync(join(workspace, '.astra-dsh', 'locks', 'workspace.lock', 'owner.json')))
      assert.equal(readMockCodexCalls(workspace, { onlyOk: true }).length, 0)
    } finally {
      if (Number.isInteger(acpPid) && isPidAlive(acpPid)) {
        try { process.kill(acpPid, 'SIGKILL') } catch { /* test child already gone */ }
      }
    }
  })

  it('reconciles this workspace only and notifies after a bridge restart', async () => {
    const workspace = await makeWorkspace('astra-res-reconcile-')
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const store = new WorkspaceStore(workspace)
    const deadOwner = await deadPid()
    const deadAcp = await deadPid()
    const threadId = 'thread-reconcile'
    const task = store.createTask({
      title: 'Orphaned running task',
      packet: '# orphan\n',
      writeScopes: ['dsh-output.txt'],
      runner: { instance: 'dead-runner', pid: deadOwner, turn: 1, acpPid: deadAcp },
      codexThreadId: threadId,
    })
    task.state = 'running'
    task.turnIndex = 1
    task.startedAt = nowIso()
    task.lastAcpUpdateAt = nowIso()
    task.runner = { instance: 'dead-runner', pid: deadOwner, turn: 1, acpPid: deadAcp, lastHeartbeatAt: '2020-01-01T00:00:00.000Z' }
    store.saveTask(task)

    const mcp = startMcp({ cwd: workspace, env: faultEnv(workspace, { MOCK_FAULT: 'ok' }) })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      await mcp.call('astra_status', { workspace })
      await waitFor(() => readTaskRecord(workspace, task.id).state === 'interrupted', {
        timeoutMs: 5000,
        label: 'startup reconcile of an orphaned running task',
      })
      const stored = readTaskRecord(workspace, task.id)
      assert.equal(stored.executionMayBeActive, false)
      assert.equal(stored.incident.kind, 'owner-exited')
      const record = await waitFor(() => {
        const candidate = notificationFor(workspace, task.id, 'interrupted')
        return candidate?.status === 'sent' ? candidate : null
      }, { timeoutMs: 5000, label: 'reconcile notification receipt' })
      assert.equal(record.receipt.threadId, threadId)
    } finally {
      await mcp.close()
    }
  })

  it('alerts on a graceful bridge stdio close while a turn is still running', async () => {
    const { workspace, mcp } = await newBridge('astra-res-stdio-', {
      MOCK_FAULT: 'silent',
      MOCK_SILENT_MS: '60000',
    })
    const threadId = 'thread-stdio-close'
    const dispatched = await mcp.callWithMeta('dsh_dispatch', dispatchArgs(workspace, 'Still running when stdio closes.'), {
      threadId,
      sessionId: threadId,
    })
    const taskId = dispatched.structured.taskId
    await waitFor(async () => {
      const status = await mcp.call('dsh_status', { workspace, taskId })
      return status.structured.state === 'running'
    }, { label: 'running turn before stdio close' })
    await mcp.close()
    await waitFor(() => notificationFor(workspace, taskId, 'control-lost')?.status === 'sent', {
      timeoutMs: 10_000,
      label: 'stdio-close control-loss notification',
    })
    const incident = JSON.parse(readFileSync(
      join(workspace, '.astra-dsh', 'tasks', taskId, 'incident-control-lost.json'),
      'utf8',
    ))
    assert.equal(incident.kind, 'control-lost')
    assert.equal(incident.executionMayBeActive, true)
  })
})
