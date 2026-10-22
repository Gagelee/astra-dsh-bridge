import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOCK_CODEX, MOCK_CODEX_OUT } from './helpers.mjs'
import { after, describe, it } from 'node:test'
import { MOCK_ACP, makeWorkspace, startMcp } from './helpers.mjs'

chmodSync(MOCK_ACP, 0o755)

function mockEnv(workspace) {
  return {
    ASTRA_DSH_DSH_BIN: MOCK_ACP,
    ASTRA_DSH_DSH_HOME: join(workspace, '.astra-dsh', 'mock-dsh-home'),
    ASTRA_DSH_HOME: join(workspace, '.mock-bridge-home'),
    ASTRA_DSH_MODEL: 'mock-model',
    ASTRA_DSH_EFFORT: 'low',
    ASTRA_DSH_PERMISSION_POLICY: 'allow',
    ASTRA_DSH_EXECUTION_BACKEND: 'acp',
    ASTRA_DSH_CODEX_BIN: MOCK_CODEX,
    ASTRA_DSH_NOTIFY_CODEX: '1',
    MOCK_CODEX_OUT: MOCK_CODEX_OUT(workspace),
  }
}

async function newBridge() {
  const workspace = await makeWorkspace()
  writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
  const mcp = startMcp({ cwd: workspace, env: mockEnv(workspace) })
  await mcp.request('initialize', {
    protocolVersion: '2025-06-18',
    clientCapabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })
  return { workspace, mcp }
}

describe('Astra ↔ DSH bridge', () => {
  it('exposes the planning and execution tool surface', async () => {
    const { mcp } = await newBridge()
    try {
      const listed = await mcp.request('tools/list', {})
      const names = listed.tools.map((tool) => tool.name)
      for (const expected of ['astra_inbox', 'astra_lock', 'dsh_dispatch', 'dsh_status', 'dsh_wait', 'dsh_message', 'dsh_cancel', 'dsh_result', 'dsh_review']) {
        assert.ok(names.includes(expected), `missing tool ${expected}`)
      }
      assert.ok(listed.tools.every((tool) => tool.inputSchema?.type === 'object'))
    } finally {
      await mcp.close()
    }
  })

  it('dispatches a complete packet, streams progress, and reviews the result', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Mock feature',
        goal: 'Create dsh-output.txt and prove the mock turn ran.',
        context: 'Shared workspace integration test. No network is needed.',
        files: ['seed.txt — existing input'],
        constraints: ['Do not touch seed.txt'],
        acceptance: ['dsh-output.txt contains MOCK_DONE', 'dsh-second-file.txt exists'],
        deliverables: ['dsh-output.txt'],
        outOfScope: ['Deployment'],
        notes: 'Keep it small.',
        writeScopes: ['dsh-output.txt'],
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      const { taskId, sessionId, state } = dispatched.structured
      assert.match(taskId, /^T-\d{8}-\d{6}-[a-f0-9]{4}$/)
      assert.equal(sessionId, 'mock-session-1')
      assert.equal(state, 'running')

      const taskDir = join(workspace, '.astra-dsh', 'tasks', taskId)
      const packet = readFileSync(join(taskDir, 'task.md'), 'utf8')
      assert.match(packet, /## Goal/)
      assert.match(packet, /dsh-output\.txt contains MOCK_DONE/)
      assert.match(packet, /Do not touch seed\.txt/)

      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
      assert.equal(waited.isError, false, waited.text)
      assert.equal(waited.structured.state, 'idle')
      assert.equal(waited.structured.reviewMode, 'light')
      assert.equal(waited.structured.stopReason, 'end_turn')
      assert.match(waited.structured.lastAssistantText, /MOCK_DONE/)
      const changed = waited.structured.changedFiles.map((entry) => entry.path)
      assert.ok(changed.includes('dsh-output.txt'))
      assert.ok(changed.includes('dsh-second-file.txt'))

      assert.match(readFileSync(join(workspace, 'dsh-output.txt'), 'utf8'), /MOCK_DONE/)
      assert.ok(existsSync(join(workspace, 'dsh-second-file.txt')))

      const readBack = await mcp.call('dsh_read_file', { workspace, taskId, path: 'dsh-output.txt' })
      assert.equal(readBack.isError, false, readBack.text)
      assert.match(readBack.structured.content, /MOCK_DONE/)
      assert.equal(readBack.structured.sha256.length, 64)
      assert.equal(readBack.structured.path, 'dsh-output.txt')
      const escaped = await mcp.call('dsh_read_file', { workspace, path: '/etc/hosts' })
      assert.equal(escaped.isError, true)
      assert.match(escaped.text, /PATH_ESCAPE|escapes the shared workspace/)

      const result = await mcp.call('dsh_result', { workspace, taskId })
      assert.equal(result.structured.state, 'idle')
      assert.match(result.structured.finalText, /MOCK_DONE/)
      assert.deepEqual(result.structured.questions, [])
      assert.match(result.text, /Files changed/)

      const follow = await mcp.call('dsh_message', {
        workspace,
        taskId,
        message: 'Follow-up: ASK_QUESTION before choosing an option.',
      })
      assert.equal(follow.structured.queued, false)
      const waitedAgain = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
      assert.equal(waitedAgain.structured.state, 'idle')
      assert.match(waitedAgain.structured.lastAssistantText, /turn=2/)
      assert.deepEqual(waitedAgain.structured.questions, ['Should the mock use option A or option B?'])

      const review = await mcp.call('dsh_review', {
        workspace,
        taskId,
        decision: 'changes_requested',
        notes: 'Please answer the question and continue.',
      })
      assert.equal(review.structured.state, 'changes_requested')
      assert.ok(existsSync(join(taskDir, 'review.md')))

      const accepted = await mcp.call('dsh_review', { workspace, taskId, decision: 'accepted', notes: 'Looks good.' })
      assert.equal(accepted.structured.state, 'accepted')
      const stored = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'))
      assert.equal(stored.review.decision, 'accepted')
      assert.equal(stored.workspace, workspace)
    } finally {
      await mcp.close()
    }
  })

  it('serializes writers through the workspace lock', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const acquired = await mcp.call('astra_lock', { workspace, action: 'acquire', note: 'planner inspection' })
      assert.equal(acquired.isError, false, acquired.text)
      const blocked = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Blocked task',
        goal: 'Should not start while Astra holds the lock.',
        acceptance: ['nothing'],
      })
      assert.equal(blocked.isError, true)
      assert.match(blocked.text, /LOCK_HELD|locked by astra/)

      const released = await mcp.call('astra_lock', { workspace, action: 'release' })
      assert.equal(released.isError, false, released.text)

      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Locked execution',
        goal: 'SLOW work so the DSH lock is observable.',
        acceptance: ['a turn starts'],
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      const taskId = dispatched.structured.taskId

      const status = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(status.structured.lock.owner, 'dsh')
      assert.equal(status.structured.lock.taskId, taskId)

      const blockedAstra = await mcp.call('astra_lock', { workspace, action: 'acquire' })
      assert.equal(blockedAstra.isError, true)
      assert.match(blockedAstra.text, /LOCK_HELD|locked by dsh/)

      const cancelled = await mcp.call('dsh_cancel', { workspace, taskId })
      assert.equal(cancelled.structured.state, 'cancelled')
      const afterCancel = await mcp.call('astra_status', { workspace })
      assert.equal(afterCancel.structured.lock, null)
    } finally {
      await mcp.close()
    }
  })

  it('lets DSH drop a request that Astra can pick up and claim', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const created = await mcp.call('astra_request_create', {
        workspace,
        title: 'Add CSV export',
        body: 'The user wants CSV export from the report screen. Must include UTF-8 BOM.',
        origin: 'dsh',
        priority: 'high',
      })
      assert.equal(created.isError, false, created.text)
      const requestId = created.structured.id

      const inbox = await mcp.call('astra_inbox', { workspace })
      assert.match(inbox.text, /Add CSV export/)
      assert.equal(inbox.structured.requests.length, 1)

      const read = await mcp.call('astra_request_read', { workspace, requestId })
      assert.match(read.text, /UTF-8 BOM/)

      const claimed = await mcp.call('astra_request_claim', {
        workspace,
        requestId,
        planMarkdown: '1. Inspect report screen\n2. Add exporter\n3. Test',
      })
      assert.equal(claimed.structured.state, 'planned')
      assert.match(readFileSync(join(workspace, '.astra-dsh', 'requests', requestId, 'plan.md'), 'utf8'), /Add exporter/)

      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Implement CSV export',
        goal: 'Add CSV export to the report screen.',
        acceptance: ['CSV export button works', 'BOM present'],
        requestId,
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      await mcp.call('dsh_review', { workspace, taskId: dispatched.structured.taskId, decision: 'accepted' })
      const request = JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'requests', requestId, 'request.json'), 'utf8'))
      assert.equal(request.state, 'done')
      assert.ok(request.linkedTasks.includes(dispatched.structured.taskId))
    } finally {
      await mcp.close()
    }
  })

  it('records ACP permission decisions instead of hanging unattended', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Permission path',
        goal: 'NEED_PERMISSION to prove the bridge answers ACP prompts.',
        acceptance: ['the turn completes'],
      })
      const waited = await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'idle')
      assert.equal(waited.structured.permissionDecisions.length, 1)
      assert.equal(waited.structured.permissionDecisions[0].decision, 'allow')
      assert.match(waited.structured.lastAssistantText, /permission=allow-once/)
    } finally {
      await mcp.close()
    }
  })

  it('auto-accepts only when verification passes inside declared write scopes', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const request = await mcp.call('astra_request_create', {
        workspace,
        title: 'Auto acceptance request',
        body: 'Low-risk deterministic change.',
        origin: 'codex',
      })
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Auto review pass',
        goal: 'Create the mock output files.',
        acceptance: ['dsh-output.txt contains MOCK_DONE', 'dsh-second-file.txt exists'],
        writeScopes: ['dsh-output.txt', 'dsh-second-file.txt'],
        verifyCommands: ['test -f dsh-output.txt', 'grep -q MOCK_DONE dsh-output.txt'],
        reviewMode: 'auto',
        requestId: request.structured.id,
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      const waited = await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'accepted')
      assert.equal(waited.structured.review.mode, 'auto')
      assert.equal(waited.structured.verification.ok, true)
      assert.equal(waited.structured.verification.checks.length, 2)
      assert.equal(waited.structured.autoReview.eligible, true)
      assert.ok(existsSync(join(workspace, '.astra-dsh', 'tasks', dispatched.structured.taskId, 'verification.json')))
      const storedRequest = JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'requests', request.structured.id, 'request.json'), 'utf8'))
      assert.equal(storedRequest.state, 'done')
      assert.deepEqual(storedRequest.linkedTasks, [dispatched.structured.taskId])
      const result = await mcp.call('dsh_result', { workspace, taskId: dispatched.structured.taskId })
      assert.equal(result.structured.review.mode, 'auto')
      assert.equal(result.structured.verification.ok, true)
      assert.match(result.text, /Verification/)
    } finally {
      await mcp.close()
    }
  })

  it('blocks auto-acceptance when verification fails and leaves it for Astra', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Auto review fail',
        goal: 'Create the mock output files.',
        acceptance: ['a deliberately missing file exists'],
        writeScopes: ['dsh-output.txt', 'dsh-second-file.txt'],
        verifyCommands: ['test -f definitely-missing.txt'],
        reviewMode: 'auto',
      })
      const waited = await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'idle')
      assert.equal(waited.structured.verification.ok, false)
      assert.equal(waited.structured.autoReview.eligible, false)
      assert.ok(waited.structured.autoReview.reasons.some((reason) => /verification/.test(reason)))
      const review = await mcp.call('dsh_review', {
        workspace,
        taskId: dispatched.structured.taskId,
        decision: 'accepted',
        notes: 'Planner reviewed despite failed automation.',
      })
      assert.equal(review.structured.state, 'accepted')
    } finally {
      await mcp.close()
    }
  })

  it('blocks auto-acceptance on questions or undeclared write scopes', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const questionTask = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Auto review question',
        goal: 'ASK_QUESTION about the mock option.',
        acceptance: ['the mock files exist'],
        writeScopes: ['dsh-output.txt', 'dsh-second-file.txt'],
        verifyCommands: ['test -f dsh-output.txt'],
        reviewMode: 'auto',
      })
      const questionWait = await mcp.call('dsh_wait', { workspace, taskId: questionTask.structured.taskId, timeoutSec: 30 })
      assert.equal(questionWait.structured.state, 'idle')
      assert.equal(questionWait.structured.autoReview.eligible, false)
      assert.ok(questionWait.structured.autoReview.reasons.some((reason) => /question/i.test(reason)))

      const scopeTask = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Auto review scope',
        goal: 'Create two files but declare only one scope.',
        acceptance: ['the mock files exist'],
        writeScopes: ['dsh-output.txt'],
        verifyCommands: ['test -f dsh-output.txt'],
        reviewMode: 'auto',
      })
      const scopeWait = await mcp.call('dsh_wait', { workspace, taskId: scopeTask.structured.taskId, timeoutSec: 30 })
      assert.equal(scopeWait.structured.state, 'idle')
      assert.equal(scopeWait.structured.autoReview.eligible, false)
      assert.ok(scopeWait.structured.autoReview.reasons.some((reason) => /outside writeScopes/.test(reason)))
    } finally {
      await mcp.close()
    }
  })

  it('runs verification for light review without auto-accepting', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Light review',
        goal: 'Create the mock output files.',
        acceptance: ['the mock files exist'],
        writeScopes: ['dsh-output.txt', 'dsh-second-file.txt'],
        verifyCommands: ['test -f dsh-output.txt'],
        reviewMode: 'light',
      })
      const waited = await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'idle')
      assert.equal(waited.structured.reviewMode, 'light')
      assert.equal(waited.structured.verification.ok, true)
      assert.equal(waited.structured.autoReview, null)
      const review = await mcp.call('dsh_review', { workspace, taskId: dispatched.structured.taskId, decision: 'accepted' })
      assert.equal(review.structured.state, 'accepted')
    } finally {
      await mcp.close()
    }
  })

  it('rejects auto review without verification commands', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Bad auto review',
        goal: 'No verification supplied.',
        acceptance: ['nothing'],
        reviewMode: 'auto',
      })
      assert.equal(dispatched.isError, true)
      assert.match(dispatched.text, /requires at least one verifyCommands/)
    } finally {
      await mcp.close()
    }
  })

  it('requires Astra\'s implementation plan and write scopes for implementation tasks', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const missingPlan = await mcp.request('tools/call', {
        name: 'dsh_dispatch',
        arguments: {
          workspace,
          title: 'No plan',
          goal: 'Do something',
          acceptance: ['something'],
          writeScopes: ['dsh-output.txt'],
        },
      })
      assert.equal(missingPlan.isError, true)
      assert.match(missingPlan.content[0].text, /implementationPlan/)

      const missingScope = await mcp.request('tools/call', {
        name: 'dsh_dispatch',
        arguments: {
          workspace,
          title: 'No scope',
          goal: 'Do something',
          implementationPlan: 'Change the output file.',
          acceptance: ['something'],
        },
      })
      assert.equal(missingScope.isError, true)
      assert.match(missingScope.content[0].text, /writeScopes/)
    } finally {
      await mcp.close()
    }
  })

  it('wakes the same Codex thread via codex queue when a task settles', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.callWithMeta('dsh_dispatch', {
        workspace,
        title: 'Notify same thread',
        goal: 'Create the mock output files.',
        implementationPlan: 'Run the mock turn and create dsh-output.txt.',
        acceptance: ['dsh-output.txt exists'],
        writeScopes: ['dsh-output.txt', 'dsh-second-file.txt'],
        verifyCommands: ['test -f dsh-output.txt'],
        reviewMode: 'light',
      }, { threadId: 'thread-e2e-1', sessionId: 'thread-e2e-1' })
      assert.equal(dispatched.isError, false, dispatched.text)
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const calls = readFileSync(MOCK_CODEX_OUT(workspace), 'utf8').trim().split('\n').filter(Boolean)
      assert.ok(calls.length >= 1, 'codex queue was not invoked')
      const args = JSON.parse(calls[0]).args
      assert.deepEqual(args.slice(0, 3), ['queue', '--thread', 'thread-e2e-1'])
      assert.match(args[3], /--message/)
      assert.match(args[4], /T-/)
      assert.match(args[4], /settled/)
    } finally {
      await mcp.close()
    }
  })

  it('suppresses the completion trigger while dsh_wait is active', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.callWithMeta('dsh_dispatch', {
        workspace,
        title: 'Wait suppression',
        goal: 'Create the mock output files.',
        implementationPlan: 'Run the mock turn and create dsh-output.txt.',
        acceptance: ['dsh-output.txt exists'],
        writeScopes: ['dsh-output.txt'],
      }, { threadId: 'thread-wait-1', sessionId: 'thread-wait-1' })
      assert.equal(dispatched.isError, false, dispatched.text)
      const waited = await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'idle')
      await new Promise((resolve) => setTimeout(resolve, 2000))
      assert.equal(existsSync(MOCK_CODEX_OUT(workspace)), false, 'completion trigger should be suppressed during dsh_wait')
    } finally {
      await mcp.close()
    }
  })

  it('cancels a running turn and can resume the session afterwards', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Slow task',
        goal: 'The first turn completes quickly so cancellation can target a later turn.',
        acceptance: ['cancellation works'],
      })
      const taskId = dispatched.structured.taskId
      await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })

      const slow = await mcp.call('dsh_message', { workspace, taskId, message: 'SLOW: hold this turn until cancelled.' })
      assert.equal(slow.isError, false, slow.text)
      const running = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(running.structured.state, 'running')

      const cancelled = await mcp.call('dsh_cancel', { workspace, taskId }, 90_000)
      assert.equal(cancelled.structured.state, 'cancelled')
      const status = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(status.structured.state, 'cancelled')

      const resumed = await mcp.call('dsh_message', { workspace, taskId, message: 'Recover with a quick turn.' })
      assert.equal(resumed.isError, false, resumed.text)
      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'idle')
      assert.match(waited.structured.lastAssistantText, /MOCK_DONE/)
    } finally {
      await mcp.close()
    }
  })

  it('survives a bridge restart by resuming or recreating the DSH session', async () => {
    const workspace = await makeWorkspace()
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const env = mockEnv(workspace)
    let mcp = startMcp({ cwd: workspace, env })
    await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
    let taskId
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Restart task',
        goal: 'Finish one turn, then continue after the bridge restarts.',
        acceptance: ['continuation works'],
      })
      taskId = dispatched.structured.taskId
      await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
    } finally {
      await mcp.close()
    }

    mcp = startMcp({ cwd: workspace, env })
    try {
      await mcp.request('initialize', { protocolVersion: '2025-06-18', clientCapabilities: {} })
      const resumed = await mcp.call('dsh_message', { workspace, taskId, message: 'Continue after restart.' })
      assert.equal(resumed.isError, false, resumed.text)
      const waited = await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'idle')
      assert.equal(waited.structured.turn, 2)
      assert.match(waited.structured.lastAssistantText, /MOCK_DONE/)
      const stored = JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'tasks', taskId, 'task.json'), 'utf8'))
      assert.equal(stored.sessionRecreated, true)
    } finally {
      await mcp.close()
    }
  })

  it('reports a failed ACP turn without corrupting the board', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Failure task',
        goal: 'FAIL deliberately.',
        acceptance: ['failure is recorded'],
      })
      const waited = await mcp.call('dsh_wait', { workspace, taskId: dispatched.structured.taskId, timeoutSec: 30 })
      assert.equal(waited.structured.state, 'failed')
      assert.match(waited.structured.error, /mock failure/)
      const result = await mcp.call('dsh_result', { workspace, taskId: dispatched.structured.taskId })
      assert.equal(result.structured.state, 'failed')
      assert.match(result.text, /State:\*\* failed|State: failed|failed/)
    } finally {
      await mcp.close()
    }
  })
})

after(() => {
  // Nothing global to clean up; each test closes its own server and temp dir.
  void execFileSync
})
