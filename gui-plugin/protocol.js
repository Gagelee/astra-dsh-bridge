/**
 * Canonical attach protocol shared by the bridge (src/) and the GUI
 * workspace-attach plugin (gui-plugin/index.js). Lives inside the plugin
 * package so the GUI bundle is fully self-contained (it may be packed/copied
 * away from the repo); the bridge imports this same file.
 *
 * This module depends only on node builtins, so neither side pulls in code
 * outside its own tree.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** GUI grouping strategies the planner can request on dsh_dispatch. */
export const GUI_POLICIES = ['existing', 'create', 'off']
export const DEFAULT_GUI_POLICY = 'existing'

/** Wire schema version so an old plugin/bridge pair can refuse unknown shapes. */
export const ATTACH_SCHEMA = 1

/**
 * Attach delivery status. `queued` and `waiting-session` are non-terminal;
 * the rest are terminal. The ACK only proves the host published the list
 * update and (for `attached`) grouped the session; it never claims the client
 * rendered it. `off` means GUI delivery was disabled by policy (no publish, no
 * grouping). `private-home` is bridge-side only (fallback home, never queued).
 */
export const ATTACH_STATUS = {
  QUEUED: 'queued',
  WAITING_SESSION: 'waiting-session',
  UNREGISTERED: 'unregistered',
  ATTACHED: 'attached',
  FAILED: 'failed',
  PRIVATE_HOME: 'private-home',
  OFF: 'off',
}

/** Statuses that end processing of one request file (plugin deletes it). */
export const TERMINAL_STATUSES = new Set([
  ATTACH_STATUS.UNREGISTERED,
  ATTACH_STATUS.ATTACHED,
  ATTACH_STATUS.FAILED,
  ATTACH_STATUS.OFF,
])

/** A filename-safe id: letters/digits plus a small safe punctuation set. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/

/** Separator used in per-identity filenames; never part of a valid id. */
const ID_SEP = '~'

/** Follow-up window after a terminal publish, within which the plugin re-queries title/blank. */
export const FOLLOWUP_WINDOW_MS = 60_000

/** Throw an error carrying a stable machine-readable code. */
function protocolError(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Normalize a guiPolicy value, defaulting to `existing` and rejecting junk. */
export function normalizeGuiPolicy(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_GUI_POLICY
  if (!GUI_POLICIES.includes(value)) {
    throw protocolError(`guiPolicy must be one of ${GUI_POLICIES.join('|')}`, 'BAD_TASK')
  }
  return value
}

/** Canonicalize a workspace path through realpath so aliases dedupe. */
export function canonicalWorkspacePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw protocolError('workspace path must be a non-empty string', 'BAD_WORKSPACE')
  }
  let real
  try {
    real = realpathSync(path)
  } catch (error) {
    throw protocolError(`workspace path does not resolve: ${path} (${error.message})`, 'BAD_WORKSPACE')
  }
  try {
    if (!statSync(real).isDirectory()) {
      throw protocolError(`workspace path is not a directory: ${real}`, 'BAD_WORKSPACE')
    }
  } catch (error) {
    if (error?.code === 'BAD_WORKSPACE') throw error
    throw protocolError(`workspace path is not a directory: ${real}`, 'BAD_WORKSPACE')
  }
  return real
}

/** Identity that makes a request idempotent and stale ACKs inert. */
export function attachIdentity({ taskId, sessionId, generation }) {
  assertSafeId(taskId, 'taskId')
  assertSafeId(sessionId, 'sessionId')
  const gen = assertGeneration(generation)
  return { taskId, sessionId, generation: gen }
}

/** Compact identity key for logging and comparisons. */
export function identityKey(identity) {
  return `${identity?.taskId ?? ''}@${identity?.sessionId ?? ''}#${identity?.generation ?? 0}`
}

/** Stable filename base for a given identity + canonical workspace. */
export function identityFileBase(identity, canonicalWorkspace) {
  assertSafeId(identity?.taskId, 'taskId')
  assertSafeId(identity?.sessionId, 'sessionId')
  const generation = assertGeneration(identity?.generation)
  return `${identity.taskId}${ID_SEP}${identity.sessionId}${ID_SEP}${generation}${ID_SEP}${workspaceHash(canonicalWorkspace)}`
}

/** Per-identity request path (immutable; the bridge writes each identity once). */
export function requestPath(queueDir, identity, canonicalWorkspace) {
  assertQueueDir(queueDir)
  return join(queueDir, `${identityFileBase(identity, canonicalWorkspace)}.json`)
}

/** Per-identity ACK path. */
export function ackPath(queueDir, identity, canonicalWorkspace) {
  assertQueueDir(queueDir)
  return join(queueDir, `${identityFileBase(identity, canonicalWorkspace)}.ack.json`)
}

/** Legacy request path (`<taskId>.json`), written by pre-per-identity bridges. */
export function legacyRequestPath(queueDir, taskId) {
  assertSafeId(taskId, 'taskId')
  return join(queueDir, `${taskId}.json`)
}

/** Build the durable request object the bridge writes. */
export function renderAttachRequest({ taskId, sessionId, generation = 0, workspace, title = null, policy = DEFAULT_GUI_POLICY }) {
  const identity = attachIdentity({ taskId, sessionId, generation })
  const canonical = canonicalWorkspacePath(workspace)
  if (title !== null && typeof title !== 'string') {
    throw protocolError('title must be a string or null', 'BAD_REQUEST')
  }
  const normalizedPolicy = normalizeGuiPolicy(policy)
  return {
    schema: ATTACH_SCHEMA,
    identity,
    workspace,
    canonicalWorkspace: canonical,
    sessionId,
    taskId,
    title: title ?? null,
    policy: normalizedPolicy,
    createdAt: nowIso(),
  }
}

/** Build the durable ACK object the plugin writes before deleting the request. */
export function renderAttachAck({
  identity,
  workspace = null,
  canonicalWorkspace = null,
  sessionId,
  workspaceId = null,
  workspaceTitle = null,
  status,
  phase = null,
  at = nowIso(),
  attempts = 0,
  lastError = null,
  publishedAt = null,
  followupUntil = null,
  followupFingerprint = null,
}) {
  if (!Object.values(ATTACH_STATUS).includes(status)) {
    throw protocolError(`unsupported ack status ${status}`, 'BAD_ACK')
  }
  const id = attachIdentity(identity)
  if (canonicalWorkspace === null || typeof canonicalWorkspace !== 'string' || canonicalWorkspace.length === 0) {
    throw protocolError('ack.canonicalWorkspace is required', 'BAD_ACK')
  }
  if (sessionId === undefined || sessionId === null || !isSafeId(sessionId)) {
    throw protocolError('ack.sessionId is invalid', 'BAD_ACK')
  }
  return {
    schema: ATTACH_SCHEMA,
    identity: id,
    workspace,
    canonicalWorkspace,
    sessionId,
    workspaceId,
    workspaceTitle,
    status,
    phase,
    at,
    attempts,
    lastError,
    publishedAt,
    followupUntil,
    followupFingerprint,
  }
}

/** Validate a request body read from disk. Returns `{ ok, error }`. */
export function validateAttachRequest(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'request is not an object' }
  if (entry.schema !== ATTACH_SCHEMA) return { ok: false, error: `unsupported request schema ${entry.schema}` }
  const identity = entry.identity
  if (!identity || typeof identity !== 'object') return { ok: false, error: 'request.identity is missing' }
  if (!isSafeId(identity.taskId)) return { ok: false, error: `invalid taskId ${identity.taskId}` }
  if (!isSafeId(identity.sessionId)) return { ok: false, error: `invalid sessionId ${identity.sessionId}` }
  if (!isSafeGeneration(identity.generation)) return { ok: false, error: `invalid generation ${identity.generation}` }
  if (typeof entry.workspace !== 'string' || entry.workspace.length === 0) return { ok: false, error: 'request.workspace is missing' }
  if (typeof entry.canonicalWorkspace !== 'string' || entry.canonicalWorkspace.length === 0) return { ok: false, error: 'request.canonicalWorkspace is missing' }
  if (!GUI_POLICIES.includes(entry.policy)) return { ok: false, error: `unsupported policy ${entry.policy}` }
  if (entry.title !== null && typeof entry.title !== 'string') return { ok: false, error: 'request.title must be a string or null' }
  return { ok: true }
}

/**
 * Migrate a legacy (pre-schema) request to the current protocol with
 * guiPolicy=existing. Never creates a workspace. Returns `{ ok, request?, error? }`.
 */
export function migrateLegacyRequest(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'legacy request is not an object' }
  const taskId = entry.taskId
  const sessionId = entry.sessionId
  if (!isSafeId(taskId)) return { ok: false, error: `invalid legacy taskId ${taskId}` }
  if (!isSafeId(sessionId)) return { ok: false, error: `invalid legacy sessionId ${sessionId}` }
  if (typeof entry.workspace !== 'string' || entry.workspace.length === 0) {
    return { ok: false, error: 'legacy request.workspace is missing' }
  }
  if (!isAbsolute(entry.workspace)) return { ok: false, error: `legacy request.workspace is not absolute: ${entry.workspace}` }
  try {
    return {
      ok: true,
      request: renderAttachRequest({
        taskId,
        sessionId,
        generation: 0,
        workspace: entry.workspace,
        title: typeof entry.title === 'string' ? entry.title : null,
        policy: 'existing',
      }),
    }
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) }
  }
}

/** Validate an ACK body read from disk. Returns `{ ok, error }`. */
export function validateAttachAck(entry) {
  if (!entry || typeof entry !== 'object') return { ok: false, error: 'ack is not an object' }
  if (entry.schema !== ATTACH_SCHEMA) return { ok: false, error: `unsupported ack schema ${entry.schema}` }
  const identity = entry.identity
  if (!identity || typeof identity !== 'object') return { ok: false, error: 'ack.identity is missing' }
  if (!isSafeId(identity.taskId)) return { ok: false, error: `invalid taskId ${identity.taskId}` }
  if (!isSafeId(identity.sessionId)) return { ok: false, error: `invalid sessionId ${identity.sessionId}` }
  if (!isSafeGeneration(identity.generation)) return { ok: false, error: `invalid generation ${identity.generation}` }
  if (!Object.values(ATTACH_STATUS).includes(entry.status)) return { ok: false, error: `unsupported status ${entry.status}` }
  if (typeof entry.canonicalWorkspace !== 'string' || entry.canonicalWorkspace.length === 0) {
    return { ok: false, error: 'ack.canonicalWorkspace is missing' }
  }
  return { ok: true }
}

/** Whether two ACK/request identities fully match (task/session/generation). */
export function identityMatches(a, b) {
  if (!a || !b) return false
  return a.taskId === b.taskId
    && a.sessionId === b.sessionId
    && Number(a.generation) === Number(b.generation)
}

/** Atomically write one request, creating the queue directory on demand. */
export function writeAttachRequest(queueDir, request) {
  assertQueueDir(queueDir)
  const identity = attachIdentity(request.identity)
  const path = requestPath(queueDir, identity, request.canonicalWorkspace)
  writeJsonAtomic(path, request)
  return path
}

/** Atomically write one ACK. */
export function writeAttachAck(queueDir, ack) {
  assertQueueDir(queueDir)
  const path = ackPath(queueDir, ack.identity, ack.canonicalWorkspace)
  writeJsonAtomic(path, ack)
  return path
}

/** Read an ACK for a given identity + canonical workspace, or null when absent. */
export function readAttachAck(queueDir, identity, canonicalWorkspace) {
  assertQueueDir(queueDir)
  const path = ackPath(queueDir, identity, canonicalWorkspace)
  return readJson(path, null)
}

/** Remove a request file (per-identity) if present. */
export function removeAttachRequest(queueDir, identity, canonicalWorkspace) {
  assertQueueDir(queueDir)
  removePath(requestPath(queueDir, identity, canonicalWorkspace))
}

/** Remove a legacy request file (`<taskId>.json`) if present. */
export function removeLegacyRequest(queueDir, taskId) {
  assertQueueDir(queueDir)
  removePath(legacyRequestPath(queueDir, taskId))
}

/** Atomically replace a JSON file (temp + rename). */
export function writeJsonAtomic(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

// ------------------------------------------------------------- internals

function workspaceHash(canonical) {
  return createHash('sha1').update(String(canonical)).digest('hex').slice(0, 12)
}

function isSafeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value)
}

function isSafeGeneration(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0
}

function assertGeneration(value) {
  const gen = Number(value)
  if (!Number.isSafeInteger(gen) || gen < 0) {
    throw protocolError(`generation must be a non-negative safe integer: ${value}`, 'BAD_IDENTITY')
  }
  return gen
}

function assertSafeId(value, field) {
  if (!isSafeId(value)) {
    throw protocolError(`invalid ${field}: ${value}`, 'BAD_IDENTITY')
  }
  return value
}

function assertQueueDir(queueDir) {
  if (typeof queueDir !== 'string' || queueDir.length === 0) {
    throw protocolError('queue directory is required', 'BAD_ARGUMENT')
  }
  return queueDir
}

function isAbsolute(value) {
  return typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
}

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) {
      throw protocolError(`corrupt JSON at ${file}: ${error.message}`, 'CORRUPT_STATE')
    }
    throw error
  }
}

function removePath(target) {
  rmSync(target, { recursive: true, force: true })
}
