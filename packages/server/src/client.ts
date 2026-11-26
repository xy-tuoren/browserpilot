import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserClientInfo, SessionInfo, TabGroupColor } from '@browserpilot/protocol'
import {
  isDaemonReachable,
  loadOrCreateDaemonConfig,
  type DaemonConfigFile,
} from './config.js'
import type { ToolExecutionResult } from './tools.js'

const rawDir = path.dirname(fileURLToPath(import.meta.url))
const __dirname = path.basename(rawDir) === 'chunks' ? path.dirname(rawDir) : rawDir

export class DaemonClient {
  readonly config: DaemonConfigFile

  constructor(config: DaemonConfigFile) {
    this.config = config
  }

  static async connectOrStart(overrides?: { host?: string; port?: number; token?: string }): Promise<DaemonClient> {
    const cfg = await loadOrCreateDaemonConfig(overrides)
    if (await isDaemonReachable(cfg)) {
      return new DaemonClient(cfg)
    }

    // Auto-spawn local daemon in detached background mode
    const cliEntry = path.resolve(__dirname, 'cli.js')
    const child = spawn(
      process.execPath,
      [cliEntry, 'daemon', 'run', '--host', cfg.host, '--port', String(cfg.port)],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, BROWSERPILOT_DAEMON_TOKEN: cfg.token },
      },
    )
    child.unref()

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 120))
      if (await isDaemonReachable(cfg)) {
        return new DaemonClient(cfg)
      }
    }

    throw new Error(`BrowserPilot daemon failed to start on ${cfg.host}:${cfg.port}`)
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://${this.config.host}:${this.config.port}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = (await res.json()) as T & { error?: string }
    if (!res.ok) {
      throw new Error(data.error || `Daemon request ${method} ${route} failed with HTTP ${res.status}`)
    }
    return data
  }

  async health(): Promise<{ ok: boolean; version: string; pid?: number; uptimeMs: number; clients: BrowserClientInfo[] }> {
    return await this.request('GET', '/api/health')
  }

  async connectDirectCDP(endpoint: string): Promise<BrowserClientInfo> {
    const res = await this.request<{ client: BrowserClientInfo }>('POST', '/api/connect-cdp', { endpoint })
    return res.client
  }

  async createSession(options?: { id?: string; tabGroup?: string; tabGroupColor?: TabGroupColor }): Promise<SessionInfo> {
    const res = await this.request<{ session: SessionInfo }>('POST', '/api/sessions', options ?? {})
    return res.session
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.request<{ sessions: SessionInfo[] }>('GET', '/api/sessions')
    return res.sessions
  }

  async resetSession(id: string): Promise<SessionInfo> {
    const res = await this.request<{ session: SessionInfo }>('POST', '/api/sessions/reset', { id })
    return res.session
  }

  async updateSession(id: string, options: { tabGroup?: string; tabGroupColor?: TabGroupColor }): Promise<SessionInfo> {
    const res = await this.request<{ session: SessionInfo }>('POST', '/api/sessions/update', { id, ...options })
    return res.session
  }

  async closeSession(id: string): Promise<boolean> {
    const res = await this.request<{ deleted: boolean }>('POST', '/api/sessions/close', { id })
    return res.deleted
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
    return await this.request<ToolExecutionResult>('POST', '/api/tool', { name, args })
  }

  async shutdown(): Promise<void> {
    await this.request('POST', '/api/shutdown').catch(() => {})
  }
}
