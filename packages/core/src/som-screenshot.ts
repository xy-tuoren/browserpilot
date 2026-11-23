import type { SnapshotResult, SomLabelItem } from '@devpilot/protocol'
import type { PageController } from './page-controller.js'

const ROLE_COLORS: Record<string, string> = {
  link: '#facc15', // yellow
  button: '#fb923c', // orange
  textbox: '#f87171', // coral
  searchbox: '#f87171',
  combobox: '#f472b6', // pink
  checkbox: '#f472b6',
  radio: '#f472b6',
  switch: '#f472b6',
  slider: '#fdba74', // peach
  menuitem: '#fca5a5', // salmon
  tab: '#fbbf24', // amber
}

export interface LabeledScreenshotResult {
  base64: string
  mimeType: string
  path?: string
  snapshot: SnapshotResult
  labelsCount: number
}

/**
 * Captures a screenshot overlaid with Vimium-style color-coded ref labels (`e1`, `e2`, ...)
 * synchronized with the Accessibility Snapshot ref map, then cleanly removes the overlay.
 */
export async function captureLabeledScreenshot(
  page: PageController,
  options: { path?: string; maxLabels?: number; maxDimension?: number } = {},
): Promise<LabeledScreenshotResult> {
  const maxLabels = options.maxLabels ?? 120
  const snapshot = await page.snapshotEngine.capture(page.session, { showDiffSinceLastCall: false })
  const viewport = await page.evaluate<{ width: number; height: number }>(
    '({ width: window.innerWidth, height: window.innerHeight })',
  )

  const labels: SomLabelItem[] = []
  const refs = Object.values(snapshot.refs)

  for (const refTarget of refs) {
    if (labels.length >= maxLabels) break
    if (refTarget.sessionId) continue // main-frame viewport labels

    try {
      const quads = await page.session.send<{ quads?: number[][] }>('DOM.getContentQuads', {
        backendNodeId: refTarget.backendDOMNodeId,
      })
      const q = quads.quads?.[0]
      if (!q || q.length < 8) continue
      const xs = [q[0], q[2], q[4], q[6]]
      const ys = [q[1], q[3], q[5], q[7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const width = Math.max(...xs) - x
      const height = Math.max(...ys) - y
      if (width < 4 || height < 4) continue
      if (x + width < 0 || y + height < 0 || x > viewport.width || y > viewport.height) continue

      labels.push({
        ref: refTarget.ref,
        role: refTarget.role,
        name: refTarget.name,
        box: { x, y, width, height },
        color: ROLE_COLORS[refTarget.role] ?? '#60a5fa',
      })
    } catch {
      // skip stale or non-rendered nodes
    }
  }

  // Inject overlay in a closed shadow host (never pollutes page CSS/selectors)
  const injectOverlay = async () => {
    await page.evaluate(`(() => {
      const existing = document.getElementById('__devpilot_som_overlay');
      if (existing) existing.remove();
      const host = document.createElement('div');
      host.id = '__devpilot_som_overlay';
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'closed' });
      const items = ${JSON.stringify(labels)};
      for (const item of items) {
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;box-sizing:border-box;pointer-events:none;' +
          'left:' + item.box.x + 'px;top:' + item.box.y + 'px;' +
          'width:' + item.box.width + 'px;height:' + item.box.height + 'px;' +
          'border:1.5px solid ' + item.color + ';border-radius:3px;';
        const badge = document.createElement('span');
        badge.textContent = item.ref;
        badge.style.cssText =
          'position:absolute;top:-1px;left:-1px;transform:translateY(-85%);' +
          'background:' + item.color + ';color:#111827;font:700 10px/1 monospace;' +
          'padding:2px 4px;border-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,0.35);white-space:nowrap;';
        box.appendChild(badge);
        shadow.appendChild(box);
      }
      document.documentElement.appendChild(host);
    })()`)
  }

  const removeOverlay = async () => {
    await page
      .evaluate(`(() => { const el = document.getElementById('__devpilot_som_overlay'); if (el) el.remove(); })()`)
      .catch(() => {})
  }

  await injectOverlay()
  try {
    const shot = await page.screenshot({
      path: options.path,
      maxDimension: options.maxDimension ?? 1600,
    })
    return {
      base64: shot.base64,
      mimeType: shot.mimeType,
      path: shot.path,
      snapshot,
      labelsCount: labels.length,
    }
  } finally {
    await removeOverlay()
  }
}
