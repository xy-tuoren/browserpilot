import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_HOST_NAME } from '@browserpilot/protocol'
import { ensureBrowserPilotHome, getBrowserPilotHomeDir } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface BrowserHostTarget {
  name: string
  dir: string
}

export function getNativeMessagingHostDirs(platform: NodeJS.Platform = process.platform): BrowserHostTarget[] {
  const home = os.homedir()
  if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support')
    return [
      { name: 'Google Chrome', dir: path.join(appSupport, 'Google', 'Chrome', 'NativeMessagingHosts') },
      { name: 'Google Chrome Canary', dir: path.join(appSupport, 'Google', 'Chrome Canary', 'NativeMessagingHosts') },
      { name: 'Google Chrome for Testing', dir: path.join(appSupport, 'Google', 'Chrome for Testing', 'NativeMessagingHosts') },
      { name: 'Chromium', dir: path.join(appSupport, 'Chromium', 'NativeMessagingHosts') },
      { name: 'Brave', dir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
      { name: 'Microsoft Edge', dir: path.join(appSupport, 'Microsoft Edge', 'NativeMessagingHosts') },
      { name: 'Arc', dir: path.join(appSupport, 'Arc', 'User Data', 'NativeMessagingHosts') },
    ]
  }
  if (platform === 'linux') {
    const config = path.join(home, '.config')
    return [
      { name: 'Google Chrome', dir: path.join(config, 'google-chrome', 'NativeMessagingHosts') },
      { name: 'Chromium', dir: path.join(config, 'chromium', 'NativeMessagingHosts') },
      { name: 'Brave', dir: path.join(config, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
      { name: 'Microsoft Edge', dir: path.join(config, 'microsoft-edge', 'NativeMessagingHosts') },
    ]
  }
  return []
}

export interface InstallNativeHostOptions {
  extensionIds: string[]
  dryRun?: boolean
}

export interface InstallNativeHostResult {
  wrapperPath: string
  installedManifests: Array<{ browser: string; manifestPath: string }>
  manifestJson: Record<string, unknown>
}

/**
 * Installs Chrome Native Messaging host wrapper & JSON manifests so the BrowserPilot
 * extension connects automatically via chrome.runtime.connectNative() with zero
 * exposed port and automatic auth token injection.
 */
export async function installNativeHost(options: InstallNativeHostOptions): Promise<InstallNativeHostResult> {
  const nativeHostJs = path.resolve(__dirname, 'native-host.js')
  const binDir = path.join(getBrowserPilotHomeDir(), 'bin')
  const wrapperPath = path.join(binDir, 'browserpilot-native-host')

  const allowedOrigins = options.extensionIds
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => (id.startsWith('chrome-extension://') ? id : `chrome-extension://${id}/`))

  const manifestJson = {
    name: NATIVE_HOST_NAME,
    description: 'BrowserPilot Zero-Click Browser Control & DevTools Bridge',
    path: wrapperPath,
    type: 'stdio',
    allowed_origins: allowedOrigins,
  }

  const wrapperScript = `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(nativeHostJs)} "$@"\n`

  const targets = getNativeMessagingHostDirs()
  const installedManifests: Array<{ browser: string; manifestPath: string }> = []

  if (!options.dryRun) {
    await ensureBrowserPilotHome()
    await fs.mkdir(binDir, { recursive: true, mode: 0o700 })
    await fs.writeFile(wrapperPath, wrapperScript, { mode: 0o755 })

    for (const target of targets) {
      // Install if parent browser data dir exists (or always for Google Chrome)
      const parentDir = path.dirname(target.dir)
      let exists = target.name === 'Google Chrome'
      if (!exists) {
        try {
          await fs.access(parentDir)
          exists = true
        } catch {
          exists = false
        }
      }
      if (!exists) continue
      await fs.mkdir(target.dir, { recursive: true })
      const manifestPath = path.join(target.dir, `${NATIVE_HOST_NAME}.json`)
      await fs.writeFile(manifestPath, JSON.stringify(manifestJson, null, 2) + '\n', 'utf8')
      installedManifests.push({ browser: target.name, manifestPath })
    }
  } else {
    for (const target of targets) {
      installedManifests.push({
        browser: target.name,
        manifestPath: path.join(target.dir, `${NATIVE_HOST_NAME}.json`),
      })
    }
  }

  return { wrapperPath, installedManifests, manifestJson }
}
