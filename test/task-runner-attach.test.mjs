import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.mjs'
import { WorkspaceStore } from '../src/store.mjs'
import { TaskRunner } from '../src/task-runner.mjs'
import {
  ATTACH_STATUS,
  canonicalWorkspacePath,
  renderAttachAck,
  requestPath,
  writeAttachAck,
} from '../src/attach.mjs'
import { makeWorkspace } from './helpers.mjs'

function makeRunner(workspace, home) {
  const store = new WorkspaceStore(workspace)
  const config = loadConfig({
    ASTRA_DSH_DSH_HOME: home,
    ASTRA_DSH_DSH_BIN: 'dsh-does-not-exist-for-attach-unit',
    ASTRA_DSH_CREDENTIALS: join(home, 'no-credentials.yaml'),
    ASTRA_DSH_MODEL: 'mock-model',
    ASTRA_DSH_MODEL_PROVIDER: 'mock',
  })
  const runner = new TaskRunner({ store, config })
  return { store, runner }
}

function fakeTask(overrides = {}) {
  return {
    id: 'T-20261022-120000-cccc',
    sessionId: 'mock-session-1',
    guiPolicy: 'existing',
    guiWorkspaceTitle: null,
    attachGeneration: 0,
    attachSessionId: null,
    attachQueuedAt: null,
    title: 'Attach unit task',
    ...overrides,
  }
}

function identityOf(runner, task) {
  const canonical = canonicalWorkspacePath(runner.store.workspace)
  return { identity: { taskId: task.id, sessionId: task.sessionId, generation: Number(task.attachGeneration ?? 0) }, canonical }
}

function requestAt(runner, task) {
  const { identity, canonical } = identityOf(runner, task)
  return JSON.parse(readFileSync(requestPath(runner.attachQueueDir, identity, canonical), 'utf8'))
}

describe('TaskRunner attach delivery', () => {
  it('is idempotent for the same session and re-delivers when the session changes', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)
    assert.ok(runner.attachQueueDir)

    const task = fakeTask()
    runner.enqueueAttach(task)
    const { identity, canonical } = identityOf(runner, task)
    assert.ok(existsSync(requestPath(runner.attachQueueDir, identity, canonical)))
    assert.equal(task.attachSessionId, 'mock-session-1')
    const first = requestAt(runner, task)

    // Same session + generation: no rewrite.
    runner.enqueueAttach(task)
    const second = requestAt(runner, task)
    assert.equal(second.createdAt, first.createdAt, 'idempotent no-op must not rewrite the request')

    // Session changed (recreated): must re-deliver with the new session id.
    task.sessionId = 'mock-session-2'
    runner.enqueueAttach(task)
    const third = requestAt(runner, task)
    assert.equal(third.identity.sessionId, 'mock-session-2')
    assert.notEqual(third.createdAt, first.createdAt)
  })

  it('does not re-deliver once a matching terminal ACK exists', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)
    const task = fakeTask()
    runner.enqueueAttach(task)
    const { identity, canonical } = identityOf(runner, task)

    // A matching terminal ACK makes the request a no-op even after the plugin
    // deletes the request file.
    writeAttachAck(runner.attachQueueDir, renderAttachAck({
      identity,
      workspace,
      canonicalWorkspace: canonical,
      sessionId: task.sessionId,
      status: ATTACH_STATUS.ATTACHED,
      workspaceId: 'ws-1',
      workspaceTitle: 'proj',
    }))
    const before = requestAt(runner, task).createdAt

    // Simulate the plugin having deleted the request file after the ACK.
    rmSync(requestPath(runner.attachQueueDir, identity, canonical), { force: true })

    runner.enqueueAttach(task)
    assert.ok(!existsSync(requestPath(runner.attachQueueDir, identity, canonical)), 'terminal ACK must suppress re-delivery')
    assert.equal(runner.guiStatusOf(task).status, ATTACH_STATUS.ATTACHED)
    void before
  })

  it('ignores stale ACKs and honours a matching one', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)
    const task = fakeTask()
    runner.enqueueAttach(task)
    const { canonical } = identityOf(runner, task)

    // A stale ACK (different session) must be ignored.
    writeAttachAck(runner.attachQueueDir, renderAttachAck({
      identity: { taskId: task.id, sessionId: 'old-session', generation: 0 },
      workspace,
      canonicalWorkspace: canonical,
      sessionId: 'old-session',
      status: ATTACH_STATUS.ATTACHED,
    }))
    assert.equal(runner.guiStatusOf(task).status, ATTACH_STATUS.QUEUED)

    // A stale ACK (different generation) must be ignored too.
    writeAttachAck(runner.attachQueueDir, renderAttachAck({
      identity: { taskId: task.id, sessionId: task.sessionId, generation: 99 },
      workspace,
      canonicalWorkspace: canonical,
      sessionId: task.sessionId,
      status: ATTACH_STATUS.ATTACHED,
    }))
    assert.equal(runner.guiStatusOf(task).status, ATTACH_STATUS.QUEUED)

    // A matching ACK is reported.
    writeAttachAck(runner.attachQueueDir, renderAttachAck({
      identity: { taskId: task.id, sessionId: task.sessionId, generation: 0 },
      workspace,
      canonicalWorkspace: canonical,
      sessionId: task.sessionId,
      status: ATTACH_STATUS.UNREGISTERED,
      lastError: 'workspace not registered',
    }))
    const gui = runner.guiStatusOf(task)
    assert.equal(gui.status, ATTACH_STATUS.UNREGISTERED)
    assert.equal(gui.detail, 'workspace not registered')
  })

  it('retryGui bumps the generation and forces a fresh delivery', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)
    const task = fakeTask()
    runner.enqueueAttach(task)
    assert.equal(task.attachGeneration, 0)

    const result = runner.retryGui(task.id)
    assert.equal(result.enqueued, true)
    assert.equal(result.generation, 1)
    const refreshedTask = runner.store.loadTask(task.id)
    const refreshed = requestAt(runner, refreshedTask)
    assert.equal(refreshed.identity.generation, 1)
  })

  it('reports off policy as off and private-home without a queue', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)

    const off = fakeTask({ guiPolicy: 'off' })
    runner.enqueueAttach(off)
    const { identity, canonical } = identityOf(runner, off)
    assert.ok(!existsSync(requestPath(runner.attachQueueDir, identity, canonical)))
    assert.equal(runner.guiStatusOf(off).status, ATTACH_STATUS.OFF)

    // A runner whose DSH home fell back to the private workspace home has no queue.
    const privateRunner = new TaskRunner({ store: runner.store, config: loadConfig({}) })
    assert.equal(privateRunner.attachQueueDir, null)
    const task = fakeTask()
    assert.equal(privateRunner.guiStatusOf(task).status, ATTACH_STATUS.PRIVATE_HOME)
  })

  it('keeps the create title null when guiWorkspaceTitle is not supplied', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)
    const task = fakeTask({ guiPolicy: 'create' })
    runner.enqueueAttach(task)
    assert.equal(requestAt(runner, task).title, null, 'unset guiWorkspaceTitle must stay null for registry default title')
  })

  it('is compatible with old tasks whose attachQueuedAt is the legacy dir shape', async () => {
    const workspace = await makeWorkspace()
    const home = join(workspace, 'home')
    const { runner } = makeRunner(workspace, home)
    // Old bridges stored the queue *directory* (not a per-identity file) here.
    const task = fakeTask({ attachQueuedAt: join(home, 'astra-dsh', 'attach') })
    runner.enqueueAttach(task)
    const { identity, canonical } = identityOf(runner, task)
    assert.ok(existsSync(requestPath(runner.attachQueueDir, identity, canonical)), 'must re-deliver regardless of old attachQueuedAt shape')
    assert.equal(task.attachQueuedAt, requestPath(runner.attachQueueDir, identity, canonical))
  })
})
