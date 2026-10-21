/** Bridge configuration resolved from the environment Codex launches us with. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Locate the dsh launcher without assuming a specific install layout. */
function findDshBinary(env) {
  if (env.ASTRA_DSH_DSH_BIN) return env.ASTRA_DSH_DSH_BIN
  const candidates = [
    join(homedir(), '.local', 'bin', 'dsh'),
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return 'dsh'
}

/** All deployment knobs in one place; every value has a safe default. */
export function loadConfig(env = process.env) {
  return {
    bridgeHome: env.ASTRA_DSH_HOME || join(homedir(), 'astra-dsh-bridge'),
    dshBin: findDshBinary(env),
    dshHome: env.ASTRA_DSH_DSH_HOME || null,
    credentialsSource: env.ASTRA_DSH_CREDENTIALS || join(homedir(), '.dsh', '.credentials.yaml'),
    model: env.ASTRA_DSH_MODEL || 'deepseek-v4-pro',
    modelProvider: env.ASTRA_DSH_MODEL_PROVIDER || 'deepseek-official',
    effort: env.ASTRA_DSH_EFFORT || 'high',
    permissionMode: env.ASTRA_DSH_PERMISSION_MODE || 'workspace-write',
    // DSH's own sandbox still applies. This only answers ACP escalation prompts:
    // "allow" keeps an unattended DSH turn moving; "reject" fails closed.
    permissionPolicy: env.ASTRA_DSH_PERMISSION_POLICY === 'reject' ? 'reject' : 'allow',
    maxParallelTurns: 1,
    lockTtlMs: Number(env.ASTRA_DSH_LOCK_TTL_MS || 2 * 60 * 60 * 1000),
    waitMaxSec: Number(env.ASTRA_DSH_WAIT_MAX_SEC || 300),
    verifyTimeoutMs: Number(env.ASTRA_DSH_VERIFY_TIMEOUT_MS || 120_000),
  }
}
