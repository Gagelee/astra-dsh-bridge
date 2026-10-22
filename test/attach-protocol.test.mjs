import assert from 'node:assert/strict'
import { readFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  ATTACH_STATUS,
  DEFAULT_GUI_POLICY,
  TERMINAL_STATUSES,
  ackPath,
  attachIdentity,
  canonicalWorkspacePath,
  identityFileBase,
  identityKey,
  identityMatches,
  legacyRequestPath,
  migrateLegacyRequest,
  normalizeGuiPolicy,
  readAttachAck,
  renderAttachAck,
  renderAttachRequest,
  requestPath,
  validateAttachAck,
  validateAttachRequest,
  writeAttachAck,
  writeAttachRequest,
} from '../src/attach.mjs'
import { makeWorkspace } from './helpers.mjs'

describe('attach protocol', () => {
  it('normalizes guiPolicy with existing as the default and rejects junk', () => {
    assert.equal(normalizeGuiPolicy(undefined), 'existing')
    assert.equal(normalizeGuiPolicy(''), 'existing')
    assert.equal(normalizeGuiPolicy('create'), 'create')
    assert.equal(normalizeGuiPolicy('off'), 'off')
    assert.throws(() => normalizeGuiPolicy('bogus'), /guiPolicy/)
    assert.equal(DEFAULT_GUI_POLICY, 'existing')
  })

  it('canonicalizes aliased workspace paths through realpath', async () => {
    const real = await makeWorkspace()
    const alias = `${real}-symlink`
    symlinkSync(real, alias)
    try {
      assert.equal(canonicalWorkspacePath(alias), canonicalWorkspacePath(real))
    } finally {
      // Symlink left in tmpdir; cleaned by the OS.
    }
  })

  it('round-trips a request and ACK through per-identity paths', async () => {
    const workspace = await makeWorkspace()
    const queueDir = join(workspace, 'attach')
    const request = renderAttachRequest({
      taskId: 'T-20261022-120000-aaaa',
      sessionId: 'mock-session-1',
      generation: 0,
      workspace,
      title: 'Some task',
      policy: 'existing',
    })
    const path = writeAttachRequest(queueDir, request)
    assert.equal(path, requestPath(queueDir, request.identity, request.canonicalWorkspace))
    assert.equal(identityKey(request.identity), 'T-20261022-120000-aaaa@mock-session-1#0')
    assert.ok(path.includes('mock-session-1'))

    const ack = renderAttachAck({
      identity: request.identity,
      workspace,
      canonicalWorkspace: request.canonicalWorkspace,
      sessionId: 'mock-session-1',
      status: ATTACH_STATUS.ATTACHED,
      attempts: 1,
    })
    writeAttachAck(queueDir, ack)
    const readBack = readAttachAck(queueDir, request.identity, request.canonicalWorkspace)
    assert.equal(readBack.status, ATTACH_STATUS.ATTACHED)
    assert.equal(readBack.identity.sessionId, 'mock-session-1')
    assert.ok(validateAttachAck(readBack).ok)
    assert.equal(ackPath(queueDir, request.identity, request.canonicalWorkspace).endsWith('.ack.json'), true)
  })

  it('gives each identity + workspace a distinct immutable filename', async () => {
    const wsA = await makeWorkspace()
    const wsB = await makeWorkspace()
    const baseA = identityFileBase({ taskId: 'T-1', sessionId: 's-1', generation: 0 }, canonicalWorkspacePath(wsA))
    const baseA2 = identityFileBase({ taskId: 'T-1', sessionId: 's-1', generation: 0 }, canonicalWorkspacePath(wsA))
    const baseB = identityFileBase({ taskId: 'T-1', sessionId: 's-2', generation: 0 }, canonicalWorkspacePath(wsA))
    const baseGen = identityFileBase({ taskId: 'T-1', sessionId: 's-1', generation: 1 }, canonicalWorkspacePath(wsA))
    const baseWs = identityFileBase({ taskId: 'T-1', sessionId: 's-1', generation: 0 }, canonicalWorkspacePath(wsB))
    assert.equal(baseA, baseA2, 'same identity + workspace is deterministic')
    assert.notEqual(baseA, baseB)
    assert.notEqual(baseA, baseGen)
    assert.notEqual(baseA, baseWs)
  })

  it('rejects requests with a path-traversing identity, bad policy, or missing workspace', async () => {
    const base = renderAttachRequest({
      taskId: 'T-1',
      sessionId: 'mock-session-1',
      workspace: process.cwd(),
      policy: 'existing',
    })
    assert.equal(validateAttachRequest(base).ok, true)

    assert.equal(validateAttachRequest({ ...base, identity: { ...base.identity, taskId: '../etc' } }).ok, false)
    assert.equal(validateAttachRequest({ ...base, identity: { ...base.identity, sessionId: 'x/y' } }).ok, false)
    assert.equal(validateAttachRequest({ ...base, identity: { ...base.identity, generation: -1 } }).ok, false)
    assert.equal(validateAttachRequest({ ...base, identity: { ...base.identity, generation: 1.5 } }).ok, false)
    assert.equal(validateAttachRequest({ ...base, policy: 'delete' }).ok, false)
    assert.equal(validateAttachRequest({ ...base, workspace: '' }).ok, false)
    assert.equal(validateAttachRequest({ ...base, canonicalWorkspace: '' }).ok, false)
    assert.equal(validateAttachRequest(null).ok, false)
  })

  it('rejects ACKs with an unknown status, bad generation, or mismatched schema', async () => {
    const workspace = await makeWorkspace()
    const ack = renderAttachAck({
      identity: { taskId: 'T-1', sessionId: 'mock-session-1', generation: 0 },
      workspace,
      canonicalWorkspace: workspace,
      sessionId: 'mock-session-1',
      status: ATTACH_STATUS.ATTACHED,
    })
    assert.equal(validateAttachAck(ack).ok, true)
    assert.equal(validateAttachAck({ ...ack, status: 'rendered' }).ok, false)
    assert.equal(validateAttachAck({ ...ack, schema: 99 }).ok, false)
    assert.equal(validateAttachAck({ ...ack, identity: { taskId: 'T-1', sessionId: 's', generation: -2 } }).ok, false)
    assert.equal(validateAttachAck({ ...ack, canonicalWorkspace: '' }).ok, false)
  })

  it('defines terminal and non-terminal statuses (off is terminal, no catalog-published)', () => {
    for (const status of [ATTACH_STATUS.UNREGISTERED, ATTACH_STATUS.ATTACHED, ATTACH_STATUS.FAILED, ATTACH_STATUS.OFF]) {
      assert.ok(TERMINAL_STATUSES.has(status), `${status} should be terminal`)
    }
    assert.ok(!TERMINAL_STATUSES.has(ATTACH_STATUS.QUEUED))
    assert.ok(!TERMINAL_STATUSES.has(ATTACH_STATUS.WAITING_SESSION))
    assert.ok(!TERMINAL_STATUSES.has(ATTACH_STATUS.PRIVATE_HOME))
    assert.equal(ATTACH_STATUS.CATALOG_PUBLISHED, undefined)
  })

  it('migrates a legacy no-schema request to guiPolicy=existing and rejects invalid ones', async () => {
    const workspace = await makeWorkspace()
    const migrated = migrateLegacyRequest({
      taskId: 'T-20261022-120000-bbbb',
      sessionId: 'mock-session-2',
      workspace,
      title: 'Legacy',
      createdAt: new Date().toISOString(),
    })
    assert.equal(migrated.ok, true)
    assert.equal(migrated.request.policy, 'existing')
    assert.equal(migrated.request.identity.generation, 0)
    assert.equal(migrated.request.canonicalWorkspace, canonicalWorkspacePath(workspace))

    assert.equal(migrateLegacyRequest({ taskId: 'T-1', sessionId: 's', workspace: 'relative/path' }).ok, false)
    assert.equal(migrateLegacyRequest({ taskId: '../T-1', sessionId: 's', workspace }).ok, false)
    assert.equal(migrateLegacyRequest({ taskId: 'T-1', sessionId: 's/x', workspace }).ok, false)
    assert.equal(migrateLegacyRequest({ taskId: 'T-1', sessionId: 's' }).ok, false)
  })

  it('computes identity matches on task/session/generation only', () => {
    assert.equal(identityMatches({ taskId: 'T-1', sessionId: 's', generation: 0 }, { taskId: 'T-1', sessionId: 's', generation: 0 }), true)
    assert.equal(identityMatches({ taskId: 'T-1', sessionId: 's', generation: 0 }, { taskId: 'T-1', sessionId: 's', generation: 1 }), false)
    assert.equal(identityMatches({ taskId: 'T-1', sessionId: 's', generation: 0 }, { taskId: 'T-1', sessionId: 'x', generation: 0 }), false)
    assert.equal(identityMatches(null, { taskId: 'T-1', sessionId: 's', generation: 0 }), false)
  })

  it('keeps legacy and per-identity filenames strictly inside the queue dir', async () => {
    const workspace = await makeWorkspace()
    const queueDir = join(workspace, 'attach')
    const request = renderAttachRequest({ taskId: 'T-20261022-120000-cccc', sessionId: 'mock-session-3', workspace, policy: 'off' })
    const path = writeAttachRequest(queueDir, request)
    assert.ok(path.startsWith(queueDir))
    assert.equal(legacyRequestPath(queueDir, 'T-1'), join(queueDir, 'T-1.json'))
    assert.throws(() => attachIdentity({ taskId: 'T-1', sessionId: 's', generation: -1 }), /generation/)
  })
})
