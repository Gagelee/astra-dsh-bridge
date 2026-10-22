import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { makeWorkspace } from './helpers.mjs'

describe('gui-plugin package self-containment', () => {
  it('imports and applies from an isolated copy with no ../src dependency', async () => {
    const isolated = await makeWorkspace('astra-dsh-package-')
    cpSync(new URL('../gui-plugin/', import.meta.url), isolated, { recursive: true })

    const mod = await import(pathToFileURL(join(isolated, 'index.js')).href)
    assert.equal(mod.name, 'astra-dsh-workspace-attach')
    assert.equal(typeof mod.apply, 'function')

    const home = join(isolated, 'home')
    process.env.DSH_HOME = home
    try {
      const emitted = []
      const ctx = {
        workspaceRegistry: {
          resolveByPath: async () => undefined,
          create: async () => ({ attachSession: async () => {} }),
        },
        sessionController: { list: async () => ({ items: [] }) },
        emit: (event) => { emitted.push(event) },
        effect: () => {},
      }
      const controller = mod.apply(ctx, { autoStart: false, now: () => 0, backoff: () => 0 })
      await controller.pump()
      assert.ok(controller.queueDir.endsWith(join('home', 'astra-dsh', 'attach')), controller.queueDir)
      controller.stop()
    } finally {
      delete process.env.DSH_HOME
    }
  })

  it('keeps package.json version in sync with PLUGIN_VERSION', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../gui-plugin/package.json', import.meta.url), 'utf8'))
    const mod = await import(new URL('../gui-plugin/index.js', import.meta.url).href)
    assert.equal(pkg.version, mod.PLUGIN_VERSION)
    assert.equal(typeof mod.PLUGIN_VERSION, 'string')
  })
})
