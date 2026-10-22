import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { NotificationOutbox, notificationId } from '../src/notifications.mjs'
import { WorkspaceStore } from '../src/store.mjs'
import { TaskRunner, buildWatchdogEnv } from '../src/task-runner.mjs'
import { WatchdogSupervisor } from '../src/watchdog-supervisor.mjs'
import { isPidAlive, nowIso, pidState, sleep } from '../src/util.mjs'
import {
  MOCK_CODEX,
  MOCK_CODEX_OUT,
  makeWorkspace,
  readMockCodexCalls,
  readNotifications,
  readTaskRecord,
  waitFor,
} from './helpers.mjs'

function testConfig(workspace, extra = {}) {
  // Unit tests invoke the outbox in-process, so the mock CLI's env must be set
  // on process.env (integration tests pass it to the MCP child instead).
  process.env.MOCK_CODEX_OUT = MOCK_CODEX_OUT(workspace)
  process.env.MOCK_CODEX_STATE = join(workspace, 'codex-count')
  process.env.MOCK_CODEX_FAIL_TIMES = '0'
  process.env.MOCK_CODEX_SLEEP_MS = '0'
  for (const [key, value] of Object.entries(extra)) {
    if (key.startsWith('MOCK_')) process.env[key] = String(value)
  }
  return loadConfig({
    ASTRA_DSH_DSH_BIN: process.execPath,
    ASTRA_DSH_DSH_HOME: join(workspace, '.dsh-home'),
    ASTRA_DSH_HOME: join(workspace, '.bridge-home'),
    ASTRA_DSH_CREDENTIALS: join(workspace, 'missing-credentials.yaml'),
    ASTRA_DSH_CODEX_BIN: MOCK_CODEX,
    ASTRA_DSH_NOTIFY_CODEX: '1',
    ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '20',
    ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '200',
    ASTRA_DSH_NOTIFY_LEASE_MS: '1000',
    MOCK_CODEX_OUT: MOCK_CODEX_OUT(workspace),
    ...extra,
  })
}

function makeTask(store, { thread = 'thread-unit', state = 'idle', turn = 1 } = {}) {
  const task = store.createTask({
    title: 'unit task',
    packet: '# unit\n',
    writeScopes: ['out.txt'],
    runner: { instance: 'runner-unit', pid: process.pid, turn },
    codexThreadId: thread,
  })
  task.state = state
  task.turnIndex = turn
  task.lastAcpUpdateAt = nowIso()
  store.saveTask(task)
  return task
}

describe('durable notification outbox', () => {
  it('keeps the outbox record when an old task snapshot is saved', async () => {
    const workspace = await makeWorkspace('astra-notify-snapshot-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace, { ASTRA_DSH_NOTIFY_CODEX: '0' })
    const outbox = new NotificationOutbox({ store, config, owner: 'unit-a' })
    try {
      const task = makeTask(store)
      const stale = JSON.parse(JSON.stringify(store.loadTask(task.id)))
      const id = notificationId(task.id, 1, 'settled')
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'settled' })
      store.saveTask(stale)
      const records = readNotifications(workspace)
      assert.equal(records.length, 1)
      assert.equal(records[0].id, id)
      assert.equal(records[0].status, 'pending')
      assert.equal(outbox.summarize(task.id).pending, 1)
    } finally {
      outbox.close()
    }
  })

  it('deduplicates duplicate settle events and sends one CLI call', async () => {
    const workspace = await makeWorkspace('astra-notify-dedupe-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const outbox = new NotificationOutbox({ store, config, owner: 'unit-dedupe' })
    try {
      const task = makeTask(store)
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'one' })
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'two' })
      assert.equal(readNotifications(workspace).length, 1)
      await outbox.flush()
      await waitFor(() => readMockCodexCalls(workspace).length === 1, { label: 'one codex queue call' })
      const record = outbox.load(notificationId(task.id, 1, 'settled'))
      assert.equal(record.status, 'sent')
      assert.equal(record.attempts, 1)
      assert.equal(record.receipt.threadId, 'thread-unit')
      await outbox.flush()
      await sleep(50)
      assert.equal(readMockCodexCalls(workspace).length, 1, 'a sent receipt must not be re-sent')
    } finally {
      outbox.close()
    }
  })

  it('accepts an array of onlyIds on success, failure, and suppressed paths without a finally TypeError', async () => {
    // Success path.
    const okWorkspace = await makeWorkspace('astra-onlyids-ok-')
    const okStore = new WorkspaceStore(okWorkspace)
    const okOutbox = new NotificationOutbox({ store: okStore, config: testConfig(okWorkspace), owner: 'onlyids-ok' })
    try {
      const task = makeTask(okStore)
      const id = notificationId(task.id, 1, 'settled')
      okOutbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'only ids' })
      await assert.doesNotReject(okOutbox.flush({ onlyIds: [id] }))
      await waitFor(() => okOutbox.load(id)?.status === 'sent', { label: 'onlyIds success receipt' })
    } finally {
      okOutbox.close()
    }

    // Failure path: the finally block must still persist retrying state.
    const failWorkspace = await makeWorkspace('astra-onlyids-fail-')
    const failStore = new WorkspaceStore(failWorkspace)
    const failOutbox = new NotificationOutbox({
      store: failStore,
      config: testConfig(failWorkspace, { MOCK_CODEX_FAIL_TIMES: '1' }),
      owner: 'onlyids-fail',
    })
    try {
      const task = makeTask(failStore)
      const id = notificationId(task.id, 1, 'settled')
      failOutbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'only ids fail' })
      await assert.doesNotReject(failOutbox.flush({ onlyIds: [id] }))
      const record = failOutbox.load(id)
      assert.equal(record.status, 'retrying')
      assert.ok(record.attempts >= 1)
    } finally {
      failOutbox.close()
    }

    // Suppressed path.
    const suppressedWorkspace = await makeWorkspace('astra-onlyids-suppressed-')
    const suppressedStore = new WorkspaceStore(suppressedWorkspace)
    const suppressedOutbox = new NotificationOutbox({ store: suppressedStore, config: testConfig(suppressedWorkspace), owner: 'onlyids-suppressed' })
    try {
      const task = makeTask(suppressedStore)
      const id = notificationId(task.id, 1, 'settled')
      suppressedOutbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'only ids suppressed' })
      const reviewed = suppressedStore.loadTask(task.id)
      reviewed.state = 'accepted'
      reviewed.review = { decision: 'accepted', mode: 'manual', at: nowIso() }
      suppressedStore.saveTask(reviewed)
      await assert.doesNotReject(suppressedOutbox.flush({ onlyIds: [id] }))
      assert.equal(suppressedOutbox.load(id).status, 'suppressed')
    } finally {
      suppressedOutbox.close()
    }
  })

  it('retries a transient CLI failure with persisted attempts and then writes a receipt', async () => {
    const workspace = await makeWorkspace('astra-notify-retry-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace, {
      MOCK_CODEX_FAIL_TIMES: '2',
      MOCK_CODEX_STATE: join(workspace, 'codex-fail-count'),
    })
    const outbox = new NotificationOutbox({ store, config, owner: 'unit-retry' })
    try {
      const task = makeTask(store)
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'retry me' })
      const eventId = notificationId(task.id, 1, 'settled')
      await waitFor(() => outbox.load(eventId)?.status === 'sent', {
        timeoutMs: 8000,
        label: 'notification receipt after retries',
      })
      const calls = readMockCodexCalls(workspace)
      assert.equal(calls.length, 3)
      assert.deepEqual(calls.map((call) => call.fail), [true, true, false])
      const record = outbox.load(eventId)
      assert.equal(record.status, 'sent')
      assert.equal(record.attempts, 3)
      assert.ok(record.receipt.at)
    } finally {
      outbox.close()
    }
  })

  it('suppresses an event after review, a new turn, or cancellation', async () => {
    const workspace = await makeWorkspace('astra-notify-invalid-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const outbox = new NotificationOutbox({ store, config, owner: 'unit-invalid' })
    try {
      const reviewed = makeTask(store, { thread: 'thread-reviewed' })
      outbox.enqueue({ taskId: reviewed.id, turn: 1, kind: 'settled', threadId: 'thread-reviewed', message: 'x' })
      const reviewedFresh = store.loadTask(reviewed.id)
      reviewedFresh.state = 'accepted'
      reviewedFresh.review = { decision: 'accepted', mode: 'manual', at: nowIso() }
      store.saveTask(reviewedFresh)
      await outbox.flush()
      assert.equal(outbox.load(notificationId(reviewed.id, 1, 'settled')).status, 'suppressed')

      const newTurn = makeTask(store, { thread: 'thread-newturn' })
      outbox.enqueue({ taskId: newTurn.id, turn: 1, kind: 'settled', threadId: 'thread-newturn', message: 'x' })
      const moved = store.loadTask(newTurn.id)
      moved.turnIndex = 2
      store.saveTask(moved)
      await outbox.flush()
      const movedRecord = outbox.load(notificationId(newTurn.id, 1, 'settled'))
      assert.equal(movedRecord.status, 'suppressed')
      assert.match(movedRecord.suppressedReason, /turn/)

      const cancelled = makeTask(store, { thread: 'thread-cancel' })
      outbox.enqueue({ taskId: cancelled.id, turn: 1, kind: 'settled', threadId: 'thread-cancel', message: 'x' })
      const cancelledFresh = store.loadTask(cancelled.id)
      cancelledFresh.state = 'cancelled'
      store.saveTask(cancelledFresh)
      await outbox.flush()
      assert.equal(outbox.load(notificationId(cancelled.id, 1, 'settled')).status, 'suppressed')
      assert.equal(readMockCodexCalls(workspace).length, 0)
    } finally {
      outbox.close()
    }
  })

  it('marks a missing dispatch thread as degraded instead of silently dropping the wake-up', async () => {
    const workspace = await makeWorkspace('astra-notify-nothread-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const outbox = new NotificationOutbox({ store, config, owner: 'unit-nothread' })
    try {
      const task = makeTask(store, { thread: null })
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: null, message: 'x' })
      await outbox.flush()
      const record = outbox.load(notificationId(task.id, 1, 'settled'))
      assert.equal(record.status, 'degraded')
      assert.match(record.lastError, /thread/i)
      assert.equal(outbox.summarize(task.id).health, 'degraded')
      assert.equal(readMockCodexCalls(workspace).length, 0)
    } finally {
      outbox.close()
    }
  })

  it('lets only one of two senders win the claim for the same event', async () => {
    const workspace = await makeWorkspace('astra-notify-claim-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const a = new NotificationOutbox({ store, config, owner: 'sender-a' })
    const b = new NotificationOutbox({ store, config, owner: 'sender-b' })
    try {
      const task = makeTask(store)
      a.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'claim once' })
      await Promise.all([a.flush(), b.flush()])
      await sleep(100)
      assert.equal(readMockCodexCalls(workspace).length, 1)
      assert.equal(a.load(notificationId(task.id, 1, 'settled')).status, 'sent')
    } finally {
      a.close()
      b.close()
    }
  })

  it('does not let a replay enqueue overwrite a sent receipt', async () => {
    const workspace = await makeWorkspace('astra-outbox-immutable-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const outbox = new NotificationOutbox({ store, config, owner: 'immutable' })
    try {
      const task = makeTask(store)
      const id = notificationId(task.id, 1, 'settled')
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'original' })
      await outbox.flush()
      await waitFor(() => outbox.load(id)?.status === 'sent', { label: 'original sent' })
      const before = outbox.load(id)
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'late replay' })
      const after = outbox.load(id)
      assert.equal(after.status, 'sent')
      assert.equal(after.message, before.message)
      assert.deepEqual(after.receipt, before.receipt)
    } finally {
      outbox.close()
    }
  })

  it('does not release a claim that a new sender now owns', async () => {
    const workspace = await makeWorkspace('astra-outbox-fencing-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const outbox = new NotificationOutbox({ store, config, owner: 'old-owner' })
    try {
      const task = makeTask(store)
      const id = notificationId(task.id, 1, 'settled')
      outbox.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'fenced' })
      assert.ok(outbox.claim(id))
      const claimFile = join(workspace, '.astra-dsh', 'notifications', 'claims', id, 'claim.json')
      const claim = JSON.parse(readFileSync(claimFile, 'utf8'))
      claim.owner = 'new-owner'
      claim.token = 'new-token'
      claim.expiresAt = new Date(Date.now() + 60_000).toISOString()
      writeFileSync(claimFile, `${JSON.stringify(claim)}\n`)
      outbox.releaseClaim(id)
      assert.ok(existsSync(claimFile), 'old owner must not delete the new claim directory')
      const after = JSON.parse(readFileSync(claimFile, 'utf8'))
      assert.equal(after.owner, 'new-owner')
    } finally {
      outbox.close()
    }
  })

  it('recovery leaves a healthy claim belonging to another sender alone', async () => {
    const workspace = await makeWorkspace('astra-outbox-recover-claim-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const a = new NotificationOutbox({ store, config, owner: 'live-sender' })
    const b = new NotificationOutbox({ store, config, owner: 'recovering-sender' })
    let id
    try {
      const task = makeTask(store)
      id = notificationId(task.id, 1, 'settled')
      a.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'claimed' })
      assert.ok(a.claim(id))
      b.recover()
      assert.equal(b.load(id).status, 'pending')
      assert.equal(b.claimHealthy(id), true)
      assert.equal(a.load(id).attempts, 0)
    } finally {
      if (id) a.releaseClaim(id)
      a.close()
      b.close()
    }
  })

  it('renews its lease while a slow CLI is still running so a second sender cannot duplicate it', async () => {
    const workspace = await makeWorkspace('astra-outbox-renew-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace, {
      ASTRA_DSH_NOTIFY_LEASE_MS: '1000',
      ASTRA_DSH_NOTIFY_CLI_TIMEOUT_MS: '4000',
      MOCK_CODEX_SLEEP_MS: '2500',
    })
    const a = new NotificationOutbox({ store, config, owner: 'slow-sender' })
    const b = new NotificationOutbox({ store, config, owner: 'second-sender' })
    try {
      const task = makeTask(store)
      const id = notificationId(task.id, 1, 'settled')
      a.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'slow send' })
      const first = a.flush()
      await sleep(150)
      await b.flush()
      await first
      await waitFor(() => a.load(id)?.status === 'sent', { timeoutMs: 6000, label: 'slow send receipt' })
      assert.equal(readMockCodexCalls(workspace).length, 1, 'lease renewal must prevent a second sender')
    } finally {
      a.close()
      b.close()
    }
  })

  it('recovers an expired sending claim as retrying', async () => {
    const workspace = await makeWorkspace('astra-outbox-expired-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const a = new NotificationOutbox({ store, config, owner: 'crashed-sender' })
    const b = new NotificationOutbox({ store, config, owner: 'recovering-sender' })
    try {
      const task = makeTask(store)
      const id = notificationId(task.id, 1, 'settled')
      a.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'crash mid send' })
      assert.ok(a.claim(id))
      const sending = a.load(id)
      sending.status = 'sending'
      sending.attempts = 1
      a.save(sending)
      a.heldClaims.delete(id) // simulate a crashed sender that never releases
      const claimFile = join(workspace, '.astra-dsh', 'notifications', 'claims', id, 'claim.json')
      const claim = JSON.parse(readFileSync(claimFile, 'utf8'))
      claim.expiresAt = new Date(Date.now() - 1000).toISOString()
      writeFileSync(claimFile, `${JSON.stringify(claim)}\n`)
      b.recover()
      const recovered = b.load(id)
      assert.equal(recovered.status, 'retrying')
      assert.equal(recovered.claimExpiresAt, null)
      assert.equal(b.claimHealthy(id), false)
    } finally {
      a.close()
      b.close()
    }
  })

  it('recovers a persisted retry after a new sender starts', async () => {
    const workspace = await makeWorkspace('astra-notify-restart-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace, {
      MOCK_CODEX_FAIL_TIMES: '1',
      MOCK_CODEX_STATE: join(workspace, 'codex-count'),
      ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '60000',
      ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '60000',
    })
    const first = new NotificationOutbox({ store, config, owner: 'first' })
    const task = makeTask(store)
    try {
      first.enqueue({ taskId: task.id, turn: 1, kind: 'settled', threadId: 'thread-unit', message: 'survive restart' })
      await first.flush()
      const pending = first.load(notificationId(task.id, 1, 'settled'))
      assert.equal(pending.status, 'retrying')
      assert.ok(pending.attempts >= 1)
      assert.ok(Date.parse(pending.nextAttemptAt) > Date.now())
    } finally {
      first.close()
    }
    const secondConfig = testConfig(workspace, {
      MOCK_CODEX_FAIL_TIMES: '0',
      MOCK_CODEX_STATE: join(workspace, 'codex-count'),
      ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '30',
      ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '200',
    })
    const second = new NotificationOutbox({ store, config: secondConfig, owner: 'second' })
    try {
      second.recover()
      const eventId = notificationId(task.id, 1, 'settled')
      await waitFor(() => second.load(eventId)?.status === 'sent', {
        timeoutMs: 8000,
        label: 'recovered notification receipt',
      })
      assert.equal(second.load(eventId).status, 'sent')
    } finally {
      second.close()
    }
  })
})

describe('durable task snapshots', () => {
  it('keeps active risk through stale snapshots but honours an explicit same-turn resolution', async () => {
    const workspace = await makeWorkspace('astra-risk-resolution-')
    const store = new WorkspaceStore(workspace)
    const task = makeTask(store)
    const incidentAt = nowIso()
    task.executionMayBeActive = true
    task.incident = { kind: 'control-lost', at: incidentAt, turn: 1, executionMayBeActive: true }
    store.saveTask(task)

    const staleActive = JSON.parse(JSON.stringify(store.loadTask(task.id)))
    staleActive.executionMayBeActive = false
    staleActive.incident = null
    store.saveTask(staleActive)
    assert.equal(readTaskRecord(workspace, task.id).executionMayBeActive, true, 'stale snapshot cannot clear risk')

    const resolvedAt = new Date(Date.now() + 1000).toISOString()
    store.updateTask(task.id, (fresh) => {
      fresh.executionMayBeActive = false
      fresh.executionMayBeActiveResolvedAt = resolvedAt
      fresh.executionMayBeActiveResolvedTurn = fresh.turnIndex
      fresh.incident = { ...fresh.incident, executionMayBeActive: false, resolvedAt }
      return fresh
    })
    assert.equal(readTaskRecord(workspace, task.id).executionMayBeActive, false)
    store.saveTask(staleActive)
    assert.equal(readTaskRecord(workspace, task.id).executionMayBeActive, false, 'old active snapshot cannot resurrect risk')

    const newIncidentAt = new Date(Date.now() + 2000).toISOString()
    store.updateTask(task.id, (fresh) => {
      fresh.executionMayBeActive = true
      fresh.executionMayBeActiveResolvedAt = null
      fresh.executionMayBeActiveResolvedTurn = null
      fresh.incident = { kind: 'turn-failed', at: newIncidentAt, turn: fresh.turnIndex, executionMayBeActive: true }
      return fresh
    })
    assert.equal(readTaskRecord(workspace, task.id).executionMayBeActive, true, 'a newer incident re-arms the risk')
  })

  it('reads a sidecar-written control-loss incident even without incident.json', async () => {
    const workspace = await makeWorkspace('astra-control-loss-read-')
    const store = new WorkspaceStore(workspace)
    const task = makeTask(store)
    const incident = {
      schema: 1,
      kind: 'control-lost',
      at: nowIso(),
      turn: 1,
      taskId: task.id,
      executionMayBeActive: true,
      message: 'control lost',
    }
    writeFileSync(
      join(workspace, '.astra-dsh', 'tasks', task.id, 'incident-control-lost.json'),
      `${JSON.stringify(incident, null, 2)}\n`,
    )
    const read = store.readIncident(task.id)
    assert.equal(read.kind, 'control-lost')
    assert.equal(read.executionMayBeActive, true)
  })

  it('never lets an older turn snapshot overwrite a new turn or review', async () => {
    const workspace = await makeWorkspace('astra-snapshot-')
    const store = new WorkspaceStore(workspace)
    const task = makeTask(store)
    const stale = JSON.parse(JSON.stringify(store.loadTask(task.id)))
    const newer = store.loadTask(task.id)
    newer.turnIndex = 2
    newer.state = 'running'
    newer.queue.push({ id: 'q1', text: 'later' })
    newer.queueRevision = 1
    store.saveTask(newer)
    store.saveTask(stale)
    const afterTurn = readTaskRecord(workspace, task.id)
    assert.equal(afterTurn.turnIndex, 2)
    assert.equal(afterTurn.queue.length, 1)

    const reviewed = store.loadTask(task.id)
    reviewed.state = 'accepted'
    reviewed.review = { decision: 'accepted', mode: 'manual', at: nowIso() }
    store.saveTask(reviewed)
    const idleSnapshot = JSON.parse(JSON.stringify({ ...reviewed, review: null, state: 'idle' }))
    store.saveTask(idleSnapshot)
    const afterReview = readTaskRecord(workspace, task.id)
    assert.equal(afterReview.state, 'accepted')
    assert.equal(afterReview.review.decision, 'accepted')
  })
})

describe('watchdog startup lifecycle', () => {
  it('passes only a controlled env subset to the sidecar', () => {
    const config = loadConfig({
      ASTRA_DSH_MODEL: 'deepseek-flash',
      ASTRA_DSH_NOTIFY_CODEX: '1',
      ASTRA_DSH_CODEX_BIN: MOCK_CODEX,
      ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS: '250',
    })
    const env = buildWatchdogEnv(config, {
      PATH: '/test/bin',
      SECRET_TOKEN: 'must-not-leak',
      MOCK_CODEX_OUT: '/tmp/mock-out',
      ASTRA_DSH_HOME: '/tmp/bridge-home',
    }, { dshHome: '/tmp/dsh-home' })
    assert.equal(env.PATH, '/test/bin')
    assert.equal(env.SECRET_TOKEN, undefined)
    assert.equal(env.MOCK_CODEX_OUT, '/tmp/mock-out')
    assert.equal(env.ASTRA_DSH_NOTIFY_CODEX, '1')
    assert.equal(env.ASTRA_DSH_DSH_HOME, '/tmp/dsh-home')
    assert.equal(env.ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS, '250')
  })

  it('reports degraded and kills a sidecar that never sends a ready ACK', async () => {
    const workspace = await makeWorkspace('astra-watchdog-no-ready-')
    const store = new WorkspaceStore(workspace)
    const task = makeTask(store, { state: 'running', turn: 1 })
    task.runner = { instance: 'runner-no-ready', pid: process.pid, turn: 1 }
    store.saveTask(task)
    const fake = join(workspace, 'fake-sidecar-no-ready.mjs')
    const pidFile = join(workspace, 'fake-sidecar.pid')
    writeFileSync(fake, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))",
      "setInterval(() => {}, 1000)",
      '',
    ].join('\n'))
    const config = testConfig(workspace, { ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS: '150' })
    const supervisor = new WatchdogSupervisor({
      store,
      config,
      scriptPath: fake,
      env: { ...config, PATH: process.env.PATH, FAKE_PID_FILE: pidFile },
    })
    try {
      const result = await supervisor.start(task)
      assert.equal(result.active, false)
      assert.match(result.degraded, /ready|not ready/i)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      assert.ok(Number.isInteger(pid))
      await waitFor(() => !isPidAlive(pid), { timeoutMs: 3000, label: 'no-ready sidecar cleanup' })
      assert.equal(supervisor.status(task.id).watchdog, 'degraded')
      const stored = readTaskRecord(workspace, task.id)
      assert.equal(stored.monitor.watchdog, 'degraded')
    } finally {
      await supervisor.stopAll()
    }
  })

  it('ignores a ready ACK for the wrong turn and cleans up the sidecar', async () => {
    const workspace = await makeWorkspace('astra-watchdog-wrong-ready-')
    const store = new WorkspaceStore(workspace)
    const task = makeTask(store, { state: 'running', turn: 1 })
    task.runner = { instance: 'runner-wrong-ready', pid: process.pid, turn: 1 }
    store.saveTask(task)
    const fake = join(workspace, 'fake-sidecar-wrong-ready.mjs')
    const pidFile = join(workspace, 'fake-wrong.pid')
    writeFileSync(fake, [
      "import { writeFileSync } from 'node:fs'",
      "writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))",
      "process.on('message', (m) => { if (m?.type === 'turn-start') process.send({ type: 'ready', ok: true, taskId: m.taskId, turn: 999, runnerInstance: m.runnerInstance, pid: process.pid }) })",
      "setInterval(() => {}, 1000)",
      '',
    ].join('\n'))
    const config = testConfig(workspace, { ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS: '200' })
    const supervisor = new WatchdogSupervisor({
      store,
      config,
      scriptPath: fake,
      env: { ...config, PATH: process.env.PATH, FAKE_PID_FILE: pidFile },
    })
    try {
      const result = await supervisor.start(task)
      assert.equal(result.active, false)
      assert.match(result.degraded, /ready|not ready/i)
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await waitFor(() => !isPidAlive(pid), { timeoutMs: 3000, label: 'wrong-ready sidecar cleanup' })
      assert.equal(supervisor.sidecarAlive(task.id), false)
    } finally {
      await supervisor.stopAll()
    }
  })

  it('reports degraded when the sidecar exits before its ready ACK', async () => {
    const workspace = await makeWorkspace('astra-watchdog-early-exit-')
    const store = new WorkspaceStore(workspace)
    const task = makeTask(store, { state: 'running', turn: 1 })
    task.runner = { instance: 'runner-early-exit', pid: process.pid, turn: 1 }
    store.saveTask(task)
    const fake = join(workspace, 'fake-sidecar-exit.mjs')
    writeFileSync(fake, "process.exit(4)\n")
    const config = testConfig(workspace, { ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS: '1000' })
    const supervisor = new WatchdogSupervisor({
      store,
      config,
      scriptPath: fake,
      env: { ...config, PATH: process.env.PATH },
    })
    try {
      const result = await supervisor.start(task)
      assert.equal(result.active, false)
      assert.match(result.degraded, /exited before ready|not ready/i)
      assert.equal(supervisor.sidecarAlive(task.id), false)
    } finally {
      await supervisor.stopAll()
    }
  })
})

describe('process ownership safeguards', () => {
  it('leaves a running task alone when the owner PID is alive even with a stale heartbeat', async () => {
    const workspace = await makeWorkspace('astra-owner-alive-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace)
    const runner = new TaskRunner({ store, config })
    try {
      const task = makeTask(store, { state: 'running', turn: 1 })
      task.runner = {
        instance: 'another-runner-instance',
        pid: process.pid,
        turn: 1,
        lastHeartbeatAt: '2020-01-01T00:00:00.000Z',
      }
      store.saveTask(task)
      const reconciled = runner.reconcile(store.loadTask(task.id))
      assert.equal(reconciled.state, 'running')
      assert.equal(readTaskRecord(workspace, task.id).state, 'running')
    } finally {
      await runner.shutdown()
    }
  })

  it('treats EPERM as alive-or-unknown, never dead', () => {
    const eperm = Object.assign(new Error('not permitted'), { code: 'EPERM' })
    assert.equal(pidState(999_999, () => { throw eperm }), 'unknown')
    assert.equal(isPidAlive(999_999, () => { throw eperm }), true)
    const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' })
    assert.equal(pidState(999_999, () => { throw esrch }), 'dead')
    assert.equal(isPidAlive(999_999), false)
  })
})

describe('model selection is fail-closed', () => {
  it('refuses to continue when the requested Flash model cannot be set', async () => {
    const workspace = await makeWorkspace('astra-model-fail-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace, { ASTRA_DSH_MODEL: 'deepseek-flash' })
    const runner = new TaskRunner({ store, config })
    try {
      const task = makeTask(store, { state: 'idle' })
      const client = {
        setConfig: async () => { throw new Error('flash unavailable') },
      }
      await assert.rejects(
        runner.applyModel(client, task, []),
        (error) => error.code === 'MODEL_SELECTION_FAILED' && /unverified|flash unavailable/.test(error.message),
      )
      const stored = store.loadTask(task.id)
      assert.equal(stored.modelSelection, 'failed')
      assert.equal(stored.requestedModel, 'deepseek-flash')
      assert.match(stored.modelError, /flash unavailable/)
      assert.equal(stored.model, null, 'the task model must not be rewritten')
    } finally {
      await runner.shutdown()
    }
  })

  it('accepts a verified Flash selection and rejects a different returned model', async () => {
    const workspace = await makeWorkspace('astra-model-ok-')
    const store = new WorkspaceStore(workspace)
    const config = testConfig(workspace, { ASTRA_DSH_MODEL: 'deepseek-flash' })
    const runner = new TaskRunner({ store, config })
    try {
      const task = makeTask(store)
      const desired = JSON.stringify(['deepseek-official', 'deepseek-flash'])
      await runner.applyModel({
        setConfig: async () => ({ configOptions: [{ id: 'model', currentValue: desired }] }),
      }, task, [])
      assert.equal(task.modelSelection, 'verified')
      const mismatch = makeTask(store)
      await assert.rejects(
        runner.applyModel({
          setConfig: async () => ({ configOptions: [{ id: 'model', currentValue: JSON.stringify(['deepseek-official', 'deepseek-v4-pro']) }] }),
        }, mismatch, []),
        (error) => error.code === 'MODEL_SELECTION_FAILED',
      )
    } finally {
      await runner.shutdown()
    }
  })
})
