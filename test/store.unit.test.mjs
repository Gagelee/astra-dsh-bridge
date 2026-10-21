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
