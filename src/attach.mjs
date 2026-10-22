/**
 * Bridge-side entry point for the shared attach protocol. The canonical
 * implementation lives in `gui-plugin/protocol.js` so the GUI bundle is
 * self-contained; this module re-exports it and re-wraps the two throwing
 * helpers so the bridge surfaces clean `BridgeError` codes through MCP.
 */

export * from '../gui-plugin/protocol.js'

import { canonicalWorkspacePath as protocolCanonicalWorkspacePath, normalizeGuiPolicy as protocolNormalizeGuiPolicy } from '../gui-plugin/protocol.js'
import { BridgeError } from './util.mjs'

export function normalizeGuiPolicy(value) {
  try {
    return protocolNormalizeGuiPolicy(value)
  } catch (error) {
    throw new BridgeError(error?.message ?? 'invalid guiPolicy', { code: error?.code ?? 'BAD_TASK' })
  }
}

export function canonicalWorkspacePath(path) {
  try {
    return protocolCanonicalWorkspacePath(path)
  } catch (error) {
    throw new BridgeError(error?.message ?? 'invalid workspace path', { code: error?.code ?? 'BAD_WORKSPACE' })
  }
}
