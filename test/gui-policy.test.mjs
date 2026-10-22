import assert from 'node:assert/strict'
import { readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { MOCK_ACP, MOCK_CODEX, MOCK_CODEX_OUT, makeWorkspace, startMcp } from './helpers.mjs'

function mockEnv(workspace) {
  return {
    ASTRA_DSH_DSH_BIN: MOCK_ACP,
    ASTRA_DSH_DSH_HOME: join(workspace, '.astra-dsh', 'mock-dsh-home'),
    ASTRA_DSH_HOME: join(workspace, '.mock-bridge-home'),
    ASTRA_DSH_MODEL: 'mock-model',
    ASTRA_DSH_EFFORT: 'low',
    ASTRA_DSH_PERMISSION_POLICY: 'allow',
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

function taskJson(workspace, taskId) {
  return JSON.parse(readFileSync(join(workspace, '.astra-dsh', 'tasks', taskId, 'task.json'), 'utf8'))
}

/** The per-identity request file path the bridge recorded for this task. */
function attachRequestFile(workspace, taskId) {
  return taskJson(workspace, taskId).attachQueuedAt
}

describe('GUI policy through the bridge', () => {
  it('defaults to guiPolicy=existing and writes a canonicalized request', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Default policy',
        goal: 'Create the mock output files.',
        acceptance: ['the mock files exist'],
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      assert.equal(dispatched.structured.guiPolicy, 'existing')
      const taskId = dispatched.structured.taskId
      await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })

      const requestFile = attachRequestFile(workspace, taskId)
      assert.ok(requestFile, 'request file path is recorded')
      const request = JSON.parse(readFileSync(requestFile, 'utf8'))
      assert.equal(request.policy, 'existing')
      assert.equal(request.canonicalWorkspace, realpathSync(workspace))

      const status = await mcp.call('dsh_status', { workspace, taskId })
      assert.equal(status.structured.guiPolicy, 'existing')
      assert.equal(status.structured.guiStatus, 'queued')
      assert.equal(status.structured.sessionId, 'mock-session-1')
    } finally {
      await mcp.close()
    }
  })

  it('propagates explicit create and off policies', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const create = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Create policy',
        goal: 'Create the mock output files.',
        acceptance: ['the mock files exist'],
        guiPolicy: 'create',
        guiWorkspaceTitle: 'My Workspace',
      })
      assert.equal(create.structured.guiPolicy, 'create')
      const createTask = create.structured.taskId
      await mcp.call('dsh_wait', { workspace, taskId: createTask, timeoutSec: 30 })
      const createRequest = JSON.parse(readFileSync(attachRequestFile(workspace, createTask), 'utf8'))
      assert.equal(createRequest.policy, 'create')
      assert.equal(createRequest.title, 'My Workspace')

      const off = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Off policy',
        goal: 'Create the mock output files.',
        acceptance: ['the mock files exist'],
        guiPolicy: 'off',
      })
      const offTask = off.structured.taskId
      await mcp.call('dsh_wait', { workspace, taskId: offTask, timeoutSec: 30 })
      assert.equal(attachRequestFile(workspace, offTask), null, 'off policy must not enqueue')
      const status = await mcp.call('dsh_status', { workspace, taskId: offTask })
      assert.equal(status.structured.guiStatus, 'off')
    } finally {
      await mcp.close()
    }
  })

  it('deduplicates a workspace through a symlink alias (realpath normalization)', async () => {
    const { workspace, mcp } = await newBridge()
    const alias = `${workspace}-alias`
    symlinkSync(workspace, alias)
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace: alias,
        title: 'Alias workspace',
        goal: 'Create the mock output files.',
        acceptance: ['the mock files exist'],
        guiPolicy: 'create',
      })
      assert.equal(dispatched.isError, false, dispatched.text)
      const taskId = dispatched.structured.taskId
      await mcp.call('dsh_wait', { workspace: alias, taskId, timeoutSec: 30 })
      const request = JSON.parse(readFileSync(attachRequestFile(alias, taskId), 'utf8'))
      assert.equal(request.workspace, alias)
      assert.equal(request.canonicalWorkspace, realpathSync(workspace))
    } finally {
      await mcp.close()
    }
  })

  it('records each dispatch thread id from its own _meta under concurrency', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const [a, b] = await Promise.allSettled([
        mcp.callWithMeta('dsh_dispatch', {
          workspace, title: 'Meta A', goal: 'Create the mock output files.', acceptance: ['the mock files exist'],
        }, { threadId: 'thread-A', sessionId: 'sess-A' }),
        mcp.callWithMeta('dsh_dispatch', {
          workspace, title: 'Meta B', goal: 'Create the mock output files.', acceptance: ['the mock files exist'],
        }, { threadId: 'thread-B', sessionId: 'sess-B' }),
      ])

      // Whichever acquired the single-writer lock won; both records must keep
      // their own thread id (no cross-wiring from shared call metadata).
      const tasks = await mcp.call('dsh_list', { workspace })
      const byTitle = Object.fromEntries(tasks.structured.tasks.map((task) => [task.title, task.taskId]))
      assert.ok(byTitle['Meta A'] && byTitle['Meta B'])
      assert.equal(taskJson(workspace, byTitle['Meta A']).codexThreadId, 'thread-A')
      assert.equal(taskJson(workspace, byTitle['Meta B']).codexThreadId, 'thread-B')

      // At least one dispatch succeeded and holds its own thread id.
      const succeeded = [a, b].filter((entry) => entry.status === 'fulfilled' && !entry.value.isError)
      assert.ok(succeeded.length >= 1, 'one dispatch should win the lock')
    } finally {
      await mcp.close()
    }
  })

  it('re-enqueues via dsh_gui_retry and bumps the generation', async () => {
    const { workspace, mcp } = await newBridge()
    try {
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Retry target',
        goal: 'Create the mock output files.',
        acceptance: ['the mock files exist'],
      })
      const taskId = dispatched.structured.taskId
      await mcp.call('dsh_wait', { workspace, taskId, timeoutSec: 30 })
      const before = JSON.parse(readFileSync(attachRequestFile(workspace, taskId), 'utf8'))
      assert.equal(before.identity.generation, 0)

      const retried = await mcp.call('dsh_gui_retry', { workspace, taskId })
      assert.equal(retried.isError, false, retried.text)
      assert.equal(retried.structured.enqueued, true)

      const after = JSON.parse(readFileSync(attachRequestFile(workspace, taskId), 'utf8'))
      assert.equal(after.identity.generation, 1)
    } finally {
      await mcp.close()
    }
  })
})

after(() => {
  // Each test closes its own server; nothing global to clean up.
})
