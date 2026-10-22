/** Small dependency-free helpers shared by the bridge, CLI, and tests. */

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { spawn } from 'node:child_process'

/** Error carrying a stable machine-readable code and optional details. */
export class BridgeError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, details?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = options.code ?? 'BRIDGE_ERROR'
    this.details = options.details
  }
}

/** Current time as an ISO-8601 string. */
export function nowIso() {
  return new Date().toISOString()
}

/** Short random suffix for ids. */
export function shortId(bytes = 4) {
  return randomBytes(bytes).toString('hex')
}

/** Filesystem-safe slug from arbitrary text. */
export function slugify(text, max = 48) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return slug || 'item'
}

/** Ensure a directory exists and return it. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Read JSON, returning a fallback when the file is absent or unreadable. */
export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) {
      throw new BridgeError(`Corrupt JSON at ${file}: ${error.message}`, { code: 'CORRUPT_STATE' })
    }
    throw error
  }
}

/** Atomically replace a JSON file (write-temp + rename). */
export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${shortId(2)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** Write a UTF-8 text file atomically. */
export function writeText(file, text) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${shortId(2)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** Read a text file, returning a fallback when absent. */
export function readText(file, fallback = '') {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
}

/** Append one JSON line. */
export function appendJsonLine(file, value) {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
}

/** Read a JSON-lines file, skipping malformed tails rather than failing a status call. */
export function readJsonLines(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // A process killed mid-write can leave a partial final line.
    }
  }
  return out
}

/** Remove a file or directory if present. */
export function removePath(target) {
  rmSync(target, { recursive: true, force: true })
}

/** Whether a path exists. */
export function pathExists(target) {
  return existsSync(target)
}

/** Stat a path, or undefined when absent. */
export function statOrUndefined(target) {
  try {
    return statSync(target)
  } catch {
    return undefined
  }
}

/** Truncate a string to a byte-ish character budget with a visible marker. */
export function truncate(text, max = 8000, marker = '\n… [truncated]') {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return value.slice(0, Math.max(0, max - marker.length)) + marker
}

/** Collapse whitespace to one line. */
export function oneLine(text, max = 240) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max, '…')
}

/**
 * Classify a PID. `EPERM` means the process exists but we may not signal it, so
 * it must never be reported as dead. Genuinely unclassifiable errors are
 * `unknown` for the same reason.
 * @param {number} pid
 * @param {(pid:number, signal:number)=>void} [kill]
 * @returns {'alive'|'dead'|'unknown'}
 */
export function pidState(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead'
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    if (error && error.code === 'EPERM') return 'unknown'
    if (error && error.code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

/** Whether a PID is alive (EPERM/unknown counts as alive so we never assert death). */
export function isPidAlive(pid, kill = process.kill) {
  return pidState(pid, kill) !== 'dead'
}

/** Redact common secret shapes before a diagnostic snippet is persisted. */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/g, '$1 [redacted]')
}

/** Bounded, redacted stderr tail suitable for an incident record. */
export function summarizeStderr(text, max = 1200) {
  return truncate(redactSecrets(String(text ?? '').trim()), max)
}

/** Await a fixed number of milliseconds. */
export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Resolve a user-supplied workspace path and require an existing absolute directory. */
export function resolveWorkspace(input, fallback = process.cwd()) {
  const value = input === undefined || input === null || input === '' ? fallback : String(input)
  if (!isAbsolute(value)) {
    throw new BridgeError(`workspace must be an absolute path: ${value}`, { code: 'BAD_WORKSPACE' })
  }
  const resolved = resolve(value)
  const stat = statOrUndefined(resolved)
  if (!stat || !stat.isDirectory()) {
    throw new BridgeError(`workspace is not an existing directory: ${resolved}`, { code: 'BAD_WORKSPACE' })
  }
  return resolved
}

/** Validate an id that becomes a directory name. */
export function validateId(id, kind = 'id') {
  const value = String(id ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value)) {
    throw new BridgeError(`invalid ${kind}: ${value}`, { code: 'BAD_ID' })
  }
  return value
}

/**
 * Run a command and capture bounded stdout/stderr.
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string, stderr:string, timedOut:boolean}>}
 */
export function runCommand(command, args, options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 30_000,
    maxBytes = 1_000_000,
    input,
  } = options
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)
      : undefined
    const cap = (current, chunk) => (current.length >= maxBytes ? current : current + String(chunk).slice(0, maxBytes - current.length))
    child.stdout?.on('data', (chunk) => { stdout = cap(stdout, chunk) })
    child.stderr?.on('data', (chunk) => { stderr = cap(stderr, chunk) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      rejectPromise(new BridgeError(`failed to run ${command}: ${error.message}`, { code: 'SPAWN_FAILED' }))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, timedOut })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Format a compact relative time for humans. */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ''}`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`
}
