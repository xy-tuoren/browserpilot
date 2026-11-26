import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { NATIVE_HOST_NAME } from '@browserpilot/protocol'
import { ensureBrowserPilotHome, getBrowserPilotHomeDir } from './config.js'

const execFileAsync = promisify(execFile)
const rawDir = path.dirname(fileURLToPath(import.meta.url))
const __dirname = path.basename(rawDir) === 'chunks' ? path.dirname(rawDir) : rawDir

export interface BrowserHostTarget {
  name: string
  dir: string
  userDataDir: string
  registryKey?: string
}

export function getNativeMessagingHostDirs(platform: NodeJS.Platform = process.platform): BrowserHostTarget[] {
  const home = os.homedir()
  if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support')
    return [
      {
        name: 'Google Chrome',
        userDataDir: path.join(appSupport, 'Google', 'Chrome'),
        dir: path.join(appSupport, 'Google', 'Chrome', 'NativeMessagingHosts'),
      },
      {
        name: 'Google Chrome Canary',
        userDataDir: path.join(appSupport, 'Google', 'Chrome Canary'),
        dir: path.join(appSupport, 'Google', 'Chrome Canary', 'NativeMessagingHosts'),
      },
      {
        name: 'Google Chrome for Testing',
        userDataDir: path.join(appSupport, 'Google', 'Chrome for Testing'),
        dir: path.join(appSupport, 'Google', 'Chrome for Testing', 'NativeMessagingHosts'),
      },
      {
        name: 'Chromium',
        userDataDir: path.join(appSupport, 'Chromium'),
        dir: path.join(appSupport, 'Chromium', 'NativeMessagingHosts'),
      },
      {
        name: 'Brave',
        userDataDir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
        dir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      },
      {
        name: 'Microsoft Edge',
        userDataDir: path.join(appSupport, 'Microsoft Edge'),
        dir: path.join(appSupport, 'Microsoft Edge', 'NativeMessagingHosts'),
      },
      {
        name: 'Arc',
        userDataDir: path.join(appSupport, 'Arc', 'User Data'),
        dir: path.join(appSupport, 'Arc', 'User Data', 'NativeMessagingHosts'),
      },
    ]
  }
  if (platform === 'linux') {
    const config = path.join(home, '.config')
    return [
      {
        name: 'Google Chrome',
        userDataDir: path.join(config, 'google-chrome'),
        dir: path.join(config, 'google-chrome', 'NativeMessagingHosts'),
      },
      {
        name: 'Chromium',
        userDataDir: path.join(config, 'chromium'),
        dir: path.join(config, 'chromium', 'NativeMessagingHosts'),
      },
      {
        name: 'Brave',
        userDataDir: path.join(config, 'BraveSoftware', 'Brave-Browser'),
        dir: path.join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'),
      },
      {
        name: 'Microsoft Edge',
        userDataDir: path.join(config, 'microsoft-edge'),
        dir: path.join(config, 'microsoft-edge', 'NativeMessagingHosts'),
      },
    ]
  }
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    const hostManifestBase = path.join(getBrowserPilotHomeDir(), 'native-hosts')
    return [
      {
        name: 'Google Chrome',
        userDataDir: path.join(localAppData, 'Google', 'Chrome', 'User Data'),
        dir: path.join(hostManifestBase, 'chrome'),
        registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      },
      {
        name: 'Chromium',
        userDataDir: path.join(localAppData, 'Chromium', 'User Data'),
        dir: path.join(hostManifestBase, 'chromium'),
        registryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      },
      {
        name: 'Brave',
        userDataDir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
        dir: path.join(hostManifestBase, 'brave'),
        registryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      },
      {
        name: 'Microsoft Edge',
        userDataDir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
        dir: path.join(hostManifestBase, 'edge'),
        registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      },
    ]
  }
  return []
}

/**
 * Computes Chromium's exact deterministic 32-char extension ID (a-p alphabet)
 * for an unpacked extension loaded from `unpackedDir`.
 * Matches Chrome's `crx_file::id_util::GenerateIdForPath` on both POSIX (UTF-8)
 * and Windows (UTF-16LE with uppercase drive letter).
 */
export function computeChromeExtensionId(
  unpackedDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let payload: Buffer
  if (platform === 'win32') {
    const resolved = path.win32.resolve(unpackedDir).replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
    const normalized = resolved.length > 3 ? resolved.replace(/\\+$/, '') : resolved
    payload = Buffer.from(normalized, 'utf16le')
  } else {
    const normalized = platform === process.platform ? path.resolve(unpackedDir) : path.posix.resolve(unpackedDir)
    payload = Buffer.from(normalized, 'utf8')
  }
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32)
  return hash.replace(/[0-9a-f]/g, (ch) => String.fromCharCode(97 + Number.parseInt(ch, 16)))
}

export function getStableExtensionDir(): string {
  return path.join(getBrowserPilotHomeDir(), 'extension')
}

export interface SyncExtensionResult {
  extensionDir: string
  extensionId: string
  version: string | null
  synced: boolean
}

/**
 * Copies the bundled Chrome MV3 extension into a stable, upgrade-proof path
 * (`~/.browserpilot/extension`) so Node.js or npm version upgrades never break
 * Chrome's unpacked extension path or change its Extension ID.
 */
export async function syncExtensionToHome(
  sourceExtDir: string,
  options: { dryRun?: boolean } = {},
): Promise<SyncExtensionResult> {
  const destDir = getStableExtensionDir()
  let version: string | null = null
  try {
    const manifestRaw = await fs.readFile(path.join(sourceExtDir, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(manifestRaw) as { version?: string }
    version = manifest.version ?? null
  } catch {}

  let synced = false
  if (!options.dryRun) {
    await ensureBrowserPilotHome()
    const resolvedSrc = await fs.realpath(sourceExtDir).catch(() => path.resolve(sourceExtDir))
    const resolvedDest = await fs.realpath(destDir).catch(() => path.resolve(destDir))
    if (resolvedSrc !== resolvedDest) {
      await fs.rm(destDir, { recursive: true, force: true })
      await fs.cp(sourceExtDir, destDir, { recursive: true })
      synced = true
    }
  }

  const realDest = await fs.realpath(destDir).catch(() => path.resolve(destDir))
  return {
    extensionDir: realDest,
    extensionId: computeChromeExtensionId(realDest),
    version,
    synced,
  }
}

export interface DiscoveredExtension {
  browser: string
  profile: string
  extensionId: string
  path?: string
}

/**
 * Scans installed Chromium browsers' Preferences / Secure Preferences files to
 * auto-discover any already-loaded BrowserPilot unpacked extension IDs.
 */
export async function discoverInstalledExtensionIds(
  platform: NodeJS.Platform = process.platform,
): Promise<DiscoveredExtension[]> {
  const found: DiscoveredExtension[] = []
  const seen = new Set<string>()

  for (const target of getNativeMessagingHostDirs(platform)) {
    let entries: string[]
    try {
      entries = await fs.readdir(target.userDataDir)
    } catch {
      continue
    }

    const profiles = entries.filter((e) => e === 'Default' || e.startsWith('Profile '))
    for (const profile of profiles) {
      for (const fileName of ['Secure Preferences', 'Preferences']) {
        const prefPath = path.join(target.userDataDir, profile, fileName)
        let parsed: {
          extensions?: {
            settings?: Record<string, { location?: number; path?: string; manifest?: { name?: string } }>
          }
        }
        try {
          parsed = JSON.parse(await fs.readFile(prefPath, 'utf8'))
        } catch {
          continue
        }
        const settings = parsed.extensions?.settings
        if (!settings || typeof settings !== 'object') continue

        for (const [extId, meta] of Object.entries(settings)) {
          if (!meta || !/^[a-p]{32}$/.test(extId)) continue
          const manifestName = meta.manifest?.name || ''
          const extPath = meta.path || ''
          let isBrowserPilot = /^browserpilot$/i.test(manifestName) || /browserpilot/i.test(extPath)

          if (!isBrowserPilot && meta.location === 4 && extPath) {
            try {
              const m = JSON.parse(await fs.readFile(path.join(extPath, 'manifest.json'), 'utf8')) as { name?: string }
              if (/^browserpilot$/i.test(m.name || '')) isBrowserPilot = true
            } catch {}
          }

          if (isBrowserPilot && !seen.has(extId)) {
            seen.add(extId)
            found.push({ browser: target.name, profile, extensionId: extId, path: extPath || undefined })
          }
        }
      }
    }
  }

  return found
}

export interface InstalledNativeHostInfo {
  browser: string
  installed: boolean
  path: string
  allowedOrigins: string[]
  wrapperPath?: string
}

export async function readInstalledNativeHosts(
  platform: NodeJS.Platform = process.platform,
): Promise<InstalledNativeHostInfo[]> {
  const results: InstalledNativeHostInfo[] = []
  for (const target of getNativeMessagingHostDirs(platform)) {
    const mp = path.join(target.dir, `${NATIVE_HOST_NAME}.json`)
    try {
      const parsed = JSON.parse(await fs.readFile(mp, 'utf8')) as {
        allowed_origins?: string[]
        path?: string
      }
      results.push({
        browser: target.name,
        installed: true,
        path: mp,
        allowedOrigins: Array.isArray(parsed.allowed_origins) ? parsed.allowed_origins : [],
        wrapperPath: parsed.path,
      })
    } catch {
      results.push({ browser: target.name, installed: false, path: mp, allowedOrigins: [] })
    }
  }
  return results
}

export interface InstallNativeHostOptions {
  extensionIds: string[]
  dryRun?: boolean
  platform?: NodeJS.Platform
}

export interface InstallNativeHostResult {
  wrapperPath: string
  installedManifests: Array<{ browser: string; manifestPath: string; registryKey?: string }>
  manifestJson: Record<string, unknown>
}

/**
 * Installs Chrome Native Messaging host wrapper & JSON manifests (plus HKCU registry keys on Windows)
 * so the BrowserPilot extension connects automatically via chrome.runtime.connectNative() with zero
 * exposed port and automatic auth token injection.
 */
export async function installNativeHost(options: InstallNativeHostOptions): Promise<InstallNativeHostResult> {
  const platform = options.platform ?? process.platform
  const isWin = platform === 'win32'
  const nativeHostJs = path.resolve(__dirname, 'native-host.js')
  const binDir = path.join(getBrowserPilotHomeDir(), 'bin')
  const wrapperPath = path.join(binDir, isWin ? 'browserpilot-native-host.cmd' : 'browserpilot-native-host')

  const allowedOrigins = Array.from(
    new Set(
      options.extensionIds
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) =>
          id.startsWith('chrome-extension://') ? (id.endsWith('/') ? id : `${id}/`) : `chrome-extension://${id}/`,
        ),
    ),
  )

  const manifestJson = {
    name: NATIVE_HOST_NAME,
    description: 'BrowserPilot Zero-Click Browser Control & DevTools Bridge',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  }

  const wrapperScript = isWin
    ? `@echo off\r\n"${process.execPath}" "${nativeHostJs}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(nativeHostJs)} "$@"\n`

  const targets = getNativeMessagingHostDirs(platform)
  const installedManifests: Array<{ browser: string; manifestPath: string; registryKey?: string }> = []

  if (!options.dryRun) {
    await ensureBrowserPilotHome()
    await fs.mkdir(binDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 })

    for (const target of targets) {
      let exists = target.name === 'Google Chrome'
      if (!exists) {
        try {
          await fs.access(isWin ? target.userDataDir : path.dirname(target.dir))
          exists = true
        } catch {
          exists = false
        }
      }
      if (!exists) continue
      await fs.mkdir(target.dir, { recursive: true })
      const manifestPath = path.join(target.dir, `${NATIVE_HOST_NAME}.json`)
      await fs.writeFile(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n', 'utf8')
      if (isWin && target.registryKey) {
        await execFileAsync('reg', ['add', target.registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']).catch(
          () => {},
        )
      }
      installedManifests.push({ browser: target.name, manifestPath, registryKey: target.registryKey })
    }
  } else {
    for (const target of targets) {
      installedManifests.push({
        browser: target.name,
        manifestPath: path.join(target.dir, `${NATIVE_HOST_NAME}.json`),
        registryKey: target.registryKey,
      })
    }
  }

  return { wrapperPath, installedManifests, manifestJson }
}
