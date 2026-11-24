import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DownloadEntry } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

function sanitizeFilename(name: string): string {
  const base = path.basename(name || 'download.bin').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  return base || 'download.bin'
}

async function resolveUniquePath(dir: string, filename: string): Promise<string> {
  const safe = sanitizeFilename(filename)
  const ext = path.extname(safe)
  const stem = ext ? safe.slice(0, -ext.length) : safe
  let candidate = path.join(dir, safe)
  for (let i = 1; i <= 200; i++) {
    try {
      await fs.access(candidate)
      candidate = path.join(dir, `${stem}-${i}${ext}`)
    } catch {
      return candidate
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`)
}

export interface WaitForDownloadOptions {
  timeoutMs?: number
  filenamePattern?: string | RegExp
  sinceTimestamp?: number
}

/**
 * Tracks browser file downloads seamlessly across both Direct CDP
 * (Browser.setDownloadBehavior + Browser.downloadWillBegin/Progress)
 * and Chrome Extension mode (chrome.downloads events).
 */
export class DownloadManager {
  private readonly session: TabCDPSession
  private entries = new Map<string, DownloadEntry>()
  private emitter = new EventEmitter()
  private downloadDir: string | null = null
  private configured = false
  private unsubs: Array<() => void> = []

  constructor(session: TabCDPSession) {
    this.session = session
    this.emitter.setMaxListeners(50)

    const onBegin = (params: Record<string, unknown>) => {
      const id = String(params.guid ?? `dl_${Date.now()}`)
      const entry: DownloadEntry = {
        id,
        url: String(params.url ?? ''),
        suggestedFilename: sanitizeFilename(String(params.suggestedFilename ?? 'download.bin')),
        state: 'in_progress',
        receivedBytes: 0,
        startedAt: Date.now(),
      }
      this.entries.set(id, entry)
      this.emitter.emit('update', entry)
    }

    const onProgress = (params: Record<string, unknown>) => {
      const id = String(params.guid ?? '')
      const entry = this.entries.get(id)
      if (!entry) return
      if (typeof params.receivedBytes === 'number') entry.receivedBytes = params.receivedBytes
      if (typeof params.totalBytes === 'number' && params.totalBytes > 0) entry.totalBytes = params.totalBytes
      const rawState = String(params.state ?? '')
      if (rawState === 'completed') {
        void this.finalizeDirectDownload(entry)
      } else if (rawState === 'canceled') {
        entry.state = 'canceled'
        entry.completedAt = Date.now()
        this.emitter.emit('update', entry)
      }
    }

    this.unsubs.push(
      session.on('Browser.downloadWillBegin', onBegin),
      session.on('Page.downloadWillBegin', onBegin),
      session.on('Browser.downloadProgress', onProgress),
      session.on('Page.downloadProgress', onProgress),
    )

    if (session.transport.onDownloadEvent) {
      this.unsubs.push(
        session.transport.onDownloadEvent((entry) => {
          this.entries.set(entry.id, entry)
          this.emitter.emit('update', entry)
        }),
      )
    }
  }

  private async finalizeDirectDownload(entry: DownloadEntry): Promise<void> {
    if (this.downloadDir) {
      const guidPath = path.join(this.downloadDir, entry.id)
      const directNamedPath = path.join(this.downloadDir, entry.suggestedFilename)
      try {
        await fs.access(guidPath)
        const targetPath = await resolveUniquePath(this.downloadDir, entry.suggestedFilename)
        await fs.rename(guidPath, targetPath)
        entry.filePath = targetPath
      } catch {
        try {
          await fs.access(directNamedPath)
          entry.filePath = directNamedPath
        } catch {
          // leave filePath undefined if browser saved elsewhere
        }
      }
    }
    entry.state = 'completed'
    entry.completedAt = Date.now()
    this.emitter.emit('update', entry)
  }

  async configure(downloadDir?: string): Promise<{ downloadDir: string | null; mode: 'direct-cdp' | 'extension' }> {
    if (this.session.transport.mode === 'extension') {
      this.configured = true
      return { downloadDir: null, mode: 'extension' }
    }

    const dir = path.resolve(downloadDir ?? path.join(os.tmpdir(), 'browserpilot-downloads'))
    await fs.mkdir(dir, { recursive: true })
    this.downloadDir = dir

    if (this.session.transport.sendBrowser) {
      await this.session.transport.sendBrowser('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: dir,
        eventsEnabled: true,
      })
    } else {
      await this.session.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: dir,
      })
    }
    this.configured = true
    return { downloadDir: dir, mode: 'direct-cdp' }
  }

  async ensureConfigured(): Promise<void> {
    if (!this.configured) {
      await this.configure()
    }
  }

  async list(): Promise<DownloadEntry[]> {
    if (this.session.transport.mode === 'extension' && this.session.transport.listDownloads) {
      const remote = await this.session.transport.listDownloads().catch(() => [])
      for (const item of remote) {
        this.entries.set(item.id, item)
      }
    }
    return Array.from(this.entries.values()).sort((a, b) => a.startedAt - b.startedAt)
  }

  async waitForDownload(options: WaitForDownloadOptions = {}): Promise<DownloadEntry> {
    await this.ensureConfigured()
    const timeoutMs = options.timeoutMs ?? 20_000
    const sinceTs = options.sinceTimestamp ?? 0
    const regex =
      options.filenamePattern instanceof RegExp
        ? options.filenamePattern
        : typeof options.filenamePattern === 'string'
          ? new RegExp(options.filenamePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
          : null

    const matches = (e: DownloadEntry) =>
      e.state === 'completed' &&
      (e.completedAt ?? e.startedAt) >= sinceTs &&
      (!regex || regex.test(e.suggestedFilename) || (e.filePath ? regex.test(e.filePath) : false))

    // Check already-completed matching downloads first
    const existing = Array.from(this.entries.values()).reverse().find(matches)
    if (existing) return existing

    return await new Promise<DownloadEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off('update', onUpdate)
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for download to complete`))
      }, timeoutMs)

      const onUpdate = (entry: DownloadEntry) => {
        if (matches(entry)) {
          clearTimeout(timer)
          this.emitter.off('update', onUpdate)
          resolve(entry)
        } else if (entry.state === 'canceled' && entry.startedAt >= sinceTs && (!regex || regex.test(entry.suggestedFilename))) {
          clearTimeout(timer)
          this.emitter.off('update', onUpdate)
          reject(new Error(`Download canceled: ${entry.suggestedFilename}`))
        }
      }

      this.emitter.on('update', onUpdate)
    })
  }

  clear(): void {
    this.entries.clear()
  }

  dispose(): void {
    for (const off of this.unsubs) off()
    this.unsubs = []
    this.emitter.removeAllListeners()
  }
}
