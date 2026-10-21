#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

const out = process.env.MOCK_CODEX_OUT
if (!out) process.exit(2)
appendFileSync(out, `${JSON.stringify({ args: process.argv.slice(2), at: Date.now() })}\n`)
