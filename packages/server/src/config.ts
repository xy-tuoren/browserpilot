import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_DAEMON_HOST, DEFAULT_DAEMON_PORT } from '@browserpilot/protocol'

export interface DaemonConfigFile {
  host: string
  port: number
  token: string
  pid?: number
  startedAt?: number
}

export function getBrowserPilotHomeDir(): string {
  return process.env.BROWSERPILOT_HOME || path.join(os.homedir(), '.browserpilot')
}

export function getDaemonConfigPath(): string {
  return path.join(getBrowserPilotHomeDir(), 'daemon.json')
}

export function getDaemonLogPath(): string {
  return path.join(getBrowserPilotHomeDir(), 'daemon.log')
}

export async function ensureBrowserPilotHome(): Promise<string> {
  const dir = getBrowserPilotHomeDir()
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

export async function loadOrCreateDaemonConfig(overrides?: {
  host?: string
  port?: number
  token?: string
}): Promise<DaemonConfigFile> {
  await ensureBrowserPilotHome()
  const filePath = getDaemonConfigPath()
  let existing: Partial<DaemonConfigFile> = {}
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    existing = JSON.parse(raw) as Partial<DaemonConfigFile>
  } catch {
    // fresh install
  }

  const cfg: DaemonConfigFile = {
    host: overrides?.host ?? existing.host ?? DEFAULT_DAEMON_HOST,
    port: overrides?.port ?? existing.port ?? DEFAULT_DAEMON_PORT,
    token: overrides?.token ?? existing.token ?? crypto.randomBytes(24).toString('hex'),
    pid: existing.pid,
    startedAt: existing.startedAt,
  }

  await fs.writeFile(filePath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  return cfg
}

export async function writeDaemonRuntimeInfo(cfg: DaemonConfigFile): Promise<void> {
  await ensureBrowserPilotHome()
  await fs.writeFile(getDaemonConfigPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
}

export async function readDaemonConfig(): Promise<DaemonConfigFile | null> {
  try {
    const raw = await fs.readFile(getDaemonConfigPath(), 'utf8')
    return JSON.parse(raw) as DaemonConfigFile
  } catch {
    return null
  }
}

export async function isDaemonReachable(cfg: DaemonConfigFile): Promise<boolean> {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/api/health`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(1200),
    })
    return res.ok
  } catch {
    return false
  }
}
