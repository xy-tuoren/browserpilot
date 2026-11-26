import {
  BridgeChunkReassembler,
  BROWSERPILOT_VERSION,
  NATIVE_HOST_NAME,
  type BridgeEvent,
  type BridgeMessage,
  type BridgeRequest,
  type BridgeResponse,
  type ExtensionHelloMessage,
} from '@browserpilot/protocol'
import { bgState, broadcastUiUpdate, logActivity, updateBadge } from './state.js'

let nativePort: chrome.runtime.Port | null = null
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let nativeRetryAfter = 0
let nativeEverConnected = false
let wsConsecutiveFailures = 0
const chunkReassembler = new BridgeChunkReassembler()

type RpcExecutor = (method: string, params: Record<string, unknown>) => Promise<unknown>
let rpcExecutor: RpcExecutor | null = null

export function setBridgeRpcExecutor(executor: RpcExecutor): void {
  rpcExecutor = executor
}

export function resetBridgeBackoff(): void {
  nativeRetryAfter = 0
  wsConsecutiveFailures = 0
}

export function sendToBridge(msg: BridgeMessage): void {
  if (bgState.transportMode === 'native' && nativePort) {
    try {
      nativePort.postMessage(msg)
    } catch {
      handleTransportDisconnected('native')
    }
  } else if (bgState.transportMode === 'websocket' && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      handleTransportDisconnected('websocket')
    }
  }
}

export function sendEvent(event: string, params?: Record<string, unknown>): void {
  if (bgState.transportMode === 'disconnected') return
  const msg: BridgeEvent = { type: 'event', event, params }
  sendToBridge(msg)
}

function detectBrowserBrand(): string {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'Edge'
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera'
  if (ua.includes('Vivaldi')) return 'Vivaldi'
  if (ua.includes('Brave') || Boolean((navigator as { brave?: unknown }).brave)) return 'Brave'
  return 'Chrome'
}

function sendHello(transport: 'native' | 'websocket'): void {
  const hello: ExtensionHelloMessage = {
    type: 'hello',
    token: bgState.config.authToken,
    extensionId: chrome.runtime.id,
    extensionVersion: BROWSERPILOT_VERSION,
    browser: detectBrowserBrand(),
    transport,
    ...(bgState.config.profileLabel?.trim() ? { profileLabel: bgState.config.profileLabel.trim() } : {}),
  }
  sendToBridge(hello)
}

function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (bgState.transportMode !== 'disconnected') {
      sendToBridge({ type: 'ping', ts: Date.now() })
    }
  }, 18_000)
}

export function disconnectTransport(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  if (nativePort) {
    try {
      nativePort.disconnect()
    } catch {}
    nativePort = null
  }
  if (ws) {
    try {
      ws.close()
    } catch {}
    ws = null
  }
  bgState.transportMode = 'disconnected'
  updateBadge()
}

export function scheduleConnect(delayMs: number): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connectBridge()
  }, delayMs)
}

function hasWebSocketToken(): boolean {
  if (bgState.config.authToken.trim()) return true
  try {
    const url = new URL(bgState.config.daemonUrl)
    return Boolean(url.searchParams.get('token')?.trim())
  } catch {
    return false
  }
}

function handleTransportDisconnected(source: 'native' | 'websocket', wsOpened = true): void {
  if (source === 'native') {
    nativePort = null
    nativeRetryAfter = nativeEverConnected || !hasWebSocketToken() ? 0 : Date.now() + 30_000
  } else {
    ws = null
    if (!wsOpened) {
      wsConsecutiveFailures++
      nativeRetryAfter = 0
    } else {
      wsConsecutiveFailures = 0
    }
  }
  if (bgState.transportMode === source) {
    bgState.transportMode = 'disconnected'
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    updateBadge()
    broadcastUiUpdate()
  }
  const nextDelay =
    source === 'native'
      ? nativeEverConnected
        ? 1_500
        : hasWebSocketToken()
          ? 2_000
          : 5_000
      : wsOpened
        ? 2_000
        : Math.min(30_000, 5_000 * wsConsecutiveFailures)
  scheduleConnect(nextDelay)
}

async function handleBridgeMessage(msg: BridgeMessage): Promise<void> {
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'chunk') {
    let assembled: BridgeMessage | null = null
    try {
      assembled = chunkReassembler.push(msg)
    } catch {
      return
    }
    if (assembled) {
      await handleBridgeMessage(assembled)
    }
    return
  }

  if (msg.type === 'ping') {
    sendToBridge({ type: 'pong', ts: msg.ts })
    return
  }
  if (msg.type === 'pong') return
  if (msg.type === 'event') {
    if (msg.event === 'bridge.ready') {
      const ver = typeof msg.params?.version === 'string' ? ` (daemon v${msg.params.version})` : ''
      logActivity('bridge.ready', 'ok', `Connected via ${bgState.transportMode === 'native' ? 'Native Messaging' : 'WebSocket'}${ver}`)
      updateBadge()
      broadcastUiUpdate()
    }
    return
  }
  if (msg.type !== 'request') return

  const req = msg as BridgeRequest
  const start = Date.now()
  let response: BridgeResponse

  try {
    if (!rpcExecutor) throw new Error('Bridge RPC executor not initialized')
    const result = await rpcExecutor(req.method, req.params ?? {})
    response = { type: 'response', id: req.id, ok: true, result }
    if (req.method !== 'cdp.send' && req.method !== 'tabs.list' && req.method !== 'extension.getState') {
      logActivity(req.method, 'ok', undefined, req.params?.tabId as number | undefined, Date.now() - start)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    response = {
      type: 'response',
      id: req.id,
      ok: false,
      error: { code: 'EXTENSION_ERROR', message },
    }
    logActivity(req.method, 'error', message, req.params?.tabId as number | undefined, Date.now() - start)
  }

  sendToBridge(response)
}

export async function connectBridge(): Promise<void> {
  if (bgState.transportMode !== 'disconnected') return

  if (Date.now() >= nativeRetryAfter && typeof chrome.runtime.connectNative === 'function') {
    try {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
      nativePort = port
      bgState.transportMode = 'native'

      let receivedValidTraffic = false
      port.onMessage.addListener((msg: unknown) => {
        receivedValidTraffic = true
        nativeEverConnected = true
        wsConsecutiveFailures = 0
        void handleBridgeMessage(msg as BridgeMessage)
      })
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError?.message
        if (!receivedValidTraffic) {
          nativePort = null
          if (bgState.transportMode === 'native') bgState.transportMode = 'disconnected'
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
          updateBadge()
          broadcastUiUpdate()
          const nativeHostMissing = Boolean(err && /not found|forbidden|invalid/i.test(err))
          if (nativeHostMissing && !nativeEverConnected && hasWebSocketToken()) {
            nativeRetryAfter = Date.now() + 60_000
            void connectWebSocket()
          } else {
            const delay = nativeEverConnected ? 1_500 : nativeHostMissing ? 10_000 : 3_000
            nativeRetryAfter = Date.now() + delay
            scheduleConnect(delay)
          }
          return
        }
        handleTransportDisconnected('native')
      })

      sendHello('native')
      startHeartbeat()
      updateBadge()
      broadcastUiUpdate()
      return
    } catch {
      nativeRetryAfter = Date.now() + 60_000
    }
  }

  await connectWebSocket()
}

export async function connectWebSocket(): Promise<void> {
  if (bgState.transportMode !== 'disconnected') return
  if (!bgState.config.daemonUrl) return

  let url: URL
  try {
    url = new URL(bgState.config.daemonUrl)
  } catch {
    return
  }

  const effectiveToken = bgState.config.authToken.trim() || url.searchParams.get('token')?.trim() || ''
  if (!effectiveToken) {
    updateBadge()
    broadcastUiUpdate()
    scheduleConnect(nativeEverConnected ? 1_500 : 10_000)
    return
  }

  try {
    url.searchParams.set('token', effectiveToken)
    const socket = new WebSocket(url.toString())
    ws = socket
    let wsOpened = false

    socket.addEventListener('open', () => {
      if (ws !== socket) return
      wsOpened = true
      wsConsecutiveFailures = 0
      bgState.transportMode = 'websocket'
      sendHello('websocket')
      startHeartbeat()
      updateBadge()
      broadcastUiUpdate()
      logActivity('bridge.connect', 'info', `Connected via WebSocket (${bgState.config.daemonUrl})`)
    })

    socket.addEventListener('message', (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as BridgeMessage
        void handleBridgeMessage(parsed)
      } catch {
        // ignore malformed message
      }
    })

    socket.addEventListener('close', () => {
      if (ws === socket) {
        handleTransportDisconnected('websocket', wsOpened)
      }
    })

    socket.addEventListener('error', () => {
      // close event triggers reconnect
    })
  } catch {
    scheduleConnect(5_000)
  }
}
