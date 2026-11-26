import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TabCDPSession } from './cdp-client.js'

export interface GifRgbaFrame {
  width: number
  height: number
  /** RGBA byte array of length width * height * 4 */
  rgba: Uint8Array
  /** Frame delay in milliseconds (default 900ms) */
  delayMs?: number
}

export interface GifEncodeOptions {
  /** Loop count (0 = infinite loop, default 0) */
  loop?: number
  /** Default delay per frame in milliseconds (default 900) */
  delayMs?: number
}

/**
 * Builds a deterministic 256-color global palette:
 * - Indices 0..215: 6x6x6 uniform RGB color cube (0, 51, 102, 153, 204, 255)
 * - Indices 216..255: 40-step grayscale ramp for sharp UI text, borders, and dark/light cards
 */
function buildGlobalPalette(): { table: Uint8Array; mapRgb: (r: number, g: number, b: number) => number } {
  const table = new Uint8Array(256 * 3)
  let idx = 0
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        table[idx * 3] = r * 51
        table[idx * 3 + 1] = g * 51
        table[idx * 3 + 2] = b * 51
        idx++
      }
    }
  }
  for (let i = 0; i < 40; i++) {
    const gray = Math.round(((i + 1) / 41) * 255)
    table[(216 + i) * 3] = gray
    table[(216 + i) * 3 + 1] = gray
    table[(216 + i) * 3 + 2] = gray
  }

  const mapRgb = (r: number, g: number, b: number): number => {
    const maxCh = Math.max(r, g, b)
    const minCh = Math.min(r, g, b)
    // Near-grayscale pixels map onto the high-resolution 40-step gray ramp
    if (maxCh - minCh <= 12) {
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
      if (lum <= 6) return 0
      if (lum >= 249) return 215
      const gIdx = Math.max(0, Math.min(39, Math.round((lum / 255) * 41) - 1))
      return 216 + gIdx
    }
    const ri = Math.round((r * 5) / 255)
    const gi = Math.round((g * 5) / 255)
    const bi = Math.round((b * 5) / 255)
    return ri * 36 + gi * 6 + bi
  }

  return { table, mapRgb }
}

function lzwEncodeIndices(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  const outBytes: number[] = []
  let bitBuf = 0
  let bitCount = 0

  const emitCode = (code: number, codeSize: number) => {
    bitBuf |= code << bitCount
    bitCount += codeSize
    while (bitCount >= 8) {
      outBytes.push(bitBuf & 0xff)
      bitBuf >>= 8
      bitCount -= 8
    }
  }

  let codeSize = minCodeSize + 1
  let nextCode = eoiCode + 1
  let dict = new Map<number, number>()

  emitCode(clearCode, codeSize)
  if (indices.length > 0) {
    let prefix = indices[0]
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i]
      const key = (prefix << 8) | k
      const found = dict.get(key)
      if (found !== undefined) {
        prefix = found
      } else {
        emitCode(prefix, codeSize)
        if (nextCode < 4096) {
          dict.set(key, nextCode++)
          if (nextCode > 1 << codeSize && codeSize < 12) {
            codeSize++
          }
        } else {
          emitCode(clearCode, codeSize)
          dict = new Map<number, number>()
          codeSize = minCodeSize + 1
          nextCode = eoiCode + 1
        }
        prefix = k
      }
    }
    emitCode(prefix, codeSize)
  }
  emitCode(eoiCode, codeSize)
  if (bitCount > 0) {
    outBytes.push(bitBuf & 0xff)
  }

  // Pack into GIF sub-blocks (max 255 bytes each) + 0x00 block terminator
  const blocks: number[] = [minCodeSize]
  for (let i = 0; i < outBytes.length; i += 255) {
    const chunkLen = Math.min(255, outBytes.length - i)
    blocks.push(chunkLen)
    for (let j = 0; j < chunkLen; j++) {
      blocks.push(outBytes[i + j])
    }
  }
  blocks.push(0x00)
  return Uint8Array.from(blocks)
}

/**
 * Pure-TypeScript zero-dependency GIF89a animated GIF encoder.
 * Works everywhere (even without ffmpeg installed).
 */
export function encodeAnimatedGif(frames: GifRgbaFrame[], options: GifEncodeOptions = {}): Buffer {
  if (!frames.length) {
    throw new Error('Cannot encode GIF with zero frames')
  }
  const width = frames[0].width
  const height = frames[0].height
  const loop = options.loop ?? 0
  const defaultDelay = options.delayMs ?? 900
  const { table, mapRgb } = buildGlobalPalette()

  const parts: Buffer[] = []

  // Header + Logical Screen Descriptor (256-color Global Color Table, bit 7=1, size=7)
  const header = Buffer.alloc(13)
  header.write('GIF89a', 0, 'ascii')
  header.writeUInt16LE(width, 6)
  header.writeUInt16LE(height, 8)
  header[10] = 0xf7 // GCT flag=1, color res=7 (8-bit), sort=0, size=7 (2^(7+1)=256)
  header[11] = 0 // background color index
  header[12] = 0 // pixel aspect ratio
  parts.push(header)
  parts.push(Buffer.from(table))

  // NETSCAPE2.0 Application Extension for looping animation
  if (frames.length > 1) {
    const netscape = Buffer.from([
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01,
      loop & 0xff,
      (loop >> 8) & 0xff,
      0x00,
    ])
    parts.push(netscape)
  }

  for (const frame of frames) {
    const delayCs = Math.max(2, Math.round((frame.delayMs ?? defaultDelay) / 10))
    // Graphic Control Extension
    const gce = Buffer.from([
      0x21, 0xf9, 0x04,
      0x04, // dispose=1 (do not dispose), no transparency
      delayCs & 0xff,
      (delayCs >> 8) & 0xff,
      0x00,
      0x00,
    ])
    parts.push(gce)

    // Image Descriptor
    const imgDesc = Buffer.alloc(10)
    imgDesc[0] = 0x2c
    imgDesc.writeUInt16LE(0, 1)
    imgDesc.writeUInt16LE(0, 3)
    imgDesc.writeUInt16LE(width, 5)
    imgDesc.writeUInt16LE(height, 7)
    imgDesc[9] = 0x00 // no local color table, not interlaced
    parts.push(imgDesc)

    const pixelCount = width * height
    const indices = new Uint8Array(pixelCount)
    const rgba = frame.rgba
    for (let i = 0; i < pixelCount; i++) {
      const off = i * 4
      indices[i] = mapRgb(rgba[off] ?? 0, rgba[off + 1] ?? 0, rgba[off + 2] ?? 0)
    }
    parts.push(Buffer.from(lzwEncodeIndices(indices, 8)))
  }

  parts.push(Buffer.from([0x3b])) // GIF Trailer
  return Buffer.concat(parts)
}

export interface GifStepFrame {
  index: number
  timestamp: number
  label: string
  pngBase64: string
  point?: { x: number; y: number }
  viewport?: { width: number; height: number }
}

export interface GifExportOptions {
  outputPath?: string
  /** Target GIF width in pixels (default 800) */
  width?: number
  /** Delay between frames in ms (default 900) */
  delayMs?: number
  /** Draw click indicator ring at action point (default true) */
  showClickIndicators?: boolean
  /** Draw bottom action caption badge (default true) */
  showActionLabels?: boolean
  /** Draw top progress bar across steps (default true) */
  showProgressBar?: boolean
  /** Loop count (0 = infinite, default 0) */
  loop?: number
}

export interface GifExportResult {
  path: string
  frameCount: number
  sizeBytes: number
  width: number
  height: number
  encoder: 'ffmpeg' | 'builtin-gif89a'
}

async function runFfmpegCmd(args: string[]): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] })
    proc.once('error', () => resolve(false))
    proc.once('close', (code) => resolve(code === 0))
  })
}

/**
 * Interactive Step-Frame Animated GIF Creator (matching & exceeding Claude's gif_creator).
 * Automatically captures crisp keyframes on browser actions with optional click ripples,
 * bilingual action caption pills, and a step progress bar, exporting via 2-pass ffmpeg
 * palettegen OR zero-dependency built-in GIF89a LZW encoding.
 */
export class GifRecorder {
  private readonly session: TabCDPSession
  private recording = false
  private frames: GifStepFrame[] = []
  private maxFrames = 80
  private startedAt = 0

  constructor(session: TabCDPSession) {
    this.session = session
  }

  isRecording(): boolean {
    return this.recording
  }

  getStatus(): { recording: boolean; frameCount: number; startedAt: number; labels: string[] } {
    return {
      recording: this.recording,
      frameCount: this.frames.length,
      startedAt: this.startedAt,
      labels: this.frames.map((f) => f.label),
    }
  }

  async start(options: { clearExisting?: boolean; maxFrames?: number; captureInitial?: boolean } = {}): Promise<{
    recording: boolean
    frameCount: number
  }> {
    if (options.clearExisting !== false) {
      this.frames = []
    }
    this.maxFrames = Math.max(5, Math.min(200, options.maxFrames ?? 80))
    this.recording = true
    this.startedAt = Date.now()
    if (options.captureInitial !== false) {
      await this.captureFrame('Initial state').catch(() => {})
    }
    return { recording: true, frameCount: this.frames.length }
  }

  stop(): { recording: boolean; frameCount: number } {
    this.recording = false
    return { recording: false, frameCount: this.frames.length }
  }

  clear(): void {
    this.recording = false
    this.frames = []
    this.startedAt = 0
  }

  async captureFrame(label = 'Step', point?: { x: number; y: number }): Promise<GifStepFrame | null> {
    if (this.frames.length >= this.maxFrames) return null
    try {
      const [metrics, shot] = await Promise.all([
        this.session
          .send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics')
          .catch(() => null),
        this.session.send<{ data?: string }>('Page.captureScreenshot', { format: 'png' }),
      ])
      if (!shot?.data) return null
      const vp = metrics?.cssVisualViewport
      const frame: GifStepFrame = {
        index: this.frames.length + 1,
        timestamp: Date.now(),
        label: label.slice(0, 80),
        pngBase64: shot.data,
        ...(point ? { point } : {}),
        viewport: vp ? { width: vp.clientWidth, height: vp.clientHeight } : undefined,
      }
      this.frames.push(frame)
      return frame
    } catch {
      return null
    }
  }

  private async compositeFrameInBrowser(
    frame: GifStepFrame,
    totalFrames: number,
    opts: {
      targetWidth: number
      showClickIndicators: boolean
      showActionLabels: boolean
      showProgressBar: boolean
      needRgba: boolean
    },
  ): Promise<{ width: number; height: number; pngBase64: string; rgbaBase64?: string } | null> {
    const res = await this.session
      .send<{
        result?: { value?: { width: number; height: number; pngBase64: string; rgbaBase64?: string } | null }
      }>('Runtime.evaluate', {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          try {
            const img = new Image();
            img.src = 'data:image/png;base64,' + ${JSON.stringify(frame.pngBase64)};
            await img.decode();
            const scale = Math.min(1, ${opts.targetWidth} / Math.max(1, img.width));
            const w = Math.max(2, Math.round(img.width * scale));
            const h = Math.max(2, Math.round(img.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(img, 0, 0, w, h);

            // 1. Click reticle / ripple indicator
            const pt = ${JSON.stringify(frame.point ?? null)};
            const vp = ${JSON.stringify(frame.viewport ?? null)};
            if (${opts.showClickIndicators} && pt) {
              const sx = vp && vp.width > 0 ? w / vp.width : scale;
              const sy = vp && vp.height > 0 ? h / vp.height : scale;
              const px = pt.x * sx;
              const py = pt.y * sy;
              ctx.save();
              ctx.beginPath();
              ctx.arc(px, py, 18, 0, Math.PI * 2);
              ctx.fillStyle = 'rgba(244, 63, 94, 0.24)';
              ctx.fill();
              ctx.lineWidth = 3;
              ctx.strokeStyle = '#f43f5e';
              ctx.stroke();
              ctx.beginPath();
              ctx.arc(px, py, 5, 0, Math.PI * 2);
              ctx.fillStyle = '#fb7185';
              ctx.fill();
              ctx.restore();
            }

            // 2. Top step progress bar
            if (${opts.showProgressBar} && ${totalFrames} > 0) {
              const pct = ${frame.index} / ${totalFrames};
              ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
              ctx.fillRect(0, 0, w, 4);
              ctx.fillStyle = '#06b6d4';
              ctx.fillRect(0, 0, Math.round(w * pct), 4);
            }

            // 3. Bottom action caption badge
            const caption = ${JSON.stringify(`${frame.index}/${totalFrames}  ${frame.label}`)};
            if (${opts.showActionLabels} && caption) {
              ctx.save();
              ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif';
              const metrics = ctx.measureText(caption);
              const padX = 12;
              const boxW = Math.min(w - 24, Math.ceil(metrics.width) + padX * 2);
              const boxH = 26;
              const bx = 12;
              const by = h - boxH - 12;
              ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
              ctx.beginPath();
              if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 7);
              else ctx.rect(bx, by, boxW, boxH);
              ctx.fill();
              ctx.fillStyle = '#f8fafc';
              ctx.textBaseline = 'middle';
              ctx.fillText(caption, bx + padX, by + boxH / 2, boxW - padX * 2);
              ctx.restore();
            }

            const pngBase64 = canvas.toDataURL('image/png').split(',')[1] || '';
            let rgbaBase64;
            if (${opts.needRgba}) {
              const raw = ctx.getImageData(0, 0, w, h).data;
              let bin = '';
              const chunk = 0x8000;
              for (let i = 0; i < raw.length; i += chunk) {
                bin += String.fromCharCode.apply(null, raw.subarray(i, i + chunk));
              }
              rgbaBase64 = btoa(bin);
            }
            return { width: w, height: h, pngBase64, rgbaBase64 };
          } catch {
            return null;
          }
        })()`,
      })
      .catch(() => null)
    return res?.result?.value ?? null
  }

  async export(options: GifExportOptions = {}): Promise<GifExportResult> {
    this.recording = false
    if (this.frames.length === 0) {
      await this.captureFrame('Snapshot').catch(() => {})
    }
    if (this.frames.length === 0) {
      throw new Error('No GIF frames captured. Call start() or captureFrame() before export().')
    }

    const outputPath = path.resolve(options.outputPath ?? `./browserpilot-${Date.now()}.gif`)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })

    const targetWidth = Math.max(160, Math.min(1600, options.width ?? 800))
    const delayMs = Math.max(80, Math.min(5000, options.delayMs ?? 900))
    const showClickIndicators = options.showClickIndicators !== false
    const showActionLabels = options.showActionLabels !== false
    const showProgressBar = options.showProgressBar !== false
    const loop = options.loop ?? 0

    // Try ffmpeg first (2-pass palettegen+paletteuse); composite overlays via Chromium Canvas
    const hasFfmpeg = await runFfmpegCmd(['-version'])
    const composited: Array<{ width: number; height: number; pngBase64: string; rgbaBase64?: string }> = []

    for (const f of this.frames) {
      const comp = await this.compositeFrameInBrowser(f, this.frames.length, {
        targetWidth,
        showClickIndicators,
        showActionLabels,
        showProgressBar,
        needRgba: !hasFfmpeg,
      })
      if (comp) {
        composited.push(comp)
      } else {
        // Strict CSP fallback: keep raw PNG for ffmpeg
        const head = Buffer.from(f.pngBase64.slice(0, 48), 'base64')
        const w = head.length >= 24 ? head.readUInt32BE(16) : targetWidth
        const h = head.length >= 24 ? head.readUInt32BE(20) : Math.round((targetWidth * 9) / 16)
        composited.push({ width: w, height: h, pngBase64: f.pngBase64 })
      }
    }

    if (hasFfmpeg) {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bp-gif-'))
      try {
        for (let i = 0; i < composited.length; i++) {
          const fname = path.join(tmpDir, `frame_${String(i).padStart(4, '0')}.png`)
          await fs.writeFile(fname, Buffer.from(composited[i].pngBase64, 'base64'))
        }
        const fps = Number((1000 / delayMs).toFixed(3))
        const inputPattern = path.join(tmpDir, 'frame_%04d.png')
        const ok = await runFfmpegCmd([
          '-y',
          '-framerate',
          String(fps),
          '-i',
          inputPattern,
          '-filter_complex',
          `scale=${targetWidth}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4`,
          '-loop',
          String(loop),
          outputPath,
        ])
        if (ok) {
          const stat = await fs.stat(outputPath)
          return {
            path: outputPath,
            frameCount: composited.length,
            sizeBytes: stat.size,
            width: composited[0].width,
            height: composited[0].height,
            encoder: 'ffmpeg',
          }
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      }
    }

    // Pure-TypeScript zero-dependency GIF89a LZW encoder path (works even without ffmpeg!)
    const rgbaFrames: GifRgbaFrame[] = []
    for (let i = 0; i < composited.length; i++) {
      let item = composited[i]
      if (!item.rgbaBase64) {
        const retry = await this.compositeFrameInBrowser(this.frames[i], this.frames.length, {
          targetWidth,
          showClickIndicators,
          showActionLabels,
          showProgressBar,
          needRgba: true,
        })
        if (retry) item = retry
      }
      if (item.rgbaBase64) {
        rgbaFrames.push({
          width: item.width,
          height: item.height,
          rgba: new Uint8Array(Buffer.from(item.rgbaBase64, 'base64')),
          delayMs,
        })
      }
    }
    if (!rgbaFrames.length) {
      throw new Error('Unable to encode GIF frames (install ffmpeg or allow canvas decoding on this page)')
    }
    const gifBuf = encodeAnimatedGif(rgbaFrames, { loop, delayMs })
    await fs.writeFile(outputPath, gifBuf)
    return {
      path: outputPath,
      frameCount: rgbaFrames.length,
      sizeBytes: gifBuf.byteLength,
      width: rgbaFrames[0].width,
      height: rgbaFrames[0].height,
      encoder: 'builtin-gif89a',
    }
  }
}
