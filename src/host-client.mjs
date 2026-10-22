/** Newline-delimited JSON client for the private @astra-dsh/host-control socket. */

import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

export class HostControlError extends Error {
  constructor(message, { code = 'HOST_CONTROL_ERROR', details = null } = {}) {
    super(message)
    this.name = 'HostControlError'
    this.code = code
    this.details = details
  }
}

function connectSocket(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new HostControlError(`host control connect timed out after ${timeoutMs}ms`, { code: 'HOST_TIMEOUT' }))
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(new HostControlError(`host control connect failed: ${error.message}`, { code: 'HOST_UNAVAILABLE' }))
    })
  })
}

function lineReader(socket, onLine) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim()) onLine(line)
    }
  })
}

export class HostControlClient {
  constructor(socketPath, { connectTimeoutMs = 500, requestTimeoutMs = 10_000 } = {}) {
    this.socketPath = socketPath
    this.connectTimeoutMs = connectTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    const socket = await connectSocket(this.socketPath, this.connectTimeoutMs)
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new HostControlError(`host control ${method} timed out after ${timeoutMs}ms`, { code: 'HOST_TIMEOUT' }))
      }, timeoutMs)
      timer.unref?.()
      lineReader(socket, (line) => {
        let message
        try { message = JSON.parse(line) } catch { return }
        if (message?.id !== id) return
        clearTimeout(timer)
        socket.destroy()
        if (message.ok) resolve(message.result)
        else reject(new HostControlError(message.error?.message ?? 'host control request failed', {
          code: message.error?.code ?? 'HOST_CONTROL_ERROR',
          details: message.error ?? null,
        }))
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new HostControlError(`host control ${method} failed: ${error.message}`, { code: 'HOST_UNAVAILABLE' }))
      })
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  async *follow(sessionId, { signal, maxMessages } = {}) {
    const socket = await connectSocket(this.socketPath, this.connectTimeoutMs)
    const id = randomUUID()
    const queue = []
    let wake = null
    let ended = false
    let failure = null
    const notify = () => { if (wake) { const resolve = wake; wake = null; resolve() } }
    lineReader(socket, (line) => {
      let message
      try { message = JSON.parse(line) } catch { return }
      if (message?.id !== id) return
      if (message.event === 'frame') queue.push(message.frame)
      else if (message.event === 'end') { ended = true; notify() }
      else if (message.event === 'error') { failure = new HostControlError(message.error?.message ?? 'host follow failed', { code: message.error?.code ?? 'HOST_CONTROL_ERROR' }); ended = true; notify() }
    })
    const abort = () => { socket.destroy(); ended = true; notify() }
    signal?.addEventListener('abort', abort, { once: true })
    socket.once('error', (error) => { failure = new HostControlError(`host follow failed: ${error.message}`, { code: 'HOST_UNAVAILABLE' }); ended = true; notify() })
    socket.once('close', () => { ended = true; notify() })
    socket.write(`${JSON.stringify({ id, method: 'follow', params: { sessionId, ...(maxMessages ? { maxMessages } : {}) } })}\n`)
    try {
      while (true) {
        if (queue.length > 0) { yield queue.shift(); continue }
        if (failure) throw failure
        if (ended) return
        await new Promise((resolve) => { wake = resolve })
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      socket.destroy()
    }
  }

  close() {}
}

export async function probeHostControl(socketPath, { timeoutMs = 700 } = {}) {
  if (!socketPath) return { available: false, error: 'host socket path is not configured' }
  try {
    const client = new HostControlClient(socketPath, { connectTimeoutMs: timeoutMs, requestTimeoutMs: timeoutMs })
    const health = await client.request('health', {}, { timeoutMs })
    return { available: true, ...health }
  } catch (error) {
    return { available: false, error: error?.message ?? String(error), code: error?.code ?? null }
  }
}
