import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RecordingOptions, RecordingResult } from '@devpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

interface ActiveRecording {
  outputPath: string
  ffmpeg: ChildProcess
  startedAt: number
  frameCount: number
  actionTimestamps: number[]
  unsub: () => void
  maxTimer: ReturnType<typeof setTimeout> | null
  stderr: string[]
}

/**
 * CDP Screencast video recorder piping JPEG frames directly to ffmpeg.
 * Survives page navigations cleanly and tracks interaction timestamps for demo speedup.
 */
export class ScreenRecorder {
  private readonly session: TabCDPSession
  private active: ActiveRecording | null = null

  constructor(session: TabCDPSession) {
    this.session = session
  }

  isRecording(): boolean {
    return this.active !== null
  }

  markAction(): void {
    if (this.active) {
      this.active.actionTimestamps.push(Date.now() - this.active.startedAt)
    }
  }

  async start(options: RecordingOptions): Promise<{ outputPath: string }> {
    if (this.active) {
      throw new Error('Recording is already active for this tab')
    }

    const outputPath = path.resolve(options.outputPath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const frameRate = Math.min(60, Math.max(5, options.frameRate ?? 24))
    const quality = Math.min(100, Math.max(20, options.quality ?? 85))
    const maxWidth = options.maxWidth ?? 1280
    const maxHeight = options.maxHeight ?? 720
    const maxDurationMs = options.maxDurationMs ?? 15 * 60 * 1000

    const ext = path.extname(outputPath).toLowerCase()
    const codecArgs =
      ext === '.webm'
        ? ['-c:v', 'libvpx', '-b:v', '1M']
        : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart']

    const ffmpeg = spawn(
      'ffmpeg',
      [
        '-y',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        '-framerate',
        String(frameRate),
        '-i',
        '-',
        '-vf',
        'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        ...codecArgs,
        outputPath,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )

    const stderr: string[] = []
    ffmpeg.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 30) stderr.push(chunk.toString('utf8'))
    })

    let spawnErr: Error | null = null
    ffmpeg.once('error', (err) => {
      spawnErr = err
    })

    const rec: ActiveRecording = {
      outputPath,
      ffmpeg,
      startedAt: Date.now(),
      frameCount: 0,
      actionTimestamps: [],
      unsub: () => {},
      maxTimer: null,
      stderr,
    }

    rec.unsub = this.session.on('Page.screencastFrame', (params) => {
      const data = params.data as string | undefined
      const sessionId = params.sessionId as number | undefined
      if (sessionId !== undefined) {
        void this.session.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      }
      if (data && rec.ffmpeg.stdin && !rec.ffmpeg.stdin.destroyed && !rec.ffmpeg.stdin.writableEnded) {
        rec.frameCount++
        rec.ffmpeg.stdin.write(Buffer.from(data, 'base64'))
      }
    })

    if (maxDurationMs > 0) {
      rec.maxTimer = setTimeout(() => {
        void this.stop().catch(() => {})
      }, maxDurationMs)
    }

    this.active = rec

    // Ensure at least one initial frame arrives by requesting screencast
    await this.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth,
      maxHeight,
      everyNthFrame: 1,
    })

    if (spawnErr) {
      await this.cancel()
      throw new Error(
        `ffmpeg failed to start (install via "brew install ffmpeg" or "apt install ffmpeg"): ${(spawnErr as Error).message}`,
      )
    }

    return { outputPath }
  }

  async stop(): Promise<RecordingResult> {
    if (!this.active) {
      throw new Error('No active recording on this tab')
    }
    const rec = this.active
    this.active = null

    if (rec.maxTimer) clearTimeout(rec.maxTimer)
    rec.unsub()
    await this.session.send('Page.stopScreencast').catch(() => {})

    // Guarantee at least 1 frame if page was static during recording
    if (rec.frameCount === 0) {
      try {
        const snap = await this.session.send<{ data: string }>('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 80,
        })
        if (snap.data && rec.ffmpeg.stdin && !rec.ffmpeg.stdin.destroyed) {
          rec.ffmpeg.stdin.write(Buffer.from(snap.data, 'base64'))
          rec.frameCount++
        }
      } catch {
        // ignore
      }
    }

    const exitCode = await new Promise<number | null>((resolve) => {
      rec.ffmpeg.once('close', (code) => resolve(code))
      rec.ffmpeg.stdin?.end()
    })

    if (exitCode !== 0 && exitCode !== null) {
      throw new Error(`ffmpeg exited with code ${exitCode}: ${rec.stderr.join('').slice(-500)}`)
    }

    const stat = await fs.stat(rec.outputPath)
    return {
      path: rec.outputPath,
      durationMs: Date.now() - rec.startedAt,
      frameCount: rec.frameCount,
      sizeBytes: stat.size,
      actionTimestamps: rec.actionTimestamps,
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return
    const rec = this.active
    this.active = null
    if (rec.maxTimer) clearTimeout(rec.maxTimer)
    rec.unsub()
    await this.session.send('Page.stopScreencast').catch(() => {})
    rec.ffmpeg.kill('SIGTERM')
    await fs.rm(rec.outputPath, { force: true }).catch(() => {})
  }
}

/**
 * Creates a sped-up demo video from a recording using ffmpeg.
 */
export async function createDemoVideo(options: {
  recordingPath: string
  outputPath?: string
  speed?: number
}): Promise<string> {
  const input = path.resolve(options.recordingPath)
  const ext = path.extname(input) || '.mp4'
  const output = path.resolve(options.outputPath ?? input.replace(ext, `.demo${ext}`))
  const speed = Math.max(1, options.speed ?? 2)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      ['-y', '-i', input, '-filter:v', `setpts=${(1 / speed).toFixed(4)}*PTS`, '-an', output],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    const errChunks: string[] = []
    proc.stderr?.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')))
    proc.once('error', reject)
    proc.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`createDemoVideo ffmpeg failed (${code}): ${errChunks.join('').slice(-400)}`))
    })
  })

  return output
}
