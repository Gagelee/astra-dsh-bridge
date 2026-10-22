#!/usr/bin/env node
/**
 * DSH-side command line for the shared board.
 *
 * The common flow when a requirement starts in DSH: `astra-dsh request` drops a
 * requirement into the shared workspace; Codex/Astra picks it up with
 * astra_inbox and plans it. `tasks`, `show`, `status`, and `diff` let DSH (or a
 * person) inspect the same board without going through Codex.
 */

import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { loadConfig } from './config.mjs'
import { WorkspaceStore } from './store.mjs'
import { BridgeError, readText, runCommand } from './util.mjs'

const config = loadConfig()

function usage() {
  process.stdout.write(`astra-dsh — shared board between Codex/Astra and DSH

Usage:
  astra-dsh request --workspace DIR --title TITLE [--body TEXT | --body-file PATH|-]
                    [--priority low|normal|high|urgent] [--origin dsh|codex|user]
  astra-dsh inbox   --workspace DIR [--all]
  astra-dsh tasks   --workspace DIR [--state STATE]
  astra-dsh show    --workspace DIR <ID>
  astra-dsh status  --workspace DIR
  astra-dsh diff    --workspace DIR [--since TASK_ID] [--max-bytes N]
  astra-dsh doctor  [--workspace DIR]

The board is <workspace>/.astra-dsh and is readable by Codex/Astra through the
astra_* MCP tools.
`)
}

function parse(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i += 1
      }
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function workspaceOf(flags) {
  return resolve(flags.workspace ? String(flags.workspace) : process.cwd())
}

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { flags, positional } = parse(rest)
  if (!command || command === 'help' || flags.help) {
    usage()
    return 0
  }

  if (command === 'doctor') {
    return doctor(flags)
  }

  const workspace = workspaceOf(flags)
  if (!isAbsolute(workspace) || !existsSync(workspace)) {
    throw new BridgeError(`workspace does not exist: ${workspace}`, { code: 'BAD_WORKSPACE' })
  }
  const store = new WorkspaceStore(workspace)

  switch (command) {
    case 'request': {
      const title = flags.title
      if (!title) throw new BridgeError('--title is required', { code: 'BAD_ARGUMENT' })
      let body = flags.body ? String(flags.body) : ''
      if (flags['body-file']) {
        const file = String(flags['body-file'])
        body = file === '-' ? await readStdin() : readText(file, '')
      }
      if (!body) body = await readStdin()
      if (!body.trim()) throw new BridgeError('request body is empty (use --body, --body-file, or stdin)', { code: 'BAD_ARGUMENT' })
      const request = store.createRequest({
        title: String(title),
        body,
        origin: String(flags.origin ?? 'dsh'),
        priority: String(flags.priority ?? 'normal'),
      })
      process.stdout.write(`Created ${request.id} in ${store.root}/requests/${request.id}\n`)
      process.stdout.write(`Astra can pick it up with astra_inbox for ${workspace}.\n`)
      return 0
    }
    case 'inbox': {
      const requests = store.listRequests().filter((request) => flags.all || !['done', 'rejected'].includes(request.state))
      if (requests.length === 0) {
        process.stdout.write(`No open requirements in ${workspace}.\n`)
        return 0
      }
      process.stdout.write(`# Requirements — ${workspace}\n\n`)
      for (const request of requests) {
        process.stdout.write(`- ${request.id} [${request.state}/${request.priority}] ${request.title} (origin ${request.origin})\n`)
      }
      return 0
    }
    case 'tasks': {
      const tasks = store.listTasks({ state: flags.state ? String(flags.state) : undefined })
      if (tasks.length === 0) {
        process.stdout.write(`No DSH tasks in ${workspace}.\n`)
        return 0
      }
      for (const task of tasks) {
        process.stdout.write(`- ${task.id} [${task.state}] ${task.title} · turn ${task.turnIndex} · ${task.changedFiles?.length ?? 0} file(s)\n`)
      }
      return 0
    }
    case 'show': {
      const id = positional[0]
      if (!id) throw new BridgeError('request or task id is required', { code: 'BAD_ARGUMENT' })
      if (id.startsWith('REQ-')) {
        const request = store.loadRequest(id)
        process.stdout.write(`# ${request.title}\n\n- id: ${request.id}\n- state: ${request.state}\n- origin: ${request.origin}\n- createdAt: ${request.createdAt}\n\n## Requirement\n\n${request.body}\n\n## Plan\n\n${request.plan || '_none_'}\n`)
      } else {
        const task = store.loadTask(id)
        process.stdout.write(`# ${task.title}\n\n- id: ${task.id}\n- state: ${task.state}\n- session: ${task.sessionId ?? '—'}\n- turn: ${task.turnIndex}\n- updatedAt: ${task.updatedAt}\n- error: ${task.error ?? '—'}\n\n## Final text\n\n${task.finalText || '_none_'}\n\n## Files\n\n${(task.changedFiles ?? []).map((entry) => `- ${entry.path} (${entry.code})`).join('\n') || '_none_'}\n\nArtifacts: ${store.taskDir(task.id)}\n`)
      }
      return 0
    }
    case 'status': {
      const tasks = store.listTasks()
      const requests = store.listRequests()
      process.stdout.write(`# ${workspace}\n\n`)
      process.stdout.write(`- Board: ${store.root}\n`)
      process.stdout.write(`- Requests: ${requests.length} (${requests.filter((request) => request.state === 'open').length} open)\n`)
      process.stdout.write(`- Tasks: ${tasks.length} (${tasks.filter((task) => task.state === 'running').length} running, ${tasks.filter((task) => task.state === 'idle').length} idle)\n`)
      const lock = store.inspectLock()
      const risk = store.executionRiskSummary()
      process.stdout.write(`- Lock: ${lock ? `${lock.owner}${lock.taskId ? ` (${lock.taskId})` : ''}` : 'free'}${lock?.blockedByExecutionRisk ? ` · BLOCKED by execution risk ${lock.blockedByExecutionRisk.taskId ?? 'unknown'}` : ''}\n`)
      if (risk) {
        process.stdout.write(`- Execution risk: ${risk.taskId ?? 'unknown'} ${risk.state ?? ''} turn ${risk.turn ?? '?'} · new writers are refused until verified resolution\n`)
      }
      return 0
    }
    case 'diff': {
      const since = flags.since ? store.loadTask(String(flags.since)) : undefined
      const changes = await store.collectChanges(
        since?.baseline ?? (store.isGit() ? { vcs: 'git', head: null, dirty: [] } : { vcs: 'files', files: {} }),
        Number(flags['max-bytes'] ?? 120_000),
      )
      process.stdout.write(`${changes.diffStat || '(no diff stat)'}\n\n`)
      process.stdout.write(`${changes.diff || '(no diff)'}\n`)
      return 0
    }
    default:
      usage()
      return 1
  }
}

async function doctor(flags) {
  const workspace = flags.workspace ? resolve(String(flags.workspace)) : process.cwd()
  const dsh = await runCommand(config.dshBin, ['--version'], { timeoutMs: 20_000 }).catch((error) => ({ code: -1, stdout: '', stderr: error.message }))
  const effectiveHome = config.dshHome || resolve(workspace, '.astra-dsh', 'dsh-home')
  const board = resolve(workspace, '.astra-dsh')
  const checks = [
    ['node', process.version, true],
    ['dsh binary', config.dshBin, existsSync(config.dshBin) || dsh.code === 0],
    ['dsh version', (dsh.stdout || dsh.stderr || '').trim().split('\n')[0] || 'unavailable', dsh.code === 0],
    ['DSH_HOME', effectiveHome, config.dshHome ? existsSync(effectiveHome) : true],
    ['credentials', config.credentialsSource, existsSync(config.credentialsSource)],
    ['workspace', workspace, existsSync(workspace)],
    ['workspace .git', existsSync(resolve(workspace, '.git')) ? 'yes' : 'no (file snapshot mode)', true],
    ['board', board, true],
  ]
  let failures = 0
  for (const [name, value, ok] of checks) {
    if (!ok) failures += 1
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${value}\n`)
  }
  process.stdout.write(`\nmodel=${config.model} effort=${config.effort} sandbox=${config.permissionMode} acp-permission=${config.permissionPolicy}\n`)
  process.stdout.write(`waits up to ${config.waitMaxSec}s; lock ttl ${config.lockTtlMs}ms\n`)
  process.stdout.write('board is created lazily on first dispatch or request\n')
  return failures === 0 ? 0 : 1
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    if (error instanceof BridgeError) {
      process.stderr.write(`astra-dsh: ${error.code}: ${error.message}\n`)
    } else {
      process.stderr.write(`astra-dsh: ${error?.stack ?? error}\n`)
    }
    process.exit(1)
  })
