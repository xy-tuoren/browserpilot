import fs from 'node:fs/promises'
import path from 'node:path'
import type { TabCDPSession } from '../cdp-client.js'
import type { PdfOptions, ScreenshotOptions } from './types.js'

export interface CaptureDeps {
  session: TabCDPSession
  evaluate: <T = unknown>(expression: string) => Promise<T>
}

export async function exportPageToPDF(
  deps: CaptureDeps,
  options: PdfOptions = {},
): Promise<{ base64: string; path?: string; sizeBytes: number }> {
  const tabId = deps.session.tabId
  await deps.session.ensureBaseDomains()
  await deps.session.transport.setOverlayVisible?.(tabId, false).catch(() => {})
  try {
    const params: Record<string, unknown> = {
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      displayHeaderFooter: options.displayHeaderFooter ?? false,
    }
    if (options.headerTemplate !== undefined) params.headerTemplate = options.headerTemplate
    if (options.footerTemplate !== undefined) params.footerTemplate = options.footerTemplate
    if (options.scale !== undefined) params.scale = options.scale
    if (options.paperWidth !== undefined) params.paperWidth = options.paperWidth
    if (options.paperHeight !== undefined) params.paperHeight = options.paperHeight
    if (options.marginTop !== undefined) params.marginTop = options.marginTop
    if (options.marginBottom !== undefined) params.marginBottom = options.marginBottom
    if (options.marginLeft !== undefined) params.marginLeft = options.marginLeft
    if (options.marginRight !== undefined) params.marginRight = options.marginRight
    if (options.pageRanges !== undefined) params.pageRanges = options.pageRanges
    if (options.preferCSSPageSize !== undefined) params.preferCSSPageSize = options.preferCSSPageSize

    const res = await deps.session.send<{ data: string }>('Page.printToPDF', params)
    const buf = Buffer.from(res.data, 'base64')
    if (options.path) {
      const absPath = path.resolve(options.path)
      await fs.mkdir(path.dirname(absPath), { recursive: true })
      await fs.writeFile(absPath, buf)
      return { base64: res.data, path: absPath, sizeBytes: buf.byteLength }
    }
    return { base64: res.data, sizeBytes: buf.byteLength }
  } finally {
    await deps.session.transport.setOverlayVisible?.(tabId, true).catch(() => {})
  }
}

async function resizeBase64InPage(
  evaluate: <T = unknown>(expression: string) => Promise<T>,
  base64: string,
  mimeType: string,
  maxDimension: number,
  quality?: number,
): Promise<string | null> {
  try {
    const dataUrl = `data:${mimeType};base64,${base64}`
    const res = await evaluate<string | null>(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const maxSide = Math.max(img.width, img.height);
      if (maxSide <= ${maxDimension}) return null;
      const ratio = ${maxDimension} / maxSide;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL(${JSON.stringify(mimeType)}, ${quality ? quality / 100 : 0.85});
      return out.split(',')[1] || null;
    })()`)
    return res
  } catch {
    return null
  }
}

export async function capturePageScreenshot(
  deps: CaptureDeps,
  options: ScreenshotOptions = {},
): Promise<{
  base64: string
  mimeType: string
  path?: string
  region?: { x: number; y: number; width: number; height: number; scale: number }
}> {
  const tabId = deps.session.tabId
  const format = options.format ?? 'png'
  const params: Record<string, unknown> = { format }
  if (format !== 'png' && options.quality !== undefined) {
    params.quality = options.quality
  }

  let region: { x: number; y: number; width: number; height: number; scale: number } | undefined

  await deps.session.transport.setOverlayVisible?.(tabId, false).catch(() => {})
  await deps
    .evaluate(`(() => {
      const el = document.getElementById('__browserpilot_ui_host');
      if (el) el.style.visibility = 'hidden';
    })()`)
    .catch(() => {})

  try {
    const metrics = await deps.session.send<{
      cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
      cssContentSize?: { width: number; height: number }
      contentSize?: { width: number; height: number }
    }>('Page.getLayoutMetrics')
    const vp = metrics.cssVisualViewport ?? { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 }

    if (options.grid) {
      const step = options.gridStep ?? (options.zoom ? 50 : 200)
      const originX = options.zoom ? options.zoom.x : 0
      const originY = options.zoom ? options.zoom.y : 0
      const spanW = options.zoom ? options.zoom.width : vp.clientWidth
      const spanH = options.zoom ? options.zoom.height : vp.clientHeight
      await deps
        .evaluate(`(() => {
          document.getElementById('__browserpilot_grid_overlay')?.remove();
          const host = document.createElement('div');
          host.id = '__browserpilot_grid_overlay';
          host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
          const shadow = host.attachShadow({ mode: 'closed' });
          const step = ${step};
          const startX = Math.floor(${originX} / step) * step;
          const endX = ${originX + spanW};
          const startY = Math.floor(${originY} / step) * step;
          const endY = ${originY + spanH};
          for (let x = startX; x <= endX; x += step) {
            const line = document.createElement('div');
            line.style.cssText = 'position:fixed;top:0;bottom:0;left:' + x + 'px;width:1px;background:rgba(6,182,212,0.38);';
            shadow.appendChild(line);
            const lbl = document.createElement('div');
            lbl.textContent = String(x);
            lbl.style.cssText = 'position:fixed;top:' + (${originY} + 2) + 'px;left:' + (x + 3) + 'px;background:rgba(15,23,42,0.82);color:#67e8f9;font:700 10px/1 ui-monospace,monospace;padding:1px 3px;border-radius:3px;';
            shadow.appendChild(lbl);
          }
          for (let y = startY; y <= endY; y += step) {
            const line = document.createElement('div');
            line.style.cssText = 'position:fixed;left:0;right:0;top:' + y + 'px;height:1px;background:rgba(6,182,212,0.38);';
            shadow.appendChild(line);
            const lbl = document.createElement('div');
            lbl.textContent = String(y);
            lbl.style.cssText = 'position:fixed;left:' + (${originX} + 2) + 'px;top:' + (y + 3) + 'px;background:rgba(15,23,42,0.82);color:#67e8f9;font:700 10px/1 ui-monospace,monospace;padding:1px 3px;border-radius:3px;';
            shadow.appendChild(lbl);
          }
          (document.documentElement || document.body).appendChild(host);
        })()`)
        .catch(() => {})
    }

    if (options.zoom) {
      const scale = Math.max(1, Math.min(4, options.zoom.scale ?? 2))
      params.clip = {
        x: vp.pageX + options.zoom.x,
        y: vp.pageY + options.zoom.y,
        width: options.zoom.width,
        height: options.zoom.height,
        scale,
      }
      region = {
        x: options.zoom.x,
        y: options.zoom.y,
        width: options.zoom.width,
        height: options.zoom.height,
        scale,
      }
    } else if (options.clip) {
      params.clip = { ...options.clip, scale: 1 }
      region = { ...options.clip, scale: 1 }
    } else if (options.fullPage) {
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 1280, height: 720 }
      params.clip = {
        x: 0,
        y: 0,
        width: size.width,
        height: Math.min(size.height, 16_384),
        scale: 1,
      }
      params.captureBeyondViewport = true
    } else if (metrics.cssVisualViewport) {
      params.clip = {
        x: vp.pageX,
        y: vp.pageY,
        width: vp.clientWidth,
        height: vp.clientHeight,
        scale: 1,
      }
    }

    const res = await deps.session.send<{ data: string }>('Page.captureScreenshot', params)
    let base64 = res.data
    const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'

    if (options.maxDimension && options.maxDimension > 0) {
      const resized = await resizeBase64InPage(deps.evaluate, base64, mimeType, options.maxDimension, options.quality)
      if (resized) base64 = resized
    }

    if (options.path) {
      const absPath = path.resolve(options.path)
      await fs.mkdir(path.dirname(absPath), { recursive: true })
      await fs.writeFile(absPath, Buffer.from(base64, 'base64'))
      return { base64, mimeType, path: absPath, ...(region ? { region } : {}) }
    }

    return { base64, mimeType, ...(region ? { region } : {}) }
  } finally {
    if (options.grid) {
      await deps.evaluate(`document.getElementById('__browserpilot_grid_overlay')?.remove()`).catch(() => {})
    }
    await deps
      .evaluate(`(() => {
        const el = document.getElementById('__browserpilot_ui_host');
        if (el) el.style.visibility = '';
      })()`)
      .catch(() => {})
    await deps.session.transport.setOverlayVisible?.(tabId, true).catch(() => {})
  }
}
