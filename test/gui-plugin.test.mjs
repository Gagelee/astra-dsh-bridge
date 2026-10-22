import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { apply } from '../gui-plugin/index.js'
import {
  ATTACH_STATUS,
  canonicalWorkspacePath,
  legacyRequestPath,
  readAttachAck,
  renderAttachRequest,
  requestPath,
  writeAttachRequest,
} from '../src/attach.mjs'
import { makeWorkspace } from './helpers.mjs'

function summary(sessionId, { title = undefined, updatedAt = 1, cwd = '/proj', blank = title === undefined } = {}) {
  return {
    sessionId,
    updatedAt,
    running: false,
    blank,
    agentAvailable: false,
    cwd,
    ...(title === undefined ? {} : { projections: { kind: 'cached', asOfSeq: 1, values: { title } } }),
  }
}

function workspaceMock(path, title) {
  const ws = {
    id: `ws-${Math.random().toString(16).slice(2)}`,
    path,
    title: title ?? path.split('/').pop(),
    attached: [],
  }
  ws.attachSession = async (sessionId) => { ws.attached.push(sessionId) }
  return ws
}

function makeCtx({ sessions = [], workspaces = [], listImpl = null } = {}) {
  const emitted = []
  const effects = []
  const byPath = new Map(workspaces.map((ws) => [ws.path, ws]))
  const ctx = {
    workspaceRegistry: {
      resolveByPath: async (path) => byPath.get(path),
      create: async (path, title) => {
        let ws = byPath.get(path)
        if (!ws) {
          ws = workspaceMock(path, title)
          byPath.set(path, ws)
        }
        return ws
      },
    },
    sessionController: {
      list: listImpl ?? (async () => ({ items: sessions })),
    },
    emit: (event, ...args) => { emitted.push({ event, args }) },
    effect: (fn) => { effects.push(fn) },
  }
  return { ctx, emitted, effects, byPath }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('gui workspace-attach plugin (mock ctx)', () => {
  let home
  let queueDir
  let originalHome

  beforeEach(async () => {
    originalHome = process.env.DSH_HOME
    home = await makeWorkspace('astra-dsh-gui-plugin-')
    process.env.DSH_HOME = home
    queueDir = join(home, 'astra-dsh', 'attach')
    mkdirSync(queueDir, { recursive: true })
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = originalHome
  })

  function writeRequest(taskId, sessionId, policy, workspace, { generation = 0, title = 'Task' } = {}) {
    const request = renderAttachRequest({ taskId, sessionId, generation, workspace, title, policy })
    writeAttachRequest(queueDir, request)
    return request
  }

  function ackFor(request) {
    return readAttachAck(queueDir, request.identity, request.canonicalWorkspace)
  }

  it('confirms the session exists before touching the workspace', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-1', 'sess-1', 'create', workspace)
    const { ctx, emitted, byPath } = makeCtx({ sessions: [], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(byPath.size, 0, 'workspace must not be created before the session is visible')
    assert.equal(emitted.length, 0, 'nothing should be published for an unseen session')
    assert.ok(existsSync(requestPath(queueDir, request.identity, request.canonicalWorkspace)), 'request stays for retry')
    assert.equal(ackFor(request).status, ATTACH_STATUS.WAITING_SESSION)
    controller.stop()
  })

  it('uses existing policy without creating, and reports unregistered', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-2', 'sess-2', 'existing', workspace)
    const { ctx, emitted, byPath } = makeCtx({ sessions: [summary('sess-2')], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(byPath.size, 0, 'existing policy must not create a workspace')
    assert.equal(emitted.length, 1, 'catalog publish still happens')
    assert.equal(emitted[0].event, 'api-session/added')
    assert.equal(emitted[0].args[0].sessionId, 'sess-2')
    assert.equal(ackFor(request).status, ATTACH_STATUS.UNREGISTERED)
    assert.ok(!existsSync(requestPath(queueDir, request.identity, request.canonicalWorkspace)), 'request deleted after terminal ack')
    controller.stop()
  })

  it('create policy creates the workspace exactly once and attaches', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-3', 'sess-3', 'create', workspace)
    const { ctx, emitted, byPath } = makeCtx({ sessions: [summary('sess-3', { cwd: workspace })], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(byPath.size, 1, 'create policy creates one workspace')
    const ws = [...byPath.values()][0]
    assert.deepEqual(ws.attached, ['sess-3'])
    assert.equal(ackFor(request).status, ATTACH_STATUS.ATTACHED)
    assert.equal(emitted[0].event, 'api-session/added')
    controller.stop()
  })

  it('off policy neither publishes nor touches the workspace', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-4', 'sess-4', 'off', workspace)
    const { ctx, emitted, byPath } = makeCtx({ sessions: [summary('sess-4')], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(byPath.size, 0)
    assert.equal(emitted.length, 0, 'off policy must not publish the catalog')
    assert.equal(ackFor(request).status, ATTACH_STATUS.OFF)
    controller.stop()
  })

  it('recovers a waiting-session once the session becomes visible', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-5', 'sess-5', 'create', workspace)
    const sessions = []
    const { ctx, emitted, byPath } = makeCtx({ sessions, workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()
    assert.equal(ackFor(request).status, ATTACH_STATUS.WAITING_SESSION)

    sessions.push(summary('sess-5', { cwd: workspace }))
    await controller.pump()

    assert.equal(ackFor(request).status, ATTACH_STATUS.ATTACHED)
    assert.equal([...byPath.values()][0].attached.length, 1)
    assert.equal(emitted[0].event, 'api-session/added')
    controller.stop()
  })

  it('publishes a title update after the first prompt via bounded follow-up', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-6', 'sess-6', 'create', workspace)
    const sessions = [summary('sess-6', { cwd: workspace, title: undefined })]
    const { ctx, emitted } = makeCtx({ sessions, workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()
    const publishedBefore = emitted.length

    sessions[0] = summary('sess-6', { cwd: workspace, title: 'DSH task T-6 — Title', updatedAt: 2 })
    await controller.followUpTitles()

    const titles = emitted.slice(publishedBefore).map((e) => e.args[0]?.projections?.values?.title).filter(Boolean)
    assert.ok(titles.includes('DSH task T-6 — Title'), 'follow-up should republish with the new title')
    void request
    controller.stop()
  })

  it('republishes when blank flips false even with unchanged title and updatedAt', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-6b', 'sess-6b', 'existing', workspace)
    const sessions = [summary('sess-6b', { cwd: workspace, title: undefined, updatedAt: 7, blank: true })]
    const { ctx, emitted } = makeCtx({ sessions, workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()
    assert.equal(ackFor(request).status, ATTACH_STATUS.UNREGISTERED)
    const publishedBefore = emitted.length

    // blank flips false; updatedAt and title stay the same.
    sessions[0] = summary('sess-6b', { cwd: workspace, title: undefined, updatedAt: 7, blank: false })
    await controller.followUpTitles()

    assert.ok(emitted.length > publishedBefore, 'blank change must republish the summary')
    assert.equal(emitted[emitted.length - 1].args[0].blank, false)
    controller.stop()
  })

  it('recovers an unfinished follow-up after a plugin restart from the ACK', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-6c', 'sess-6c', 'existing', workspace)
    const sessions = [summary('sess-6c', { cwd: workspace, title: undefined, updatedAt: 5, blank: true })]
    const { ctx: ctx1 } = makeCtx({ sessions, workspaces: [] })
    const controller1 = apply(ctx1, { autoStart: false, now: () => 0, backoff: () => 0 })
    await controller1.pump()
    assert.equal(ackFor(request).status, ATTACH_STATUS.UNREGISTERED)
    controller1.stop()

    // Restart: a new plugin instance re-seeds the pending follow-up from the ACK.
    sessions[0] = summary('sess-6c', { cwd: workspace, title: undefined, updatedAt: 5, blank: false })
    const { ctx: ctx2, emitted } = makeCtx({ sessions, workspaces: [] })
    const controller2 = apply(ctx2, { autoStart: false, now: () => 0, backoff: () => 0 })
    await controller2.followUpTitles()

    assert.ok(emitted.length >= 1, 'restarted plugin must resume the pending follow-up and republish')
    assert.equal(emitted[emitted.length - 1].args[0].blank, false)
    controller2.stop()
  })

  it('isolates a malformed queue file so the rest of the pump still runs', async () => {
    const workspace = await makeWorkspace()
    writeFileSync(join(queueDir, 'broken.json'), '{ not json')
    const request = writeRequest('T-7', 'sess-7', 'existing', workspace)
    const { ctx, byPath } = makeCtx({ sessions: [summary('sess-7')], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(ackFor(request).status, ATTACH_STATUS.UNREGISTERED)
    const bad = readdirSync(queueDir).filter((f) => f.includes('broken.json.bad-'))
    assert.equal(bad.length, 1, 'malformed file should be quarantined, not crash the pump')
    assert.equal(byPath.size, 0)
    controller.stop()
  })

  it('survives a plugin restart by continuing pending work from disk', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-8', 'sess-8', 'existing', workspace)
    const { ctx: ctx1 } = makeCtx({ sessions: [], workspaces: [] })
    const controller1 = apply(ctx1, { autoStart: false, now: () => 0, backoff: () => 0 })
    await controller1.pump()
    controller1.stop()

    const { ctx: ctx2, emitted } = makeCtx({ sessions: [summary('sess-8')], workspaces: [] })
    const controller2 = apply(ctx2, { autoStart: false, now: () => 0, backoff: () => 0 })
    await controller2.pump()

    assert.equal(ackFor(request).status, ATTACH_STATUS.UNREGISTERED)
    assert.equal(emitted[0].event, 'api-session/added')
    controller2.stop()
  })

  it('gives up with a durable failed ACK after the attempt budget', async () => {
    const workspace = await makeWorkspace()
    const request = writeRequest('T-9', 'sess-9', 'create', workspace)
    const requestFile = requestPath(queueDir, request.identity, request.canonicalWorkspace)
    const entry = JSON.parse(readFileSync(requestFile, 'utf8'))
    writeFileSync(requestFile, JSON.stringify({ ...entry, attempts: 59 }, undefined, 2))
    const { ctx } = makeCtx({ sessions: [], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(ackFor(request).status, ATTACH_STATUS.FAILED)
    assert.ok(!existsSync(requestFile), 'terminal failure removes the request')
    controller.stop()
  })

  it('migrates a legacy no-schema request to existing and reports unregistered', async () => {
    const workspace = await makeWorkspace()
    const legacy = {
      taskId: 'T-10',
      sessionId: 'sess-10',
      workspace,
      title: 'Legacy task',
      createdAt: new Date().toISOString(),
    }
    writeFileSync(legacyRequestPath(queueDir, 'T-10'), JSON.stringify(legacy, undefined, 2))
    const { ctx, emitted, byPath } = makeCtx({ sessions: [summary('sess-10')], workspaces: [] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.equal(byPath.size, 0, 'legacy migration never creates a workspace')
    assert.equal(emitted.length, 1, 'legacy request still publishes the catalog')
    const ack = readAttachAck(queueDir, { taskId: 'T-10', sessionId: 'sess-10', generation: 0 }, canonicalWorkspacePath(workspace))
    assert.equal(ack.status, ATTACH_STATUS.UNREGISTERED)
    assert.ok(!existsSync(legacyRequestPath(queueDir, 'T-10')), 'legacy request deleted after ack')
    controller.stop()
  })

  it('migrates a legacy request to existing and attaches an existing workspace', async () => {
    const workspace = await makeWorkspace()
    const ws = workspaceMock(canonicalWorkspacePath(workspace), 'proj')
    const legacy = { taskId: 'T-11', sessionId: 'sess-11', workspace, title: 'Legacy', createdAt: new Date().toISOString() }
    writeFileSync(legacyRequestPath(queueDir, 'T-11'), JSON.stringify(legacy, undefined, 2))
    const { ctx, byPath } = makeCtx({ sessions: [summary('sess-11', { cwd: workspace })], workspaces: [ws] })
    const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

    await controller.pump()

    assert.deepEqual(ws.attached, ['sess-11'])
    assert.equal(byPath.size, 1)
    const ack = readAttachAck(queueDir, { taskId: 'T-11', sessionId: 'sess-11', generation: 0 }, canonicalWorkspacePath(workspace))
    assert.equal(ack.status, ATTACH_STATUS.ATTACHED)
    controller.stop()
  })

  describe('per-identity race isolation (deferred list)', () => {
    it('success branch: old processing never deletes the new request', async () => {
      const workspace = await makeWorkspace()
      const oldRequest = writeRequest('T-race', 'old-session', 'create', workspace, { generation: 0 })
      const d = deferred()
      const { ctx } = makeCtx({ sessions: [], workspaces: [], listImpl: () => d.promise })
      const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

      const pumpPromise = controller.pump()
      // While the first file is blocked on list(), a new identity request lands.
      const newRequest = writeRequest('T-race', 'new-session', 'create', workspace, { generation: 1 })
      d.resolve({ items: [summary('old-session', { cwd: workspace })] })
      await pumpPromise

      assert.ok(existsSync(requestPath(queueDir, newRequest.identity, newRequest.canonicalWorkspace)), 'new request must survive')
      assert.ok(!existsSync(requestPath(queueDir, oldRequest.identity, oldRequest.canonicalWorkspace)), 'old request processed')
      assert.equal(ackFor(oldRequest).status, ATTACH_STATUS.ATTACHED)
      controller.stop()
    })

    it('unregistered branch: old terminal ack never clobbers the new request', async () => {
      const workspace = await makeWorkspace()
      const oldRequest = writeRequest('T-race2', 'old-session', 'existing', workspace, { generation: 0 })
      const d = deferred()
      const { ctx } = makeCtx({ sessions: [], workspaces: [], listImpl: () => d.promise })
      const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

      const pumpPromise = controller.pump()
      const newRequest = writeRequest('T-race2', 'new-session', 'existing', workspace, { generation: 1 })
      d.resolve({ items: [summary('old-session')] })
      await pumpPromise

      assert.ok(existsSync(requestPath(queueDir, newRequest.identity, newRequest.canonicalWorkspace)), 'new request must survive')
      assert.equal(ackFor(oldRequest).status, ATTACH_STATUS.UNREGISTERED)
      controller.stop()
    })

    it('transient branch: old retry rewrite never overwrites the new request', async () => {
      const workspace = await makeWorkspace()
      const oldRequest = writeRequest('T-race3', 'old-session', 'create', workspace, { generation: 0 })
      const d = deferred()
      const { ctx } = makeCtx({ sessions: [], workspaces: [], listImpl: () => d.promise })
      const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

      const pumpPromise = controller.pump()
      const newRequest = writeRequest('T-race3', 'new-session', 'create', workspace, { generation: 1 })
      d.resolve({ items: [] }) // old session not visible -> transient
      await pumpPromise

      const newFile = requestPath(queueDir, newRequest.identity, newRequest.canonicalWorkspace)
      assert.ok(existsSync(newFile), 'new request must survive the transient rewrite')
      const newContent = JSON.parse(readFileSync(newFile, 'utf8'))
      assert.equal(newContent.identity.sessionId, 'new-session', 'new request content must not be overwritten')
      const oldFile = requestPath(queueDir, oldRequest.identity, oldRequest.canonicalWorkspace)
      assert.ok(existsSync(oldFile), 'old request stays for retry')
      assert.equal(JSON.parse(readFileSync(oldFile, 'utf8')).attempts, 1)
      controller.stop()
    })

    it('failure branch: old terminal failed ack never removes the new request', async () => {
      const workspace = await makeWorkspace()
      const oldRequest = writeRequest('T-race4', 'old-session', 'create', workspace, { generation: 0 })
      const oldFile = requestPath(queueDir, oldRequest.identity, oldRequest.canonicalWorkspace)
      const entry = JSON.parse(readFileSync(oldFile, 'utf8'))
      writeFileSync(oldFile, JSON.stringify({ ...entry, attempts: 59 }, undefined, 2))
      const d = deferred()
      const { ctx } = makeCtx({ sessions: [], workspaces: [], listImpl: () => d.promise })
      const controller = apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })

      const pumpPromise = controller.pump()
      const newRequest = writeRequest('T-race4', 'new-session', 'create', workspace, { generation: 1 })
      d.resolve({ items: [] })
      await pumpPromise

      assert.ok(existsSync(requestPath(queueDir, newRequest.identity, newRequest.canonicalWorkspace)), 'new request must survive')
      assert.equal(ackFor(oldRequest).status, ATTACH_STATUS.FAILED)
      controller.stop()
    })
  })

  it('writes a heartbeat file readable by the bridge', async () => {
    const { ctx } = makeCtx({ sessions: [], workspaces: [] })
    const controller = apply(ctx, { autoStart: false })
    controller.stop()
    const heartbeat = JSON.parse(readFileSync(join(home, 'astra-dsh', 'heartbeat.json'), 'utf8'))
    assert.equal(typeof heartbeat.version, 'string')
    assert.equal(typeof heartbeat.at, 'string')
  })
})
