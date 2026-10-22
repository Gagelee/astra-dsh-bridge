#!/usr/bin/env node
/**
 * Mock `codex queue` used by notification tests. By default every call
 * succeeds. MOCK_CODEX_FAIL_TIMES makes the first N calls exit non-zero so the
 * outbox backoff/retry path can be exercised without a real model.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const out = process.env.MOCK_CODEX_OUT
if (!out) process.exit(2)
const stateFile = process.env.MOCK_CODEX_STATE || `${out}.count`
let count = 0
try {
  if (existsSync(stateFile)) count = Number(readFileSync(stateFile, 'utf8')) || 0
} catch {
  count = 0
}
const failTimes = Number(process.env.MOCK_CODEX_FAIL_TIMES ?? 0)
const sleepMs = Number(process.env.MOCK_CODEX_SLEEP_MS ?? 0)
if (sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs))
}
const fail = count < failTimes
appendFileSync(out, `${JSON.stringify({ args: process.argv.slice(2), at: Date.now(), fail })}\n`)
try {
  writeFileSync(stateFile, `${count + 1}\n`)
} catch {
  // A test that only checks success does not need the counter.
}
if (fail) {
  process.stderr.write(`mock codex transient failure ${count + 1}/${failTimes}\n`)
  process.exit(7)
}
