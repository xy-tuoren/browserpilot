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

function renderIconPng(size) {
  const raw = Buffer.alloc(size * (1 + size * 4))
  const rCorner = size * 0.22
  const cx = size / 2
  const cy = size / 2

  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4)
    raw[rowStart] = 0 // filter None
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4
      // Rounded square mask
      const dx = Math.max(0, Math.abs(x + 0.5 - cx) - (size / 2 - rCorner))
      const dy = Math.max(0, Math.abs(y + 0.5 - cy) - (size / 2 - rCorner))
      const dist = Math.hypot(dx, dy)
      if (dist > rCorner) {
        raw[px] = 0
        raw[px + 1] = 0
        raw[px + 2] = 0
        raw[px + 3] = 0
        continue
      }

      // Rich slate-to-emerald gradient background
      const t = (x + y) / (2 * size)
      let r = Math.round(15 + t * 8)
      let g = Math.round(23 + t * 28)
      let b = Math.round(42 + t * 22)
      let a = 255

      // Draw crisp geometric compass/chevron pilot mark in bright emerald-cyan
      const nx = (x + 0.5) / size
      const ny = (y + 0.5) / size
      const inOuterRing = Math.abs(Math.hypot(nx - 0.5, ny - 0.5) - 0.31) < 0.055
      const inChevron =
        nx >= 0.33 &&
        nx <= 0.72 &&
        (Math.abs(ny - (0.5 - (nx - 0.36) * 0.65)) < 0.075 ||
          Math.abs(ny - (0.5 + (nx - 0.36) * 0.65)) < 0.075) &&
        nx <= 0.64
      const inCoreDot = Math.hypot(nx - 0.66, ny - 0.5) < 0.075

      if (inChevron || inCoreDot) {
        r = 52
        g = 211
        b = 153 // #34d399 emerald
      } else if (inOuterRing) {
        r = 56
        g = 189
        b = 248 // #38bdf8 sky cyan
      }

      raw[px] = r
      raw[px + 1] = g
      raw[px + 2] = b
      raw[px + 3] = a
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
console.log('Generated DevPilot extension PNG icons in', iconsDir)
