#!/usr/bin/env node
/**
 * Install the Astra ↔ DSH bridge into Codex and DSH:
 *
 *   - ~/.codex/config.toml        MCP server `astra_dsh` (stdio)
 *   - ~/.codex/skills/astra-dsh   Astra planning/delegation skill
 *   - ~/.agents/skills/astra-dsh  DSH-side shared-board skill
 *   - ~/.codex/AGENTS.md          short global routing rule (managed block)
 *   - ~/.local/bin/astra-dsh      DSH-side CLI launcher (when the dir exists)
 *
 * Every edit is idempotent and marker-delimited. Use --dry-run to inspect,
 * --yes to apply.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const dryRun = has('--dry-run') || !has('--yes')
const force = has('--force')
const codexHome = resolve(valueOf('--codex-home', process.env.CODEX_HOME || join(homedir(), '.codex')))
const agentsHome = resolve(valueOf('--agents-home', join(homedir(), '.agents')))
const localBin = resolve(valueOf('--local-bin', join(homedir(), '.local', 'bin')))
const bridgeDir = here
const nodePath = process.execPath
const serverPath = join(bridgeDir, 'src', 'mcp-server.mjs')
const dshBin = process.env.ASTRA_DSH_DSH_BIN || findDsh()
const dshHome = resolve(process.env.ASTRA_DSH_DSH_HOME || join(homedir(), '.dsh'))
const model = process.env.ASTRA_DSH_MODEL || 'deepseek-v4-pro'

const CONFIG_START = '# >>> astra-dsh bridge (managed) >>>'
const CONFIG_END = '# <<< astra-dsh bridge (managed) <<<'
const AGENTS_START = '<!-- >>> astra-dsh bridge (managed) >>> -->'
const AGENTS_END = '<!-- <<< astra-dsh bridge (managed) <<< -->'

const actions = []
if (!dryRun) console.log('Installing Astra ↔ DSH bridge…\n')

installToml()
ensureAcpProfile()
installText(join(codexHome, 'skills', 'astra-dsh', 'SKILL.md'), readFileSync(join(bridgeDir, 'skills/codex/astra-dsh/SKILL.md'), 'utf8'), { backup: false })
installText(join(agentsHome, 'skills', 'astra-dsh', 'SKILL.md'), readFileSync(join(bridgeDir, 'skills/dsh/astra-dsh/SKILL.md'), 'utf8').replaceAll('{{BRIDGE_DIR}}', bridgeDir), { backup: false })
installAgents()
installLauncher()

if (dryRun) {
  console.log('\nDry run only. Re-run with --yes to apply.')
} else {
  console.log(`\nDone: ${actions.length} file(s) written.`)
  console.log('\nNext steps:')
  console.log('  1. Restart Codex so it loads the astra_dsh MCP server.')
  console.log('  2. In a project, say: 把这个需求交给 DSH 执行：…')
  console.log('  3. To start from DSH: astra-dsh request --workspace "$PWD" --title "…" --body-file -')
}

function findDsh() {
  const candidates = [join(homedir(), '.local', 'bin', 'dsh'), '/opt/homebrew/bin/dsh', '/usr/local/bin/dsh']
  return candidates.find((candidate) => existsSync(candidate)) ?? 'dsh'
}

function installToml() {
  const file = join(codexHome, 'config.toml')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!force && /^\s*\[mcp_servers\.astra_dsh\]/m.test(stripManaged(existing))) {
    fail(`[mcp_servers.astra_dsh] already exists outside the managed block in ${file}. Re-run with --force to replace it.`)
  }
  const block = [
    CONFIG_START,
    '[mcp_servers.astra_dsh]',
    `command = ${tomlString(nodePath)}`,
    `args = [${tomlString(serverPath)}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 900',
    'default_tools_approval_mode = "approve"',
    '',
    '[mcp_servers.astra_dsh.env]',
    `ASTRA_DSH_HOME = ${tomlString(bridgeDir)}`,
    `ASTRA_DSH_DSH_BIN = ${tomlString(dshBin)}`,
    `ASTRA_DSH_DSH_HOME = ${tomlString(dshHome)}`,
    `ASTRA_DSH_MODEL = ${tomlString(model)}`,
    CONFIG_END,
  ].join('\n')
  const withMcp = replaceManaged(existing, CONFIG_START, CONFIG_END, block)
  const next = `${ensureWritableRoots(withMcp, dshHome).trimEnd()}\n`
  installText(file, next, { backup: true })
}

function stripManaged(text) {
  return replaceManaged(text, CONFIG_START, CONFIG_END, '')
}

function replaceManaged(text, start, end, replacement) {
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'g')
  const cleaned = text.replace(pattern, () => '')
  if (!replacement) return cleaned
  const base = cleaned.trimEnd()
  return `${base}${base ? '\n\n' : ''}${replacement}\n`
}

function ensureWritableRoots(text, root) {
  const lines = text.split('\n')
  const header = lines.findIndex((line) => /^\[sandbox_workspace_write\]\s*(?:#.*)?$/.test(line))
  const arrayLine = `writable_roots = [${tomlString(root)}]`
  if (header === -1) {
    const base = text.trimEnd()
    return `${base}${base ? '\n\n' : ''}[sandbox_workspace_write]\n${arrayLine}\n`
  }
  let end = lines.length
  for (let i = header + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) { end = i; break }
  }
  const section = lines.slice(header + 1, end)
  const index = section.findIndex((line) => /^\s*writable_roots\s*=/.test(line))
  if (index === -1) {
    lines.splice(header + 1, 0, arrayLine)
    return lines.join('\n')
  }
  const line = section[index]
  if (line.includes(root)) return text
  const match = /^(\s*writable_roots\s*=\s*)\[(.*)\](\s*(?:#.*)?)$/.exec(line)
  if (!match) {
    fail(`writable_roots in ${join(codexHome, 'config.toml')} is not a single-line TOML array; add ${root} manually.`)
  }
  const inner = match[2].trim()
  lines[header + 1 + index] = `${match[1]}[${inner ? `${inner}, ` : ''}${tomlString(root)}]${match[3]}`
  return lines.join('\n')
}

function ensureAcpProfile() {
  const profile = join(dshHome, 'profiles', 'acp', 'package.json')
  if (existsSync(profile)) return
  if (dryRun) {
    note(`will initialize DSH ACP profile under ${dshHome}/profiles/acp`)
    return
  }
  const result = spawnSync(dshBin, ['acp', '--help'], {
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
    timeout: 60_000,
  })
  if (result.status === 0) note(`initialized DSH ACP profile under ${dshHome}/profiles/acp`)
  else note(`warning: could not initialize the ACP profile (${result.error?.message ?? result.stderr?.trim() ?? 'unknown error'})`)
}

function installAgents() {
  const file = join(codexHome, 'AGENTS.md')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const block = `${AGENTS_START}
## Astra ↔ DSH 协作

当用户要求把实现/改造交给 **DSH** 执行、提到 Astra/DSH 协作、或要求从共享任务板 pickup 需求时，使用 \`astra-dsh\` skill 与 MCP server \`astra_dsh\` 的工具。

- Astra 负责规划、拆解、派发、审阅和验收；DSH 负责在共享工作目录执行。
- 当前项目存在 \`.astra-dsh/\` 时，在开始一个新需求前先调用 \`astra_inbox\` 检查是否有 DSH 放入的需求或待审阅任务。
- 派发任务必须包含可验证的验收标准；审阅时读取共享目录中的真实改动，不要只信 DSH 的文字总结。
${AGENTS_END}`
  const next = `${replaceManaged(existing, AGENTS_START, AGENTS_END, block).trimEnd()}\n`
  installText(file, next, { backup: true })
}

function installLauncher() {
  if (!existsSync(localBin)) {
    note(`skip launcher: ${localBin} does not exist (the CLI is still runnable via ${join(bridgeDir, 'bin', 'astra-dsh')})`)
    return
  }
  const file = join(localBin, 'astra-dsh')
  const script = `#!/usr/bin/env bash\nset -euo pipefail\nexec ${shellQuote(nodePath)} ${shellQuote(join(bridgeDir, 'src', 'cli.mjs'))} "$@"\n`
  installText(file, script, { backup: false, mode: 0o755 })
}

function installText(file, content, { backup = false, mode } = {}) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  if (current === content) {
    note(`unchanged ${file}`)
    return
  }
  if (dryRun) {
    note(`${current === undefined ? 'create' : 'update'} ${file}`)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  if (backup && current !== undefined) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = `${file}.bak-astra-dsh-${stamp}`
    copyFileSync(file, backupFile)
    note(`backup ${backupFile}`)
  }
  writeFileSync(file, content, 'utf8')
  if (mode !== undefined) chmodSync(file, mode)
  else if (existsSync(file) && statSync(file).isFile() && file.includes('/bin/')) chmodSync(file, 0o755)
  actions.push(file)
  note(`${current === undefined ? 'created' : 'updated'} ${file}`)
}

function note(message) {
  console.log(`  ${message}`)
}

function fail(message) {
  console.error(`\ninstall: ${message}`)
  process.exit(1)
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
