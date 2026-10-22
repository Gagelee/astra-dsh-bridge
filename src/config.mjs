/** Bridge configuration resolved from the environment Codex launches us with. */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BridgeError } from './util.mjs'

/**
 * Parse one numeric knob strictly: bad values fail loudly instead of silently
 * turning a watchdog off (or leaving it retrying forever).
 */
function numberEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true } = {}) {
  const raw = env[name]
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value)) || value < min || value > max) {
    throw new BridgeError(
      `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}, got ${JSON.stringify(raw)}`,
      { code: 'BAD_CONFIG' },
    )
  }
  return value
}

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
function findCodex(env) {
  if (env.ASTRA_DSH_CODEX_BIN) return env.ASTRA_DSH_CODEX_BIN
  const candidates = [
    join(homedir(), '.local', 'bin', 'codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function loadConfig(env = process.env) {
  const notifyRetryBaseMs = numberEnv(env, 'ASTRA_DSH_NOTIFY_RETRY_BASE_MS', 2000, { min: 1, max: 60 * 60 * 1000 })
  const notifyRetryMaxMs = numberEnv(
    env,
    'ASTRA_DSH_NOTIFY_RETRY_MAX_MS',
    Math.max(5 * 60 * 1000, notifyRetryBaseMs),
    { min: notifyRetryBaseMs, max: 24 * 60 * 60 * 1000 },
  )
  return {
    bridgeHome: env.ASTRA_DSH_HOME || join(homedir(), 'astra-dsh-bridge'),
    dshBin: findDshBinary(env),
    codexBin: findCodex(env),
    notifyCodex: env.ASTRA_DSH_NOTIFY_CODEX !== '0',
    dshHome: env.ASTRA_DSH_DSH_HOME || null,
    credentialsSource: env.ASTRA_DSH_CREDENTIALS || join(homedir(), '.dsh', '.credentials.yaml'),
    model: env.ASTRA_DSH_MODEL || 'deepseek-flash',
    modelProvider: env.ASTRA_DSH_MODEL_PROVIDER || 'deepseek-official',
    effort: env.ASTRA_DSH_EFFORT || 'high',
    permissionMode: env.ASTRA_DSH_PERMISSION_MODE || 'workspace-write',
    // DSH's own sandbox still applies. This only answers ACP escalation prompts:
    // "allow" keeps an unattended DSH turn moving; "reject" fails closed.
    permissionPolicy: env.ASTRA_DSH_PERMISSION_POLICY === 'reject' ? 'reject' : 'allow',
    maxParallelTurns: 1,
    lockTtlMs: numberEnv(env, 'ASTRA_DSH_LOCK_TTL_MS', 2 * 60 * 60 * 1000, { min: 1000, max: 7 * 24 * 60 * 60 * 1000 }),
    waitMaxSec: numberEnv(env, 'ASTRA_DSH_WAIT_MAX_SEC', 300, { min: 1, max: 3600 }),
    verifyTimeoutMs: numberEnv(env, 'ASTRA_DSH_VERIFY_TIMEOUT_MS', 120_000, { min: 1000, max: 60 * 60 * 1000 }),

    // Progress health. 0 disables the "quiet turn" warning; it never cancels a
    // turn and is deliberately much longer than any normal tool call.
    stallWarningMs: numberEnv(env, 'ASTRA_DSH_STALL_WARN_MS', 15 * 60 * 1000, { min: 0, max: 24 * 60 * 60 * 1000 }),
    progressHeartbeatMs: numberEnv(env, 'ASTRA_DSH_PROGRESS_HEARTBEAT_MS', 5000, { min: 1, max: 10 * 60 * 1000 }),
    pidHeartbeatStaleMs: numberEnv(env, 'ASTRA_DSH_PID_STALE_MS', 2 * 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),

    // Durable notification outbox retry/lease policy.
    notifyRetryBaseMs,
    notifyRetryMaxMs,
    notifyLeaseMs: numberEnv(env, 'ASTRA_DSH_NOTIFY_LEASE_MS', 60_000, { min: 1000, max: 60 * 60 * 1000 }),
    notifyCliTimeoutMs: numberEnv(env, 'ASTRA_DSH_NOTIFY_CLI_TIMEOUT_MS', 30_000, { min: 100, max: 10 * 60 * 1000 }),

    // One small per-turn supervisor process. It is not a daemon, cron, or
    // launchd job; it exits with the turn (or shortly after a bridge crash).
    watchdog: env.ASTRA_DSH_WATCHDOG !== '0',
    watchdogReadyTimeoutMs: numberEnv(env, 'ASTRA_DSH_WATCHDOG_READY_TIMEOUT_MS', 3000, { min: 100, max: 60_000 }),
    // If the bridge died and its sidecar still owns the control-loss event, it
    // retries within this bounded budget instead of exiting after one attempt.
    watchdogNotifyBudgetMs: numberEnv(env, 'ASTRA_DSH_WATCHDOG_NOTIFY_BUDGET_MS', 5 * 60 * 1000, { min: 1000, max: 24 * 60 * 60 * 1000 }),
    watchdogNotifyMaxAttempts: numberEnv(env, 'ASTRA_DSH_WATCHDOG_NOTIFY_MAX_ATTEMPTS', 20, { min: 1, max: 1000 }),
    cancelGraceMs: numberEnv(env, 'ASTRA_DSH_CANCEL_GRACE_MS', 20_000, { min: 100, max: 10 * 60 * 1000 }),
    reconcileOnStart: env.ASTRA_DSH_RECONCILE !== '0',
  }
}
