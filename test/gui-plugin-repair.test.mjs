import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  executeRepair,
  processRepairs,
  REPAIR_SCHEMA,
  validateRepairRequest,
} from '../gui-plugin/repair.js'

function request(overrides = {}) {
  return {
    schema: REPAIR_SCHEMA,
    id: 'cleanup-test-workspaces',
    action: 'archive-and-delete',
    targets: [{
      workspacePath: '/tmp/test-workspace',
      workspaceId: 'ws-1',
      sessionIds: ['sess-1'],
      reason: 'test',
    }],
    ...overrides,
  }
}

function makeCtx({ workspace = { id: 'ws-1', path: '/tmp/test-workspace', sessionIds: ['sess-1'] }, running = [] } = {}) {
  const state = { archived: [], deleted: [], workspace }
  const ctx = {
    workspaceRegistry: {
      resolveByPath: async (path) => (state.workspace?.path === path ? state.workspace : undefined),
      archiveSession: async (sessionId) => { state.archived.push(sessionId) },
      delete: async (id) => { state.deleted.push(id); return id === 'ws-1' },
    },
    sessionController: {
      list: async () => ({ items: running.map((sessionId) => ({ sessionId, running: true })) }),
    },
  }
  return { ctx, state }
}

describe('GUI workspace repair queue', () => {
  let dir
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('archives the exact session set and deletes only the matching workspace', async () => {
    const checked = validateRepairRequest(request())
    assert.equal(checked.ok, true)
    const { ctx, state } = makeCtx()
    const ack = await executeRepair(ctx, checked.request)
    assert.equal(ack.ok, true)
    assert.deepEqual(state.archived, ['sess-1'])
    assert.deepEqual(state.deleted, ['ws-1'])
    assert.equal(ack.results[0].deleted, true)
  })

  it('aborts without mutating on a workspace id mismatch', async () => {
    const checked = validateRepairRequest(request({
      targets: [{ workspacePath: '/tmp/test-workspace', workspaceId: 'ws-other', sessionIds: ['sess-1'] }],
    }))
    const { ctx, state } = makeCtx()
    const ack = await executeRepair(ctx, checked.request)
    assert.equal(ack.ok, false)
    assert.deepEqual(state.archived, [])
    assert.deepEqual(state.deleted, [])
    assert.match(ack.results[0].error, /id mismatch/)
  })

  it('aborts when the workspace contains an extra business session', async () => {
    const checked = validateRepairRequest(request())
    assert.equal(checked.ok, true)
    const { ctx, state } = makeCtx({
      workspace: { id: 'ws-1', path: '/tmp/test-workspace', sessionIds: ['sess-1', 'business-session'] },
    })
    const ack = await executeRepair(ctx, checked.request)
    assert.equal(ack.ok, false)
    assert.deepEqual(state.archived, [])
    assert.deepEqual(state.deleted, [])
    assert.match(ack.results[0].error, /session set mismatch/)
  })

  it('refuses a workspace whose session is still running', async () => {
    const checked = validateRepairRequest(request())
    const { ctx, state } = makeCtx({ running: ['sess-1'] })
    const ack = await executeRepair(ctx, checked.request)
    assert.equal(ack.ok, false)
    assert.deepEqual(state.archived, [])
    assert.match(ack.results[0].error, /still running/)
  })

  it('rejects unsafe or unsupported requests', () => {
    assert.equal(validateRepairRequest({ ...request(), schema: 2 }).ok, false)
    assert.equal(validateRepairRequest({ ...request(), action: 'delete-everything' }).ok, false)
    assert.equal(validateRepairRequest({ ...request(), id: '../escape' }).ok, false)
    const duplicate = request({
      targets: [{ workspacePath: '/tmp/test-workspace', workspaceId: 'ws-1', sessionIds: ['sess-1', 'sess-1'] }],
    })
    assert.equal(validateRepairRequest(duplicate).ok, false)
  })

  it('writes a durable ack and removes a successful request', async () => {
    dir = mkdtempSync(join(tmpdir(), 'astra-dsh-repair-'))
    writeFileSync(join(dir, 'cleanup.json'), JSON.stringify(request(), undefined, 2))
    const { ctx, state } = makeCtx()
    const outcomes = await processRepairs(ctx, dir)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].ok, true)
    assert.deepEqual(state.archived, ['sess-1'])
    assert.equal(existsSync(join(dir, 'cleanup.json')), false)
    const ack = JSON.parse(readFileSync(join(dir, 'cleanup-test-workspaces.ack.json'), 'utf8'))
    assert.equal(ack.ok, true)
    assert.equal(ack.results[0].workspaceId, 'ws-1')
  })

  it('quarantines malformed requests without touching a workspace', async () => {
    dir = mkdtempSync(join(tmpdir(), 'astra-dsh-repair-'))
    writeFileSync(join(dir, 'broken.json'), '{ nope')
    const { ctx, state } = makeCtx()
    const outcomes = await processRepairs(ctx, dir)
    assert.equal(outcomes[0].ok, false)
    assert.deepEqual(state.archived, [])
    assert.ok(readdirSync(dir).some((name) => name.startsWith('broken.json.bad-')))
  })
})
