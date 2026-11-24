#!/usr/bin/env node
import WebSocket from 'ws'
import {
  encodeNativeMessageFrames,
  NATIVE_INCOMING_MAX_BYTES,
  NativeMessageDecoder,
  type BridgeMessage,
  type ExtensionHelloMessage,
} from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import { readDaemonConfig } from './config.js'

/**
 * Chrome Native Messaging Host binary (`com.browserpilot.bridge`).
 * Launched automatically by Chrome via `chrome.runtime.connectNative()`.
 * Bridges Chrome's 4-byte length-prefixed stdio frames to the local BrowserPilot Daemon
 * and automatically injects the user's ~/.browserpilot/daemon.json auth token.
 */
async function main(): Promise<void> {
  const daemonClient = await DaemonClient.connectOrStart()
  let currentCfg = daemonClient.config

  let ws: WebSocket | null = null
  let lastHello: ExtensionHelloMessage | null = null
  const pendingOutbound: BridgeMessage[] = []
  let closing = false

  function writeNative(msg: BridgeMessage): void {
    try {
      for (const frame of encodeNativeMessageFrames(msg)) {
        process.stdout.write(frame)
      }
    } catch {
      process.exit(0)
    }
  }

  async function connectDaemon(isReconnect = false): Promise<void> {
    if (closing) return
    if (isReconnect) {
      const fresh = await readDaemonConfig().catch(() => null)
      if (fresh) currentCfg = fresh
    }

    const { host, port, token } = currentCfg
    const wsUrl = `ws://${host}:${port}/extension?transport=native&token=${encodeURIComponent(token)}`
    const socket = new WebSocket(wsUrl)
    ws = socket

    socket.on('open', () => {
      // Replay cached hello on reconnect so a restarted daemon registers this browser immediately
      if (lastHello && !pendingOutbound.some((m) => m.type === 'hello')) {
        socket.send(
          JSON.stringify({
            ...lastHello,
            token: currentCfg.token,
            transport: 'native',
          }),
        )
      }
      while (pendingOutbound.length > 0 && socket.readyState === WebSocket.OPEN) {
        const msg = pendingOutbound.shift()!
        if (msg.type === 'hello') {
          msg.token = currentCfg.token
          msg.transport = 'native'
        }
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
      if (!closing) setTimeout(() => void connectDaemon(true), 1500)
    })

    socket.on('error', () => {
      // close triggers retry
    })
  }

  void connectDaemon(false)

  // Chrome allows up to 64MB for extension -> native host stdin messages (e.g., AXTree, CSS, Retina PNG)
  const decoder = new NativeMessageDecoder(NATIVE_INCOMING_MAX_BYTES)
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      const messages = decoder.push(chunk) as BridgeMessage[]
      for (const msg of messages) {
        // Inject real daemon token automatically for native-authenticated extension
        if (msg.type === 'hello') {
          msg.token = currentCfg.token
          msg.transport = 'native'
          lastHello = { ...msg }
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg))
        } else {
          pendingOutbound.push(msg)
        }
      }
    } catch {
      decoder.reset()
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
