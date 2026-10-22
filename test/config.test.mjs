import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { loadConfig } from '../src/config.mjs'

describe('bridge config', () => {
  it('defaults the execution model to deepseek-flash', () => {
    assert.equal(loadConfig({}).model, 'deepseek-flash')
  })

  it('honours an explicit ASTRA_DSH_MODEL override', () => {
    assert.equal(loadConfig({ ASTRA_DSH_MODEL: 'deepseek-v4-pro' }).model, 'deepseek-v4-pro')
  })

  it('rejects malformed numeric health/retry knobs instead of silently disabling them', () => {
    assert.throws(() => loadConfig({ ASTRA_DSH_STALL_WARN_MS: 'not-a-number' }), /must be an integer/)
    assert.throws(() => loadConfig({ ASTRA_DSH_STALL_WARN_MS: '-1' }), /must be an integer/)
    assert.throws(() => loadConfig({ ASTRA_DSH_PROGRESS_HEARTBEAT_MS: '1.5' }), /must be an integer/)
    assert.throws(() => loadConfig({
      ASTRA_DSH_NOTIFY_RETRY_BASE_MS: '5000',
      ASTRA_DSH_NOTIFY_RETRY_MAX_MS: '1000',
    }), /must be an integer/)
    assert.throws(() => loadConfig({ ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS: '0' }), /must be an integer/)
    assert.throws(() => loadConfig({ ASTRA_DSH_CANCEL_GRACE_MS: 'soon' }), /must be an integer/)
    assert.throws(() => loadConfig({ ASTRA_DSH_NOTIFY_CLI_TIMEOUT_MS: '50' }), /must be an integer/)
    assert.throws(() => loadConfig({ ASTRA_DSH_WATCHDOG_NOTIFY_MAX_ATTEMPTS: '0' }), /must be an integer/)
  })

  it('keeps the installer default in sync with the runtime default', () => {
    const installer = readFileSync(new URL('../install.mjs', import.meta.url), 'utf8')
    const match = installer.match(/process\.env\.ASTRA_DSH_MODEL \|\| '([^']+)'/)
    assert.equal(match?.[1], loadConfig({}).model)
  })
})
