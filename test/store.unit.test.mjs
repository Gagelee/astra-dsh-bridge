import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { WorkspaceStore } from '../src/store.mjs'
import { renderExecutionPrompt, renderTaskPacket } from '../src/packet.mjs'
import { makeWorkspace } from './helpers.mjs'

function git(workspace, ...args) {
  return execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' })
}

describe('workspace store', () => {
  it('creates a board, task records, and request records', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    assert.ok(existsSync(join(workspace, '.astra-dsh', 'tasks')))
    const task = store.createTask({
      title: 'Unit task',
      packet: '# Unit task\n',
      writeScopes: ['src'],
      model: 'deepseek-v4-pro',
    })
    assert.match(task.id, /^T-/)
    assert.equal(store.loadTask(task.id).title, 'Unit task')
    assert.equal(store.listTasks().length, 1)

    const request = store.createRequest({ title: 'Unit request', body: 'Do the thing', origin: 'dsh' })
    assert.match(request.id, /^REQ-/)
    assert.equal(store.listRequests()[0].title, 'Unit request')
    store.writeRequestPlan(request, 'plan body')
    assert.equal(store.loadRequest(request.id).plan, 'plan body')
  })

  it('enforces a single writer and reclaims stale locks', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    const lock = store.acquireLock({ owner: 'astra', ttlMs: 60_000, note: 'planning' })
    assert.equal(store.inspectLock().owner, 'astra')
    assert.throws(() => store.acquireLock({ owner: 'dsh', ttlMs: 60_000 }), /locked by astra/)
    store.releaseLock(lock.token)
    assert.equal(store.inspectLock(), null)

    const stale = store.acquireLock({ owner: 'dsh', ttlMs: 60_000 })
    // Simulate a crash: dead pid and an expired lease.
    writeFileSync(join(store.lockDir(), 'owner.json'), JSON.stringify({
      ...stale,
      pid: 999_999,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }))
    const reclaimed = store.acquireLock({ owner: 'astra', ttlMs: 60_000 })
    assert.equal(reclaimed.owner, 'astra')
    assert.throws(() => store.releaseLock(stale.token), /does not match|not the current owner/)
    store.releaseLock(reclaimed.token)
  })

  it('refuses every new writer while a task may still be executing, even with a dead/expired lock', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    const task = store.createTask({ title: 'Risk task', packet: '# risk\n', writeScopes: ['out.txt'] })
    const lock = store.acquireLock({ owner: 'dsh', taskId: task.id, ttlMs: 60_000 })
    task.state = 'interrupted'
    task.turnIndex = 1
    task.executionMayBeActive = true
    task.runner = { instance: 'dead-runner', pid: 2_147_483_647, turn: 1, acpPid: process.pid }
    store.saveTask(task)

    for (const expired of [false, true]) {
      writeFileSync(join(store.lockDir(), 'owner.json'), JSON.stringify({
        ...lock,
        pid: 2_147_483_647,
        expiresAt: expired ? new Date(Date.now() - 60_000).toISOString() : lock.expiresAt,
      }))
      assert.throws(
        () => store.acquireLock({ owner: 'astra', ttlMs: 60_000 }),
        (error) => error.code === 'EXECUTION_MAY_BE_ACTIVE'
          && error.details?.blockedByExecutionRisk?.taskId === task.id
          && error.details.blockedByExecutionRisk.acpPid === process.pid,
      )
      const current = store.inspectLock({ includeExecutionRisk: false })
      assert.equal(current.token, lock.token, 'risk lock must not be reclaimed')
    }

    const inspected = store.inspectLock()
    assert.equal(inspected.dead, true)
    assert.equal(inspected.reclaimable, false)
    assert.equal(inspected.blockedByExecutionRisk.taskId, task.id)
  })

  it('refuses a new writer when the lock is missing but a sidecar-only incident is unresolved', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    const task = store.createTask({ title: 'Sidecar risk', packet: '# sidecar\n', writeScopes: ['out.txt'] })
    task.state = 'cancelled'
    task.turnIndex = 1
    task.executionMayBeActive = false
    task.runner = { instance: 'dead-runner', pid: 2_147_483_647, turn: 1, acpPid: process.pid }
    store.saveTask(task)
    writeFileSync(join(store.taskDir(task.id), 'incident-control-lost.json'), `${JSON.stringify({
      schema: 1,
      taskId: task.id,
      kind: 'control-lost',
      turn: 1,
      at: new Date().toISOString(),
      executionMayBeActive: true,
      ownerPid: 2_147_483_647,
      acpPid: process.pid,
    }, null, 2)}\n`)
    assert.equal(store.inspectLock(), null)
    assert.throws(
      () => store.acquireLock({ owner: 'astra', ttlMs: 60_000 }),
      (error) => error.code === 'EXECUTION_MAY_BE_ACTIVE'
        && error.details?.blockedByExecutionRisk?.taskId === task.id
        && /force=true/.test(error.details.resolution),
    )
    assert.equal(store.inspectLock(), null, 'a rejected writer must not create a lock')
  })

  it('allows a new writer after same-turn explicit resolution, but not after an old resolved turn', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    const task = store.createTask({ title: 'Resolved risk', packet: '# resolved\n', writeScopes: ['out.txt'] })
    task.state = 'interrupted'
    task.turnIndex = 1
    task.executionMayBeActive = true
    task.runner = { instance: 'dead-runner', pid: 2_147_483_647, turn: 1, acpPid: process.pid }
    store.saveTask(task)
    const incidentAt = new Date().toISOString()
    store.writeIncident(task, { kind: 'control-lost', turn: 1, at: incidentAt, executionMayBeActive: true })
    store.saveTask(task)
    assert.throws(() => store.acquireLock({ owner: 'astra' }), /unresolved execution risk/)

    const resolvedAt = new Date(Date.now() + 1000).toISOString()
    store.updateTask(task.id, (fresh) => {
      fresh.executionMayBeActive = false
      fresh.executionMayBeActiveResolvedAt = resolvedAt
      fresh.executionMayBeActiveResolvedTurn = 1
      fresh.incident = { ...fresh.incident, executionMayBeActive: false, resolvedAt }
      return fresh
    })
    const lock = store.acquireLock({ owner: 'astra', ttlMs: 60_000 })
    assert.equal(lock.owner, 'astra')
    store.releaseLock(lock.token)

    const next = store.createTask({ title: 'Next turn task', packet: '# next\n', writeScopes: ['out.txt'] })
    next.turnIndex = 2
    next.executionMayBeActive = false
    store.saveTask(next)
    writeFileSync(join(store.taskDir(next.id), 'incident-control-lost.json'), `${JSON.stringify({
      kind: 'control-lost',
      turn: 1,
      at: incidentAt,
      executionMayBeActive: true,
    }, null, 2)}\n`)
    const nextLock = store.acquireLock({ owner: 'astra', ttlMs: 60_000 })
    assert.equal(nextLock.owner, 'astra')
  })

  it('fails closed with EXECUTION_RISK_UNKNOWN when a risk record is unreadable', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    const task = store.createTask({ title: 'Corrupt risk', packet: '# corrupt\n' })
    writeFileSync(join(store.taskDir(task.id), 'incident.json'), '{not json')
    assert.throws(
      () => store.acquireLock({ owner: 'astra' }),
      (error) => error.code === 'EXECUTION_RISK_UNKNOWN' && /cannot read/.test(error.message),
    )
    assert.equal(store.inspectLock(), null)
  })

  it('detects file changes without git', async () => {
    const workspace = await makeWorkspace()
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const store = new WorkspaceStore(workspace)
    const baseline = await store.captureBaseline()
    writeFileSync(join(workspace, 'added.txt'), 'added\n')
    writeFileSync(join(workspace, 'seed.txt'), 'changed\n')
    const changes = await store.collectChanges(baseline)
    const byPath = Object.fromEntries(changes.changedFiles.map((entry) => [entry.path, entry.code]))
    assert.equal(byPath['added.txt'], 'A')
    assert.equal(byPath['seed.txt'], 'M')
  })

  it('captures a git diff and marks pre-existing dirty files', async () => {
    const workspace = await makeWorkspace()
    git(workspace, 'init', '-q')
    git(workspace, 'config', 'user.email', 'test@example.com')
    git(workspace, 'config', 'user.name', 'Test')
    writeFileSync(join(workspace, 'tracked.txt'), 'one\n')
    git(workspace, 'add', '.')
    git(workspace, 'commit', '-qm', 'init')
    writeFileSync(join(workspace, 'dirty.txt'), 'already dirty\n')

    const store = new WorkspaceStore(workspace)
    const baseline = await store.captureBaseline()
    assert.equal(baseline.vcs, 'git')
    writeFileSync(join(workspace, 'tracked.txt'), 'one\ntwo\n')
    const changes = await store.collectChanges(baseline)
    assert.match(changes.diff, /\+two/)
    const tracked = changes.changedFiles.find((entry) => entry.path === 'tracked.txt')
    assert.ok(tracked)
    assert.equal(tracked.preexisting, false)
    const dirty = changes.changedFiles.find((entry) => entry.path === 'dirty.txt')
    assert.equal(dirty.preexisting, true)
  })

  it('keeps .astra-dsh out of git status via the local exclude file', async () => {
    const workspace = await makeWorkspace()
    git(workspace, 'init', '-q')
    git(workspace, 'config', 'user.email', 'test@example.com')
    git(workspace, 'config', 'user.name', 'Test')
    writeFileSync(join(workspace, '.gitignore'), '')
    git(workspace, 'add', '.')
    git(workspace, 'commit', '-qm', 'init')
    const store = new WorkspaceStore(workspace)
    store.createTask({ title: 'Excluded', packet: '# Excluded\n' })
    const status = git(workspace, 'status', '--porcelain')
    assert.equal(status.trim(), '')
  })
})

describe('task packet rendering', () => {
  it('carries goal, decisions, constraints, and acceptance criteria into the prompt', () => {
    const packet = renderTaskPacket({
      title: 'Add export',
      goal: 'Export reports as CSV.',
      context: 'Astra decided to reuse the existing exporter.',
      files: ['src/report.ts — screen'],
      constraints: ['No new dependencies'],
      acceptance: ['CSV downloads', 'UTF-8 BOM present'],
      deliverables: ['src/export.ts'],
      outOfScope: ['PDF'],
      notes: 'Keep it behind a flag.',
      requestId: 'REQ-1',
      writeScopes: ['src/export.ts'],
      workspace: '/tmp/ws',
    })
    assert.match(packet, /## Goal/)
    assert.match(packet, /reuse the existing exporter/)
    assert.match(packet, /No new dependencies/)
    assert.match(packet, /CSV downloads/)
    assert.match(packet, /REQ-1/)

    const prompt = renderExecutionPrompt({
      task: { id: 'T-1', title: 'Add export', workspace: '/tmp/ws', turnIndex: 0 },
      packet,
      message: 'Please also update the docs.',
    })
    assert.match(prompt, /Do not edit files under `\.astra-dsh\/`/)
    assert.match(prompt, /Please also update the docs/)
    assert.match(prompt, /QUESTION:/)
  })
})

describe('DSH-side CLI', () => {
  it('drops a request that the shared board lists', async () => {
    const workspace = await makeWorkspace()
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname
    const result = spawnSync(process.execPath, [cli, 'request', '--workspace', workspace, '--title', 'CLI request', '--body', 'Body from CLI'], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Created REQ-/)
    const store = new WorkspaceStore(workspace)
    assert.equal(store.listRequests()[0].title, 'CLI request')
    assert.equal(store.listRequests()[0].origin, 'dsh')
  })

  it('prints tasks and status', async () => {
    const workspace = await makeWorkspace()
    const store = new WorkspaceStore(workspace)
    store.createTask({ title: 'CLI task', packet: '# CLI task\n' })
    const cli = new URL('../src/cli.mjs', import.meta.url).pathname
    const tasks = spawnSync(process.execPath, [cli, 'tasks', '--workspace', workspace], { encoding: 'utf8' })
    assert.equal(tasks.status, 0, tasks.stderr)
    assert.match(tasks.stdout, /CLI task/)
    const status = spawnSync(process.execPath, [cli, 'status', '--workspace', workspace], { encoding: 'utf8' })
    assert.equal(status.status, 0, status.stderr)
    assert.match(status.stdout, /Tasks: 1/)
  })
})
