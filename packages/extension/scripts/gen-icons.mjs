import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** Exact SDF of a rounded rectangle centered at (0.5, 0.5). */
function sdRoundedBox(x, y, halfW, halfH, radius) {
  const dx = Math.abs(x - 0.5) - halfW + radius
  const dy = Math.abs(y - 0.5) - halfH + radius
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius
}

/** Exact SDF of a capsule (line segment with rounded caps) from (ax, ay) to (bx, by). */
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax
  const pay = py - ay
  const bax = bx - ax
  const bay = by - ay
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay))
  return Math.hypot(pax - bax * h, pay - bay * h) - r
}

/** Smooth 4-point geometric spark (astroid-like concave star) centered at (cx, cy). */
function sdFourPointSpark(px, py, cx, cy, radius) {
  const x = Math.abs(px - cx) / radius
  const y = Math.abs(py - cy) / radius
  // Concave superellipse p = 0.62 gives a crisp modern AI/pilot 4-point star
  const d = Math.pow(Math.pow(x, 0.62) + Math.pow(y, 0.62), 1 / 0.62) - 1
  return d * radius * 0.55
}

function blendOver(dstR, dstG, dstB, dstA, srcR, srcG, srcB, srcA) {
  const sa = clamp01(srcA)
  const da = clamp01(dstA)
  const outA = sa + da * (1 - sa)
  if (outA <= 1e-6) return [0, 0, 0, 0]
  return [
    (srcR * sa + dstR * da * (1 - sa)) / outA,
    (srcG * sa + dstG * da * (1 - sa)) / outA,
    (srcB * sa + dstB * da * (1 - sa)) / outA,
    outA,
  ]
}

/**
 * Evaluates the BrowserPilot fresh geek icon at normalized coordinate (nx, ny) in [0, 1].
 * Palette: airy glacier-mint -> cyan -> sky-azure squircle with crisp pure-white `>_` prompt + 4-point pilot spark.
 */
function sampleIcon(nx, ny, size) {
  const pad = size <= 16 ? 0.02 : 0.04
  const half = 0.5 - pad
  const corner = size <= 16 ? 0.24 : 0.235
  const bgDist = sdRoundedBox(nx, ny, half, half, corner)
  // Supersampling already performs geometric AA, so keep SDF transition tight & razor crisp
  const aa = 0.25 / size

  if (bgDist > aa * 2) return [0, 0, 0, 0]
  const bgMask = 1 - smoothstep(-aa, aa, bgDist)

  // Fresh, luminous diagonal gradient: mint (#2DD4BF) -> cyan (#06B6D4) -> crisp sky (#38BDF8)
  const gradT = clamp01(nx * 0.55 + ny * 0.65 - 0.1)
  let r, g, b
  if (gradT < 0.5) {
    const k = gradT * 2
    r = lerp(45, 6, k)
    g = lerp(218, 188, k)
    b = lerp(192, 214, k)
  } else {
    const k = (gradT - 0.5) * 2
    r = lerp(6, 56, k)
    g = lerp(188, 162, k)
    b = lerp(214, 248, k)
  }

  // Soft airy mint-white glow at top-left for fresh glass feel
  const glowDist = Math.hypot(nx - 0.24, ny - 0.18)
  const glow = (1 - smoothstep(0.0, 0.65, glowDist)) * 0.26
  r = lerp(r, 236, glow)
  g = lerp(g, 254, glow)
  b = lerp(b, 255, glow)

  // Subtle translucent white inner rim highlight along top/edges
  const rimWidth = size <= 32 ? 0.032 : 0.022
  const rimMask = smoothstep(-rimWidth - aa, -rimWidth + aa, bgDist) * (1 - smoothstep(-aa, aa, bgDist))
  const rimStrength = lerp(0.32, 0.12, ny)
  r = lerp(r, 255, rimMask * rimStrength)
  g = lerp(g, 255, rimMask * rimStrength)
  b = lerp(b, 255, rimMask * rimStrength)

  let outR = r
  let outG = g
  let outB = b
  let outA = bgMask

  // Boldness tuning for small 16px/32px toolbar legibility
  const boldBoost = size <= 16 ? 0.016 : size <= 32 ? 0.008 : 0
  const chevronR = 0.056 + boldBoost
  const barR = 0.052 + boldBoost
  const sparkR = 0.118 + boldBoost * 0.6

  const glyphSdf = (x, y) => {
    const c1 = sdCapsule(x, y, 0.255, 0.305, 0.475, 0.50, chevronR)
    const c2 = sdCapsule(x, y, 0.255, 0.695, 0.475, 0.50, chevronR)
    const chevron = Math.min(c1, c2)
    const underscore = sdCapsule(x, y, 0.535, 0.685, 0.745, 0.685, barR)
    const spark = sdFourPointSpark(x, y, 0.685, 0.335, sparkR)
    return Math.min(chevron, underscore, spark)
  }

  // Soft cool-teal drop shadow beneath glyph (gives crisp separation without heaviness)
  if (size >= 48) {
    const shDist = glyphSdf(nx, ny - 0.022)
    const shAlpha = (1 - smoothstep(-0.015, 0.042, shDist)) * 0.2 * bgMask
    ;[outR, outG, outB, outA] = blendOver(outR, outG, outB, outA, 7, 68, 92, shAlpha)
  }

  // Pure crisp white glyph (`>_` + 4-point pilot spark)
  const gDist = glyphSdf(nx, ny)
  const gMask = (1 - smoothstep(-aa, aa, gDist)) * bgMask
  if (gMask > 0) {
    // Give the 4-point spark a tiny luminous mint-ice shimmer at larger sizes
    const sparkDist = sdFourPointSpark(nx, ny, 0.685, 0.335, sparkR)
    const isSpark = sparkDist < gDist + 0.005
    const gr = isSpark ? 242 : 255
    const gg = isSpark ? 255 : 255
    const gb = isSpark ? 252 : 255
    ;[outR, outG, outB, outA] = blendOver(outR, outG, outB, outA, gr, gg, gb, gMask)
  }

  return [outR, outG, outB, outA]
}

function renderIconPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4))
  const ss = size <= 32 ? 6 : 4 // supersampling grid per pixel
  const invSamples = 1 / (ss * ss)

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4)
    raw[rowStart] = 0 // PNG filter None
    for (let x = 0; x < size; x++) {
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let sumA = 0

      for (let sy = 0; sy < ss; sy++) {
        const ny = (y + (sy + 0.5) / ss) / size
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size
          const [sr, sg, sb, sa] = sampleIcon(nx, ny, size)
          // Premultiply alpha for accurate anti-aliased averaging
          sumR += sr * sa
          sumG += sg * sa
          sumB += sb * sa
          sumA += sa
        }
      }

      const avgA = sumA * invSamples
      const px = rowStart + 1 + x * 4
      if (avgA <= 1e-4) {
        raw[px] = 0
        raw[px + 1] = 0
        raw[px + 2] = 0
        raw[px + 3] = 0
      } else {
        raw[px] = Math.round(clamp01(sumR / sumA / 255) * 255)
        raw[px + 1] = Math.round(clamp01(sumG / sumA / 255) * 255)
        raw[px + 2] = Math.round(clamp01(sumB / sumA / 255) * 255)
        raw[px + 3] = Math.round(clamp01(avgA) * 255)
      }
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const iconsDir = path.resolve(import.meta.dirname, '..', 'icons')
await fs.mkdir(iconsDir, { recursive: true })
for (const size of [16, 32, 48, 128]) {
  const png = renderIconPng(size)
  await fs.writeFile(path.join(iconsDir, `icon-${size}.png`), png)
}
console.log('Generated BrowserPilot extension PNG icons in', iconsDir)
