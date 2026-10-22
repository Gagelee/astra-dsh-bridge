#!/usr/bin/env node
/**
 * Simulates an ACP process that fails at startup (for example a missing profile
 * or a permissions error). It exits non-zero shortly after launch so the bridge
 * observes an ACP_EXITED failure without any chance of a write-failure signal.
 */
setTimeout(() => process.exit(1), 50)
