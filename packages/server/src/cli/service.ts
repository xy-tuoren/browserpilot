import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { getDaemonLogPath, loadOrCreateDaemonConfig } from '../config.js'
import { resolveServerEntryDir } from './args.js'

const execFileAsync = promisify(execFile)

export interface DaemonServiceResult {
  platform: NodeJS.Platform
  installed: boolean
  servicePath: string
  label: string
  dryRun?: boolean
  note?: string
}

const MAC_LABEL = 'com.browserpilot.daemon'
const LINUX_UNIT = 'browserpilot-daemon.service'
const WIN_TASK = 'BrowserPilotDaemon'

export function getDaemonServiceFilePath(platform: NodeJS.Platform = process.platform, homeDir = os.homedir()): string {
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`)
  }
  if (platform === 'linux') {
    return path.join(homeDir, '.config', 'systemd', 'user', LINUX_UNIT)
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming')
    return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'BrowserPilotDaemon.cmd')
  }
  return path.join(homeDir, '.browserpilot', 'daemon-service.txt')
}

export function buildMacLaunchAgentPlist(opts: {
  nodePath: string
  cliPath: string
  host: string
  port: number
  logPath: string
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(opts.nodePath)}</string>
    <string>${esc(opts.cliPath)}</string>
    <string>daemon</string>
    <string>run</string>
    <string>--host</string>
    <string>${esc(opts.host)}</string>
    <string>--port</string>
    <string>${opts.port}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(opts.logPath)}</string>
</dict>
</plist>
`
}

export function buildLinuxSystemdUnit(opts: {
  nodePath: string
  cliPath: string
  host: string
  port: number
}): string {
  return `[Unit]
Description=BrowserPilot Local CDP Bridge Daemon
After=network.target

[Service]
Type=simple
ExecStart="${opts.nodePath}" "${opts.cliPath}" daemon run --host ${opts.host} --port ${opts.port}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`
}

export function buildWindowsStartupScript(opts: {
  nodePath: string
  cliPath: string
  host: string
  port: number
}): string {
  return `@echo off\r\nstart "" /B "${opts.nodePath}" "${opts.cliPath}" daemon run --host ${opts.host} --port ${opts.port}\r\n`
}

export async function installDaemonService(options: {
  dryRun?: boolean
  platform?: NodeJS.Platform
  homeDir?: string
} = {}): Promise<DaemonServiceResult> {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const cfg = await loadOrCreateDaemonConfig()
  const cliPath = path.join(resolveServerEntryDir(import.meta.url), 'cli.js')
  const nodePath = process.execPath
  const servicePath = getDaemonServiceFilePath(platform, homeDir)
  const logPath = getDaemonLogPath()

  if (platform === 'darwin') {
    const content = buildMacLaunchAgentPlist({ nodePath, cliPath, host: cfg.host, port: cfg.port, logPath })
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(servicePath), { recursive: true })
      await fs.writeFile(servicePath, content, 'utf8')
      await execFileAsync('launchctl', ['unload', servicePath]).catch(() => {})
      await execFileAsync('launchctl', ['load', '-w', servicePath]).catch(() => {})
    }
    return { platform, installed: true, servicePath, label: MAC_LABEL, dryRun: options.dryRun }
  }

  if (platform === 'linux') {
    const content = buildLinuxSystemdUnit({ nodePath, cliPath, host: cfg.host, port: cfg.port })
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(servicePath), { recursive: true })
      await fs.writeFile(servicePath, content, 'utf8')
      await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {})
      await execFileAsync('systemctl', ['--user', 'enable', '--now', LINUX_UNIT]).catch(() => {})
    }
    return { platform, installed: true, servicePath, label: LINUX_UNIT, dryRun: options.dryRun }
  }

  if (platform === 'win32') {
    const content = buildWindowsStartupScript({ nodePath, cliPath, host: cfg.host, port: cfg.port })
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(servicePath), { recursive: true })
      await fs.writeFile(servicePath, content, 'utf8')
    }
    return { platform, installed: true, servicePath, label: WIN_TASK, dryRun: options.dryRun }
  }

  throw new Error(`Unsupported platform for daemon auto-start service: ${platform}`)
}

export async function uninstallDaemonService(options: {
  dryRun?: boolean
  platform?: NodeJS.Platform
  homeDir?: string
} = {}): Promise<DaemonServiceResult> {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const servicePath = getDaemonServiceFilePath(platform, homeDir)
  const label = platform === 'darwin' ? MAC_LABEL : platform === 'linux' ? LINUX_UNIT : WIN_TASK

  if (!options.dryRun) {
    if (platform === 'darwin') {
      await execFileAsync('launchctl', ['unload', '-w', servicePath]).catch(() => {})
    } else if (platform === 'linux') {
      await execFileAsync('systemctl', ['--user', 'disable', '--now', LINUX_UNIT]).catch(() => {})
    }
    await fs.rm(servicePath, { force: true }).catch(() => {})
    if (platform === 'linux') {
      await execFileAsync('systemctl', ['--user', 'daemon-reload']).catch(() => {})
    }
  }
  return { platform, installed: false, servicePath, label, dryRun: options.dryRun }
}
