import { NATIVE_CHUNK_MAX_CHARS, NATIVE_MESSAGE_MAX_BYTES } from './constants.js'

/**
 * Bidirectional JSON-RPC message schema between Chrome Extension and Local Daemon / Native Host.
 */
export interface ExtensionHelloMessage {
  type: 'hello'
  token: string
  extensionId: string
  extensionVersion: string
  browser: string
  transport: 'native' | 'websocket'
  profileEmail?: string
}

export interface BridgeRequest {
  type: 'request'
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface BridgeResponse {
  type: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    details?: unknown
  }
}

export interface BridgeEvent {
  type: 'event'
  event: string
  params?: Record<string, unknown>
}

export interface BridgePing {
  type: 'ping'
  ts: number
}

export interface BridgePong {
  type: 'pong'
  ts: number
}

export interface BridgeChunkMessage {
  type: 'chunk'
  chunkId: string
  index: number
  total: number
  data: string
}

export type BridgeMessage =
  | ExtensionHelloMessage
  | BridgeRequest
  | BridgeResponse
  | BridgeEvent
  | BridgePing
  | BridgePong
  | BridgeChunkMessage

/**
 * Encode a JSON-serializable object into Chrome Native Messaging binary framing:
 * 4-byte unsigned 32-bit little-endian byte length followed by UTF-8 JSON bytes.
 */
export function encodeNativeMessage(message: unknown): Buffer {
  const json = JSON.stringify(message)
  const payload = Buffer.from(json, 'utf8')
  if (payload.length > NATIVE_MESSAGE_MAX_BYTES) {
    throw new Error(
      `Native message size (${payload.length} bytes) exceeds Chrome 1MB limit (${NATIVE_MESSAGE_MAX_BYTES} bytes)`,
    )
  }
  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

let chunkSeq = 1

/**
 * Encodes a message into one or more Chrome Native Messaging frames, automatically
 * splitting payloads that exceed Chrome's 1MB host->extension cap into `chunk` frames.
 */
export function encodeNativeMessageFrames(
  message: unknown,
  maxCharsPerChunk: number = NATIVE_CHUNK_MAX_CHARS,
): Buffer[] {
  const json = JSON.stringify(message)
  const payload = Buffer.from(json, 'utf8')
  if (payload.length <= NATIVE_MESSAGE_MAX_BYTES - 1024) {
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32LE(payload.length, 0)
    payload.copy(frame, 4)
    return [frame]
  }

  const chunkId = `chk_${Date.now().toString(36)}_${chunkSeq++}`
  const parts: string[] = []
  for (let i = 0; i < json.length; i += maxCharsPerChunk) {
    parts.push(json.slice(i, i + maxCharsPerChunk))
  }
  return parts.map((data, index) =>
    encodeNativeMessage({
      type: 'chunk',
      chunkId,
      index,
      total: parts.length,
      data,
    } satisfies BridgeChunkMessage),
  )
}

/**
 * Reassembles chunked BridgeChunkMessage packets back into the original BridgeMessage.
 */
export class BridgeChunkReassembler {
  private pending = new Map<string, { total: number; parts: Array<string | undefined>; received: number; createdAt: number }>()

  push(chunk: BridgeChunkMessage): BridgeMessage | null {
    const now = Date.now()
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt > 60_000) this.pending.delete(id)
    }

    let entry = this.pending.get(chunk.chunkId)
    if (!entry) {
      entry = { total: chunk.total, parts: new Array(chunk.total), received: 0, createdAt: now }
      this.pending.set(chunk.chunkId, entry)
    }
    if (entry.parts[chunk.index] === undefined) {
      entry.parts[chunk.index] = chunk.data
      entry.received++
    }
    if (entry.received < entry.total) return null

    this.pending.delete(chunk.chunkId)
    return JSON.parse(entry.parts.join('')) as BridgeMessage
  }
}

/**
 * Stateful streaming decoder for Chrome Native Messaging 4-byte length-prefixed frames.
 * Safely handles arbitrary chunk boundaries, multi-message chunks, and UTF-8 multi-byte chars.
 */
export class NativeMessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly maxBytes: number

  constructor(maxBytes: number = NATIVE_MESSAGE_MAX_BYTES) {
    this.maxBytes = maxBytes
  }

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0)
      if (length > this.maxBytes) {
        this.buffer = Buffer.alloc(0)
        throw new Error(`Incoming native message length (${length} bytes) exceeds limit (${this.maxBytes} bytes)`)
      }
      if (this.buffer.length < 4 + length) {
        break
      }
      const payload = this.buffer.subarray(4, 4 + length).toString('utf8')
      this.buffer = this.buffer.subarray(4 + length)
      messages.push(JSON.parse(payload))
    }

    return messages
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}

/**
 * Domain matcher supporting exact hostname ("example.com") and wildcard ("*.example.com").
 */
export function matchesDomainPattern(url: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase()
  if (!normalized) return false
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2)
    return hostname === suffix || hostname.endsWith(`.${suffix}`)
  }
  return hostname === normalized
}

export function isUrlAllowedByDomainRules(
  url: string,
  rules: { blockedDomains: string[]; allowedDomains: string[] },
): boolean {
  if (rules.blockedDomains.some((p) => matchesDomainPattern(url, p))) {
    return false
  }
  if (rules.allowedDomains.length > 0) {
    return rules.allowedDomains.some((p) => matchesDomainPattern(url, p))
  }
  return true
}
