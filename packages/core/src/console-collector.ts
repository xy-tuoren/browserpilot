import { MAX_CONSOLE_BUFFER, type ConsoleEntry, type ConsoleLevel } from '@devpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

interface RemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  preview?: {
    properties?: Array<{ name: string; value?: string; type?: string }>
  }
}

function formatRemoteObject(obj: RemoteObject): string {
  if (obj.value !== undefined) {
    return typeof obj.value === 'string' ? obj.value : JSON.stringify(obj.value)
  }
  if (obj.description) return obj.description
  if (obj.preview?.properties?.length) {
    const props = obj.preview.properties.map((p) => `${p.name}: ${p.value ?? p.type}`).join(', ')
    return `{ ${props} }`
  }
  return obj.type ?? ''
}

function formatStackTrace(stackTrace?: {
  callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }>
}): string | undefined {
  const frames = stackTrace?.callFrames
  if (!frames?.length) return undefined
  return frames
    .slice(0, 12)
    .map((f) => `  at ${f.functionName || '(anonymous)'} (${f.url || '<eval>'}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1})`)
    .join('\n')
}

function mapConsoleType(type: string): ConsoleLevel {
  switch (type) {
    case 'warning':
    case 'warn':
      return 'warn'
    case 'error':
      return 'error'
    case 'info':
      return 'info'
    case 'debug':
      return 'debug'
    case 'trace':
      return 'trace'
    case 'assert':
      return 'assert'
    default:
      return 'log'
  }
}

export interface GetConsoleOptions {
  count?: number
  level?: ConsoleLevel | 'all'
  search?: string | RegExp
  sinceLastCall?: boolean
  cursorKey?: string
}

export class ConsoleCollector {
  private entries: ConsoleEntry[] = []
  private nextId = 1
  private cursors = new Map<string, number>()
  private unsubscribers: Array<() => void> = []

  constructor(session: TabCDPSession) {
    this.unsubscribers.push(
      session.on('Runtime.consoleAPICalled', (params) => {
        const args = (params.args as RemoteObject[] | undefined) ?? []
        const text = args.map(formatRemoteObject).join(' ').slice(0, 4000)
        const stack = params.stackTrace as {
          callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }>
        } | undefined
        const topFrame = stack?.callFrames?.[0]
        this.push({
          timestamp: Date.now(),
          level: mapConsoleType(String(params.type ?? 'log')),
          text,
          url: topFrame?.url,
          lineNumber: topFrame?.lineNumber !== undefined ? topFrame.lineNumber + 1 : undefined,
          columnNumber: topFrame?.columnNumber !== undefined ? topFrame.columnNumber + 1 : undefined,
          stackTrace: params.type === 'error' || params.type === 'trace' ? formatStackTrace(stack) : undefined,
          source: 'console',
        })
      }),
    )

    this.unsubscribers.push(
      session.on('Runtime.exceptionThrown', (params) => {
        const details = (params.exceptionDetails ?? {}) as {
          text?: string
          url?: string
          lineNumber?: number
          columnNumber?: number
          exception?: RemoteObject
          stackTrace?: {
            callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }>
          }
        }
        const text = details.exception?.description || details.text || 'Uncaught exception'
        this.push({
          timestamp: Date.now(),
          level: 'exception',
          text: text.slice(0, 4000),
          url: details.url,
          lineNumber: details.lineNumber !== undefined ? details.lineNumber + 1 : undefined,
          columnNumber: details.columnNumber !== undefined ? details.columnNumber + 1 : undefined,
          stackTrace: formatStackTrace(details.stackTrace),
          source: 'exception',
        })
      }),
    )

    this.unsubscribers.push(
      session.on('Log.entryAdded', (params) => {
        const entry = (params.entry ?? {}) as {
          level?: string
          text?: string
          url?: string
          lineNumber?: number
          stackTrace?: {
            callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }>
          }
        }
        this.push({
          timestamp: Date.now(),
          level: entry.level === 'error' ? 'error' : entry.level === 'warning' ? 'warn' : 'browser',
          text: String(entry.text ?? '').slice(0, 4000),
          url: entry.url,
          lineNumber: entry.lineNumber !== undefined ? entry.lineNumber + 1 : undefined,
          stackTrace: formatStackTrace(entry.stackTrace),
          source: 'browser',
        })
      }),
    )
  }

  private push(entry: Omit<ConsoleEntry, 'id'>): void {
    this.entries.push({ ...entry, id: this.nextId++ })
    if (this.entries.length > MAX_CONSOLE_BUFFER) {
      this.entries.splice(0, this.entries.length - MAX_CONSOLE_BUFFER)
    }
  }

  ingestPrebuffered(entries: Array<Omit<ConsoleEntry, 'id'>>): void {
    for (const e of entries) this.push(e)
  }

  getLatestId(): number {
    return this.nextId - 1
  }

  getLogs(options: GetConsoleOptions = {}): ConsoleEntry[] {
    const cursorKey = options.cursorKey ?? 'default'
    let list = this.entries

    if (options.sinceLastCall) {
      const lastSeen = this.cursors.get(cursorKey) ?? 0
      list = list.filter((e) => e.id > lastSeen)
    }

    if (options.level && options.level !== 'all') {
      if (options.level === 'error') {
        list = list.filter((e) => e.level === 'error' || e.level === 'exception')
      } else {
        list = list.filter((e) => e.level === options.level)
      }
    }

    if (options.search !== undefined) {
      const regex = options.search instanceof RegExp ? options.search : new RegExp(options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      list = list.filter((e) => regex.test(e.text) || (e.url && regex.test(e.url)) || (e.stackTrace && regex.test(e.stackTrace)))
    }

    this.cursors.set(cursorKey, this.getLatestId())

    const count = options.count ?? 100
    return list.slice(-count)
  }

  getErrorsSince(sinceId: number): ConsoleEntry[] {
    return this.entries.filter((e) => e.id > sinceId && (e.level === 'error' || e.level === 'exception'))
  }

  clear(): void {
    this.entries = []
  }

  dispose(): void {
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
  }
}

export function formatConsoleLogs(entries: ConsoleEntry[]): string {
  if (!entries.length) return '(no console entries)'
  return entries
    .map((e) => {
      const loc = e.url ? ` (${e.url}${e.lineNumber ? `:${e.lineNumber}` : ''})` : ''
      const stack = e.stackTrace ? `\n${e.stackTrace}` : ''
      return `[${e.level.toUpperCase()}] ${e.text}${loc}${stack}`
    })
    .join('\n')
}
