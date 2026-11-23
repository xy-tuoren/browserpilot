#!/usr/bin/env node
import WebSocket from 'ws'
import {
  encodeNativeMessage,
  NativeMessageDecoder,
  type BridgeMessage,
} from '@devpilot/protocol'
import { DaemonClient } from './client.js'

/**
 * Chrome Native Messaging Host binary (`com.devpilot.bridge`).
 * Launched automatically by Chrome via `chrome.runtime.connectNative()`.
 * Bridges Chrome's 4-byte length-prefixed stdio frames to the local DevPilot Daemon
 * and automatically injects the user's ~/.devpilot/daemon.json auth token.
 */
async function main(): Promise<void> {
  const daemonClient = await DaemonClient.connectOrStart()
  const { host, port, token } = daemonClient.config
  const wsUrl = `ws://${host}:${port}/extension?transport=native&token=${encodeURIComponent(token)}`

  let ws: WebSocket | null = null
  const pendingOutbound: BridgeMessage[] = []
  let closing = false

  function writeNative(msg: BridgeMessage): void {
    try {
      process.stdout.write(encodeNativeMessage(msg))
    } catch {
      process.exit(0)
    }
  }

  function connectDaemon(): void {
    if (closing) return
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.on('open', () => {
      while (pendingOutbound.length > 0 && socket.readyState === WebSocket.OPEN) {
        const msg = pendingOutbound.shift()!
        socket.send(JSON.stringify(msg))
      }
    })

    socket.on('message', (raw) => {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as BridgeMessage
        writeNative(parsed)
      } catch {
        // ignore malformed message
      }
    })

    socket.on('close', () => {
      if (ws === socket) ws = null
      if (!closing) setTimeout(connectDaemon, 1000)
    })

    socket.on('error', () => {
      // close triggers retry
    })
  }

  connectDaemon()

  const decoder = new NativeMessageDecoder()
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      const messages = decoder.push(chunk) as BridgeMessage[]
      for (const msg of messages) {
        // Inject real daemon token automatically for native-authenticated extension
        if (msg.type === 'hello') {
          msg.token = token
          msg.transport = 'native'
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg))
        } else {
          pendingOutbound.push(msg)
        }
      }
    } catch {
      process.exit(1)
    }
  })

  process.stdin.on('end', () => {
    closing = true
    ws?.close()
    process.exit(0)
  })
}

void main().catch(() => {
  process.exit(1)
})
