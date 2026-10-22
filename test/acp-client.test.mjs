import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AcpClient } from '../src/acp-client.mjs'
import { isPidAlive } from '../src/util.mjs'
import { MOCK_ACP, MOCK_ACP_FAULTS, makeWorkspace, waitFor } from './helpers.mjs'

function faultClient(workspace, mode, extraEnv = {}) {
  return new AcpClient({
    command: process.execPath,
    args: [MOCK_ACP_FAULTS],
    cwd: workspace,
    env: { ...process.env, MOCK_FAULT: mode, ...extraEnv },
    logPath: join(workspace, 'acp.log'),
  })
}

async function readyClient(workspace, mode, extraEnv = {}) {
  const client = faultClient(workspace, mode, extraEnv)
  await client.initialize()
  const session = await client.newSession({ cwd: workspace })
  return { client, sessionId: session.sessionId }
}

describe('ACP transport fault handling', () => {
  it('rejects a pending prompt when stdout closes without killing the still-running process', async () => {
    const workspace = await makeWorkspace('astra-acp-stdout-')
    const signalFile = join(workspace, 'signals.txt')
    const { client, sessionId } = await readyClient(workspace, 'close-stdout', { MOCK_SIGNAL_FILE: signalFile })
    try {
      await assert.rejects(
        client.prompt({ sessionId, text: 'Task: `stdout-close`' }),
        (error) => error.code === 'ACP_STREAM_CLOSED' && /stdout closed/.test(error.message),
      )
      assert.equal(client.alive, false)
      assert.equal(client.termination.code, 'ACP_STREAM_CLOSED')
      const pid = client.child?.pid
      assert.ok(isPidAlive(pid), 'transport detection must not auto-kill a possibly executing ACP')
      await waitFor(() => true, { timeoutMs: 1 }).catch(() => {})
      assert.equal(existsSync(signalFile), false, 'detection path must not send SIGTERM')
      const started = Date.now()
      await client.dispose()
      assert.ok(Date.now() - started < 3000, 'explicit dispose should finish promptly')
      await waitFor(() => !isPidAlive(pid), { timeoutMs: 3000, label: 'explicit dispose cleanup' })
    } finally {
      await client.dispose()
    }
  })

  it('turns a broken stdin (EPIPE) into a terminal ACP_STDIN_ERROR', async () => {
    const workspace = await makeWorkspace('astra-acp-epipe-')
    const { client, sessionId } = await readyClient(workspace, 'epipe')
    try {
      await assert.rejects(
        client.prompt({ sessionId, text: 'Task: `epipe`' }),
        (error) => ['ACP_STDIN_ERROR', 'ACP_STREAM_CLOSED'].includes(error.code),
      )
      assert.equal(client.alive, false)
      await client.dispose()
      assert.equal(client.disposed, true)
    } finally {
      await client.dispose()
    }
  })

  it('rejects a prompt when the process exits mid-turn and preserves exit facts', async () => {
    const workspace = await makeWorkspace('astra-acp-exit-')
    const { client, sessionId } = await readyClient(workspace, 'exit-during-prompt')
    const chunks = []
    try {
      await assert.rejects(
        client.prompt({
          sessionId,
          text: 'Task: `exit-mid-prompt`',
          onUpdate: (update) => {
            if (update?.content?.type === 'text') chunks.push(update.content.text)
          },
        }),
        (error) => error.code === 'ACP_EXITED' && error.details?.exitCode === 7,
      )
      assert.match(chunks.join(''), /PARTIAL_OUTPUT/)
      assert.equal(client.termination.exitCode, 7)
      assert.match(client.termination.stderrSummary, /fault-exit/)
      assert.ok(!client.termination.stderrSummary.includes('sk-abcdefghijklmnop'), 'stderr tail must be redacted')
      const started = Date.now()
      await client.dispose()
      assert.ok(Date.now() - started < 500, 'disposing an exited child must be immediate')
    } finally {
      await client.dispose()
    }
  })

  it('does not treat a slow tool as a protocol failure', async () => {
    const workspace = await makeWorkspace('astra-acp-slow-')
    const { client, sessionId } = await readyClient(workspace, 'slow-tool')
    const chunks = []
    try {
      const result = await client.prompt({
        sessionId,
        text: 'Task: `slow-tool`',
        onUpdate: (update) => {
          if (update?.content?.type === 'text') chunks.push(update.content.text)
        },
      })
      assert.equal(result.stopReason, 'end_turn')
      assert.match(chunks.join(''), /MOCK_DONE/)
      assert.equal(client.alive, true)
      assert.equal(client.termination, null)
    } finally {
      await client.dispose()
    }
  })

  it('fails initialize cleanly when the ACP child exits at startup', async () => {
    const workspace = await makeWorkspace('astra-acp-startup-')
    const client = new AcpClient({
      command: process.execPath,
      args: [MOCK_ACP.replace('mock-acp-agent.mjs', 'mock-acp-exit.mjs')],
      cwd: workspace,
      env: process.env,
      logPath: join(workspace, 'acp.log'),
    })
    await assert.rejects(client.initialize(), (error) => ['ACP_EXITED', 'ACP_SPAWN_FAILED'].includes(error.code))
    assert.equal(client.alive, false)
    const started = Date.now()
    await client.dispose()
    assert.ok(Date.now() - started < 2000)
  })
})
