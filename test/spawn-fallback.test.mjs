import assert from 'node:assert/strict'
import { chmodSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { makeWorkspace, startMcp } from './helpers.mjs'

const MOCK_ACP_EXIT = fileURLToPath(new URL('./fixtures/mock-acp-exit.mjs', import.meta.url))
chmodSync(MOCK_ACP_EXIT, 0o755)

describe('shared-home fallback safety', () => {
  it('does not switch home when the ACP process merely exits at startup', async () => {
    const workspace = await makeWorkspace()
    writeFileSync(join(workspace, 'seed.txt'), 'seed\n')
    const sharedHome = join(workspace, '.astra-dsh', 'shared-home')
    const mcp = startMcp({
      cwd: workspace,
      env: {
        ASTRA_DSH_DSH_BIN: MOCK_ACP_EXIT,
        ASTRA_DSH_DSH_HOME: sharedHome,
        ASTRA_DSH_HOME: join(workspace, '.mock-bridge-home'),
        ASTRA_DSH_MODEL: 'mock-model',
        ASTRA_DSH_EFFORT: 'low',
        ASTRA_DSH_PERMISSION_POLICY: 'allow',
        ASTRA_DSH_NOTIFY_CODEX: '0',
      },
    })
    try {
      await mcp.request('initialize', {
        protocolVersion: '2025-06-18',
        clientCapabilities: {},
        clientInfo: { name: 'test', version: '0' },
      })
      const dispatched = await mcp.call('dsh_dispatch', {
        workspace,
        title: 'Exit at startup',
        goal: 'Should fail to open a session.',
        acceptance: ['failure is recorded'],
      })
      assert.equal(dispatched.isError, true, dispatched.text)

      const status = await mcp.call('astra_status', { workspace })
      // The shared home must stay in use; an ACP exit is not a write failure.
      assert.equal(status.structured.bridge.dshHome, sharedHome)
      assert.equal(status.structured.bridge.dshHomeFallbackReason, null)
      assert.ok(status.structured.bridge.attachQueueDir.endsWith(join('shared-home', 'astra-dsh', 'attach')))
    } finally {
      await mcp.close()
    }
  })
})
