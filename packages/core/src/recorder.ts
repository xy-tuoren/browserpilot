import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RecordingOptions, RecordingResult } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

const AUDIO_BINDING_NAME = '__browserpilotAudioChunk'

const AUDIO_TAP_SCRIPT = `(() => {
  if (globalThis.__bpAudioTapActive) return;
  globalThis.__bpAudioTapActive = true;
  try {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx || typeof MediaRecorder === 'undefined') return;
    const mixCtx = new AudioCtx();
    const dest = mixCtx.createMediaStreamDestination();
    const connected = new WeakSet();

    function tapMediaEl(el) {
      if (connected.has(el)) return;
      try {
        const src = mixCtx.createMediaElementSource(el);
        src.connect(dest);
        src.connect(mixCtx.destination);
        connected.add(el);
      } catch {}
    }

    for (const el of document.querySelectorAll('audio, video')) tapMediaEl(el);
    const mo = new MutationObserver(() => {
      for (const el of document.querySelectorAll('audio, video')) tapMediaEl(el);
    });
    if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true });

    // Also patch AudioNode.prototype.connect so Web Audio synthesis graphs feed our tap
    const origConnect = AudioNode.prototype.connect;
    if (!origConnect.__bpPatched) {
      const wrapped = function(...args) {
        const res = origConnect.apply(this, args);
        try {
          if (args[0] && this.context && args[0] === this.context.destination) {
            if (!this.context.__bpTapDest) {
              const d = this.context.createMediaStreamDestination();
              this.context.__bpTapDest = d;
              const subRec = new MediaRecorder(d.stream, { mimeType: 'audio/webm;codecs=opus' });
              subRec.ondataavailable = (ev) => {
                if (ev.data && ev.data.size > 0 && typeof globalThis.${AUDIO_BINDING_NAME} === 'function') {
                  const reader = new FileReader();
                  reader.onloadend = () => {
                    const b64 = String(reader.result || '').split(',')[1] || '';
                    if (b64) globalThis.${AUDIO_BINDING_NAME}(b64);
                  };
                  reader.readAsDataURL(ev.data);
                }
              };
              subRec.start(250);
              globalThis.__bpAudioRecorders = globalThis.__bpAudioRecorders || [];
              globalThis.__bpAudioRecorders.push(subRec);
            }
            origConnect.call(this, this.context.__bpTapDest);
          }
        } catch {}
        return res;
      };
      wrapped.__bpPatched = true;
      AudioNode.prototype.connect = wrapped;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(dest.stream, { mimeType });
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0 && typeof globalThis.${AUDIO_BINDING_NAME} === 'function') {
        const reader = new FileReader();
        reader.onloadend = () => {
          const b64 = String(reader.result || '').split(',')[1] || '';
          if (b64) globalThis.${AUDIO_BINDING_NAME}(b64);
        };
        reader.readAsDataURL(ev.data);
      }
    };
    rec.start(250);
    globalThis.__bpAudioRecorders = globalThis.__bpAudioRecorders || [];
    globalThis.__bpAudioRecorders.push(rec);
    globalThis.__bpStopAudioTap = () => {
      globalThis.__bpAudioTapActive = false;
      mo.disconnect();
      for (const r of globalThis.__bpAudioRecorders || []) {
        try { if (r.state !== 'inactive') r.stop(); } catch {}
      }
      globalThis.__bpAudioRecorders = [];
    };
  } catch {}
})()`

interface ActiveRecording {
  outputPath: string
  videoOnlyPath: string
  audioTempPath: string | null
  audioChunks: Buffer[]
  audioEnabled: boolean
  audioScriptId: string | null
  ffmpeg: ChildProcess
  startedAt: number
  frameCount: number
  actionTimestamps: number[]
  unsubs: Array<() => void>
  maxTimer: ReturnType<typeof setTimeout> | null
  stderr: string[]
}

/**
 * CDP Screencast video recorder piping JPEG frames directly to ffmpeg,
 * with optional page Web Audio / media element audio tapping.
 * Survives page navigations cleanly and tracks interaction timestamps for smart demo speedup.
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

  async start(options: RecordingOptions): Promise<{ outputPath: string; audio: boolean }> {
    if (this.active) {
      throw new Error('Recording is already active for this tab')
    }

    const outputPath = path.resolve(options.outputPath)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const audioEnabled = Boolean(options.audio)
    const videoOnlyPath = audioEnabled
      ? path.join(os.tmpdir(), `bp-video-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${path.extname(outputPath) || '.mp4'}`)
      : outputPath
    const audioTempPath = audioEnabled
      ? path.join(os.tmpdir(), `bp-audio-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.webm`)
      : null

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
        videoOnlyPath,
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
      videoOnlyPath,
      audioTempPath,
      audioChunks: [],
      audioEnabled,
      audioScriptId: null,
      ffmpeg,
      startedAt: Date.now(),
      frameCount: 0,
      actionTimestamps: [],
      unsubs: [],
      maxTimer: null,
      stderr,
    }

    rec.unsubs.push(
      this.session.on('Page.screencastFrame', (params) => {
        const data = params.data as string | undefined
        const sessionId = params.sessionId as number | undefined
        if (sessionId !== undefined) {
          void this.session.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
        }
        if (data && rec.ffmpeg.stdin && !rec.ffmpeg.stdin.destroyed && !rec.ffmpeg.stdin.writableEnded) {
          rec.frameCount++
          rec.ffmpeg.stdin.write(Buffer.from(data, 'base64'))
        }
      }),
    )

    if (audioEnabled) {
      await this.session.send('Runtime.addBinding', { name: AUDIO_BINDING_NAME }).catch(() => {})
      const added = await this.session
        .send<{ identifier?: string }>('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_TAP_SCRIPT })
        .catch(() => ({ identifier: undefined }))
      rec.audioScriptId = added.identifier ?? null
      await this.session.send('Runtime.evaluate', { expression: AUDIO_TAP_SCRIPT }).catch(() => {})

      rec.unsubs.push(
        this.session.on('Runtime.bindingCalled', (params) => {
          if (params.name === AUDIO_BINDING_NAME && typeof params.payload === 'string' && params.payload) {
            rec.audioChunks.push(Buffer.from(params.payload, 'base64'))
          }
        }),
      )
    }

    if (maxDurationMs > 0) {
      rec.maxTimer = setTimeout(() => {
        void this.stop().catch(() => {})
      }, maxDurationMs)
    }

    this.active = rec

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

    return { outputPath, audio: audioEnabled }
  }

  async stop(): Promise<RecordingResult> {
    if (!this.active) {
      throw new Error('No active recording on this tab')
    }
    const rec = this.active
    this.active = null

    if (rec.maxTimer) clearTimeout(rec.maxTimer)

    if (rec.audioEnabled) {
      await this.session
        .send('Runtime.evaluate', { expression: 'globalThis.__bpStopAudioTap?.()' })
        .catch(() => {})
      if (rec.audioScriptId) {
        await this.session
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: rec.audioScriptId })
          .catch(() => {})
      }
      // Give MediaRecorder a short moment to flush final audio chunk
      await new Promise((r) => setTimeout(r, 180))
    }

    for (const off of rec.unsubs) off()
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

    let hasAudio = false
    if (rec.audioEnabled) {
      if (rec.audioChunks.length > 0 && rec.audioTempPath) {
        try {
          await fs.writeFile(rec.audioTempPath, Buffer.concat(rec.audioChunks))
          const ext = path.extname(rec.outputPath).toLowerCase()
          const audioCodec = ext === '.webm' ? ['-c:a', 'libopus'] : ['-c:a', 'aac', '-b:a', '128k']
          await runFfmpeg([
            '-y',
            '-i',
            rec.videoOnlyPath,
            '-i',
            rec.audioTempPath,
            '-c:v',
            'copy',
            ...audioCodec,
            '-shortest',
            rec.outputPath,
          ])
          hasAudio = true
        } catch {
          // Graceful fallback to video-only if captured audio stream was empty/invalid
          await fs.copyFile(rec.videoOnlyPath, rec.outputPath)
        } finally {
          await fs.rm(rec.videoOnlyPath, { force: true }).catch(() => {})
          await fs.rm(rec.audioTempPath, { force: true }).catch(() => {})
        }
      } else {
        await fs.rename(rec.videoOnlyPath, rec.outputPath).catch(async () => {
          await fs.copyFile(rec.videoOnlyPath, rec.outputPath)
          await fs.rm(rec.videoOnlyPath, { force: true }).catch(() => {})
        })
      }
    }

    const stat = await fs.stat(rec.outputPath)
    return {
      path: rec.outputPath,
      durationMs: Date.now() - rec.startedAt,
      frameCount: rec.frameCount,
      sizeBytes: stat.size,
      actionTimestamps: rec.actionTimestamps,
      hasAudio,
    }
  }

  async cancel(): Promise<void> {
    if (!this.active) return
    const rec = this.active
    this.active = null
    if (rec.maxTimer) clearTimeout(rec.maxTimer)
    for (const off of rec.unsubs) off()
    await this.session.send('Page.stopScreencast').catch(() => {})
    rec.ffmpeg.kill('SIGTERM')
    await fs.rm(rec.outputPath, { force: true }).catch(() => {})
    if (rec.videoOnlyPath !== rec.outputPath) await fs.rm(rec.videoOnlyPath, { force: true }).catch(() => {})
    if (rec.audioTempPath) await fs.rm(rec.audioTempPath, { force: true }).catch(() => {})
  }
}

export interface DemoSegment {
  startSec: number
  endSec: number
  kind: 'active' | 'idle'
}

/**
 * Splits a recording timeline into active (1x normal speed) and idle (fast-forward)
 * segments around recorded action timestamps.
 */
export function computeDemoSegments(
  durationMs: number,
  actionTimestamps: number[],
  options: { paddingMs?: number; minIdleGapMs?: number } = {},
): DemoSegment[] {
  const totalSec = Math.max(0.1, durationMs / 1000)
  const padMs = options.paddingMs ?? 750
  const minIdleGapMs = options.minIdleGapMs ?? 400

  if (!actionTimestamps.length || durationMs <= 0) {
    return [{ startSec: 0, endSec: totalSec, kind: 'idle' }]
  }

  const sorted = [...actionTimestamps]
    .filter((t) => Number.isFinite(t) && t >= 0 && t <= durationMs)
    .sort((a, b) => a - b)

  if (!sorted.length) {
    return [{ startSec: 0, endSec: totalSec, kind: 'idle' }]
  }

  // Build & merge active windows
  const windows: Array<{ start: number; end: number }> = []
  for (const ts of sorted) {
    const start = Math.max(0, ts - padMs)
    const end = Math.min(durationMs, ts + padMs)
    const prev = windows[windows.length - 1]
    if (prev && start <= prev.end + minIdleGapMs) {
      prev.end = Math.max(prev.end, end)
    } else {
      windows.push({ start, end })
    }
  }

  const segments: DemoSegment[] = []
  let cursor = 0
  for (const w of windows) {
    if (w.start > cursor + 50) {
      segments.push({ startSec: cursor / 1000, endSec: w.start / 1000, kind: 'idle' })
    }
    segments.push({ startSec: w.start / 1000, endSec: w.end / 1000, kind: 'active' })
    cursor = w.end
  }
  if (durationMs > cursor + 50) {
    segments.push({ startSec: cursor / 1000, endSec: totalSec, kind: 'idle' })
  }

  return segments.filter((s) => s.endSec - s.startSec >= 0.05)
}

async function probeVideoDurationSec(filePath: string): Promise<number | null> {
  return await new Promise((resolve) => {
    const proc = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let out = ''
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.once('error', () => resolve(null))
    proc.once('close', () => {
      const n = Number.parseFloat(out.trim())
      resolve(Number.isFinite(n) && n > 0 ? n : null)
    })
  })
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const errChunks: string[] = []
    proc.stderr?.on('data', (c: Buffer) => errChunks.push(c.toString('utf8')))
    proc.once('error', reject)
    proc.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg failed (${code}): ${errChunks.join('').slice(-500)}`))
    })
  })
}

/**
 * Creates a polished demo video from a recording:
 * - When `actionTimestamps` are supplied, speeds up ONLY idle gaps (`idleSpeed`, default 6x)
 *   while keeping interaction moments at 1x normal speed.
 * - Otherwise applies uniform `speed` (default 2x).
 */
export async function createDemoVideo(options: {
  recordingPath: string
  outputPath?: string
  speed?: number
  durationMs?: number
  actionTimestamps?: number[]
  paddingMs?: number
}): Promise<string> {
  const input = path.resolve(options.recordingPath)
  const ext = path.extname(input) || '.mp4'
  const output = path.resolve(options.outputPath ?? input.replace(ext, `.demo${ext}`))
  const speed = Math.max(1, options.speed ?? (options.actionTimestamps?.length ? 6 : 2))

  if (options.actionTimestamps && options.actionTimestamps.length > 0) {
    const probedSec = await probeVideoDurationSec(input)
    const durationMs = options.durationMs ?? (probedSec ? Math.round(probedSec * 1000) : 0)
    const segments = computeDemoSegments(durationMs, options.actionTimestamps, {
      paddingMs: options.paddingMs,
    })

    if (segments.length > 1) {
      const filters: string[] = []
      const concatInputs: string[] = []
      segments.forEach((seg, idx) => {
        const factor = seg.kind === 'idle' ? (1 / speed).toFixed(4) : '1.0'
        filters.push(
          `[0:v]trim=start=${seg.startSec.toFixed(3)}:end=${seg.endSec.toFixed(3)},setpts=${factor}*(PTS-STARTPTS)[v${idx}]`,
        )
        concatInputs.push(`[v${idx}]`)
      })
      filters.push(`${concatInputs.join('')}concat=n=${segments.length}:v=1:a=0[vout]`)

      await runFfmpeg([
        '-y',
        '-i',
        input,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[vout]',
        '-c:v',
        ext === '.webm' ? 'libvpx' : 'libx264',
        ...(ext === '.webm' ? ['-b:v', '1M'] : ['-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-movflags', '+faststart']),
        output,
      ])
      return output
    }
  }

  await runFfmpeg(['-y', '-i', input, '-filter:v', `setpts=${(1 / speed).toFixed(4)}*PTS`, '-an', output])
  return output
}
