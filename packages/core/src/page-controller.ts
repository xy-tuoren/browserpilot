import fs from 'node:fs/promises'
import path from 'node:path'
import type { BoundingBox } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import type { SnapshotEngine } from './snapshot.js'
import { sleep, waitForCondition, waitForPageLoad } from './wait.js'

export type MouseButton = 'left' | 'right' | 'middle'
export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

export interface ClickOptions {
  button?: MouseButton
  clickCount?: number
  modifiers?: KeyModifier[]
  timeoutMs?: number
  /** Skip pre-click occlusion & stability checks and click directly */
  force?: boolean
}

export interface ScrollResult {
  scrolled: boolean
  scrollX: number
  scrollY: number
  maxScrollY: number
  percentY: number
  atTop: boolean
  atBottom: boolean
  container: string
}

export interface FormFieldInput {
  target: string
  value: string | boolean
  type?: 'auto' | 'text' | 'select' | 'checkbox' | 'radio'
}

export interface FormFillResult {
  filled: Array<{ target: string; type: string; value: string | boolean }>
}

export interface HumanHandoffResult {
  resumed: boolean
  cancelled: boolean
  timedOut: boolean
  elapsedMs: number
  url: string
  title: string
}

export interface ScreenshotOptions {
  path?: string
  fullPage?: boolean
  format?: 'png' | 'jpeg' | 'webp'
  quality?: number
  clip?: BoundingBox
  /** Crop & upscale a viewport region (e.g. for Canvas, Figma, or tiny icons) */
  zoom?: { x: number; y: number; width: number; height: number; scale?: number }
  /** Overlay a translucent pixel coordinate grid for visual/Canvas coordinate clicking */
  grid?: boolean
  /** Grid spacing in CSS pixels (default 200 for full viewport, 50 for zoomed regions) */
  gridStep?: number
  maxDimension?: number
}

export interface EmulateOptions {
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  userAgent?: string
  colorScheme?: 'light' | 'dark' | 'no-preference'
  cpuThrottlingRate?: number
  networkPreset?: 'online' | 'offline' | 'slow-3g' | 'fast-3g' | '4g'
  timezone?: string
  locale?: string
  geolocation?: { latitude: number; longitude: number; accuracy?: number }
}

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
}

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }
}

function modifierBitmask(modifiers?: KeyModifier[]): number {
  if (!modifiers?.length) return 0
  let mask = 0
  for (const m of modifiers) {
    if (m === 'Alt') mask |= 1
    else if (m === 'Control') mask |= 2
    else if (m === 'Meta') mask |= 4
    else if (m === 'Shift') mask |= 8
  }
  return mask
}

function buttonBitmask(button: MouseButton): number {
  if (button === 'right') return 2
  if (button === 'middle') return 4
  return 1
}

function resolveEditingCommands(key: string, mods: KeyModifier[]): string[] {
  const hasAccel = mods.includes('Meta') || mods.includes('Control')
  const hasShift = mods.includes('Shift')
  const lower = key.toLowerCase()
  if (hasAccel && !mods.includes('Alt')) {
    if (lower === 'a' && !hasShift) return ['selectAll']
    if (lower === 'c' && !hasShift) return ['copy']
    if (lower === 'x' && !hasShift) return ['cut']
    if (lower === 'v' && !hasShift) return ['paste']
    if (lower === 'v' && hasShift) return ['pasteAndMatchStyle']
    if (lower === 'z' && !hasShift) return ['undo']
    if ((lower === 'z' && hasShift) || (lower === 'y' && !hasShift)) return ['redo']
  }
  if (!hasAccel && !mods.includes('Alt')) {
    if (key === 'Backspace') return ['deleteBackward']
    if (key === 'Delete') return ['deleteForward']
  }
  return []
}

function resolveKeyDef(keyName: string): KeyDef {
  if (SPECIAL_KEYS[keyName]) return SPECIAL_KEYS[keyName]
  if (keyName.length === 1) {
    const ch = keyName
    const upper = ch.toUpperCase()
    const code = /[A-Z]/.test(upper)
      ? `Key${upper}`
      : /[0-9]/.test(ch)
        ? `Digit${ch}`
        : ch
    return { key: ch, code, keyCode: upper.charCodeAt(0), text: ch }
  }
  return { key: keyName, code: keyName, keyCode: 0 }
}

export interface ResolvedElement {
  objectId: string
  backendNodeId?: number
  sessionId?: string
  frameOffset?: { x: number; y: number }
  box: BoundingBox
  center: { x: number; y: number }
}

/**
 * Pure-CDP Page Controller executing real, browser-trusted (`isTrusted === true`)
 * interactions without Playwright or Puppeteer.
 */
export class PageController {
  readonly session: TabCDPSession
  readonly snapshotEngine: SnapshotEngine
  private lastMousePos = { x: 0, y: 0 }

  constructor(session: TabCDPSession, snapshotEngine: SnapshotEngine) {
    this.session = session
    this.snapshotEngine = snapshotEngine
  }

  get tabId(): number {
    return this.session.tabId
  }

  async getUrlAndTitle(): Promise<{ url: string; title: string }> {
    const res = await this.session.send<{ result?: { value?: { url: string; title: string } } }>('Runtime.evaluate', {
      expression: '({ url: location.href, title: document.title })',
      returnByValue: true,
    })
    return res.result?.value ?? { url: '', title: '' }
  }

  async navigate(
    url: string,
    options: { waitUntil?: 'none' | 'domcontentloaded' | 'load' | 'networkidle'; timeoutMs?: number } = {},
  ): Promise<{ url: string; title: string }> {
    await this.session.ensureBaseDomains()
    const waitUntil = options.waitUntil ?? 'domcontentloaded'
    const timeoutMs = options.timeoutMs ?? 30_000

    const domContentLoaded =
      waitUntil === 'domcontentloaded' || waitUntil === 'load' || waitUntil === 'networkidle'
        ? this.session.once('Page.domContentEventFired', undefined, timeoutMs).catch(() => null)
        : null
    const loadEvent =
      waitUntil === 'load'
        ? this.session.once('Page.loadEventFired', undefined, timeoutMs).catch(() => null)
        : null

    const navRes = await this.session.send<{ errorText?: string }>('Page.navigate', { url }, { timeoutMs })
    if (navRes.errorText) {
      throw new Error(`Navigation to "${url}" failed: ${navRes.errorText}`)
    }

    if (domContentLoaded) await domContentLoaded
    if (loadEvent) await loadEvent
    if (waitUntil === 'networkidle') {
      await waitForPageLoad(this.session, { timeoutMs: Math.min(timeoutMs, 8_000) })
    }

    return await this.getUrlAndTitle()
  }

  async reload(ignoreCache = false): Promise<{ url: string; title: string }> {
    await this.session.ensureBaseDomains()
    const loaded = this.session.once('Page.domContentEventFired', undefined, 20_000).catch(() => null)
    await this.session.send('Page.reload', { ignoreCache })
    await loaded
    return await this.getUrlAndTitle()
  }

  async goBack(): Promise<{ url: string; title: string }> {
    const hist = await this.session.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
      'Page.getNavigationHistory',
    )
    if (hist.currentIndex > 0) {
      await this.session.send('Page.navigateToHistoryEntry', {
        entryId: hist.entries[hist.currentIndex - 1].id,
      })
      await waitForPageLoad(this.session, { timeoutMs: 5_000 })
    }
    return await this.getUrlAndTitle()
  }

  async goForward(): Promise<{ url: string; title: string }> {
    const hist = await this.session.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
      'Page.getNavigationHistory',
    )
    if (hist.currentIndex < hist.entries.length - 1) {
      await this.session.send('Page.navigateToHistoryEntry', {
        entryId: hist.entries[hist.currentIndex + 1].id,
      })
      await waitForPageLoad(this.session, { timeoutMs: 5_000 })
    }
    return await this.getUrlAndTitle()
  }

  /**
   * Resolve a snapshot ref (`e5`), CSS selector (`#btn`), `text=...`, or `role=...` locator
   * into an actionable, scrolled-into-view element with viewport coordinates.
   */
  async resolveElement(target: string, timeoutMs: number = 8_000): Promise<ResolvedElement> {
    return await waitForCondition(
      async () => {
        const refTarget = this.snapshotEngine.getRef(this.tabId, target)
        let objectId: string | undefined
        let backendNodeId: number | undefined
        let sessionId: string | undefined

        if (refTarget) {
          backendNodeId = refTarget.backendDOMNodeId
          sessionId = refTarget.sessionId
          const resolved = await this.session
            .send<{ object?: { objectId?: string } }>(
              'DOM.resolveNode',
              { backendNodeId },
              { sessionId },
            )
            .catch(() => null)
          objectId = resolved?.object?.objectId
        } else {
          objectId = await this.queryElementObjectId(target)
          if (objectId) {
            const desc = await this.session
              .send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId })
              .catch(() => null)
            backendNodeId = desc?.node?.backendNodeId
          }
        }

        if (!objectId) return null

        // Scroll into view cleanly
        if (backendNodeId) {
          await this.session
            .send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, { sessionId })
            .catch(() => {})
        }
        await this.session
          .send(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: `function() {
                if (typeof this.scrollIntoView === 'function') {
                  this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                }
              }`,
            },
            { sessionId },
          )
          .catch(() => {})

        // Compute viewport bounding box (accounting for child iframe offset if needed)
        const rectRes = await this.session.send<{ result?: { value?: BoundingBox | null } }>(
          'Runtime.callFunctionOn',
          {
            objectId,
            returnByValue: true,
            functionDeclaration: `function() {
              const r = this.getBoundingClientRect();
              if (!r || (r.width === 0 && r.height === 0)) return null;
              return { x: r.left, y: r.top, width: r.width, height: r.height };
            }`,
          },
          { sessionId },
        )

        let box = rectRes.result?.value ?? null
        if (!box && backendNodeId) {
          const quads = await this.session
            .send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId }, { sessionId })
            .catch(() => null)
          const q = quads?.quads?.[0]
          if (q && q.length >= 8) {
            const xs = [q[0], q[2], q[4], q[6]]
            const ys = [q[1], q[3], q[5], q[7]]
            const minX = Math.min(...xs)
            const minY = Math.min(...ys)
            box = {
              x: minX,
              y: minY,
              width: Math.max(...xs) - minX,
              height: Math.max(...ys) - minY,
            }
          }
        }

        if (!box || (box.width === 0 && box.height === 0)) return null

        // If element is inside a child OOPIF session, add iframe viewport offset in top frame
        let frameOffset: { x: number; y: number } | undefined
        if (sessionId) {
          frameOffset = await this.getIframeOffset(refTarget?.frameId, sessionId)
          box = {
            x: box.x + frameOffset.x,
            y: box.y + frameOffset.y,
            width: box.width,
            height: box.height,
          }
        }

        return {
          objectId,
          backendNodeId,
          sessionId,
          frameOffset,
          box,
          center: {
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2),
          },
        }
      },
      { timeoutMs, intervalMs: 100, description: `element "${target}"` },
    )
  }

  private async getIframeOffset(frameId?: string, childSessionId?: string): Promise<{ x: number; y: number }> {
    const child = childSessionId
      ? this.session.getChildSessions().find((c) => c.sessionId === childSessionId)
      : undefined
    const effectiveFrameId = frameId || child?.targetId
    if (effectiveFrameId) {
      try {
        const owner = await this.session.send<{ backendNodeId?: number }>('DOM.getFrameOwner', {
          frameId: effectiveFrameId,
        })
        if (owner.backendNodeId) {
          const box = await this.session.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', {
            backendNodeId: owner.backendNodeId,
          })
          const c = box.model?.content
          if (c && c.length >= 2) return { x: c[0], y: c[1] }
        }
      } catch {
        // fall through to URL-based iframe rect lookup
      }
    }

    if (child?.url) {
      try {
        const rect = await this.evaluate<{ x: number; y: number } | null>(`(() => {
          const targetUrl = ${JSON.stringify(child.url)};
          for (const f of document.querySelectorAll('iframe')) {
            const src = f.src || f.getAttribute('src') || '';
            if (src && (src === targetUrl || targetUrl.startsWith(src) || src.startsWith(targetUrl))) {
              const r = f.getBoundingClientRect();
              return { x: r.left, y: r.top };
            }
          }
          return null;
        })()`)
        if (rect) return rect
      } catch {
        // ignore
      }
    }
    return { x: 0, y: 0 }
  }

  private async queryElementObjectId(rawSelector: string): Promise<string | undefined> {
    // Support optional ">> nth=N" suffix (Playwright/Playwriter compatibility)
    let selector = rawSelector.trim()
    let nth = 0
    const nthMatch = selector.match(/^(.*?)\s*>>\s*nth=(\d+)\s*$/)
    if (nthMatch) {
      selector = nthMatch[1].trim()
      nth = Number(nthMatch[2])
    }

    // Pinned element shortcut (e.g. "globalThis.__browserpilotPinned1" or "pinned")
    if (selector === 'pinned' || selector.startsWith('globalThis.__browserpilotPinned')) {
      const expr =
        selector === 'pinned'
          ? `(() => {
              const keys = Object.keys(globalThis).filter((k) => k.startsWith('__browserpilotPinned'));
              return keys.length ? globalThis[keys[keys.length - 1]] : null;
            })()`
          : selector
      const res = await this.session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
        expression: expr,
        returnByValue: false,
      })
      return res.result?.objectId
    }

    // role=button[name="Save"] locator
    const roleMatch = selector.match(/^role=([a-zA-Z0-9_-]+)(?:\[name=["'](.+?)["']\])?$/i)
    if (roleMatch) {
      const role = roleMatch[1].toLowerCase()
      const nameNeedle = (roleMatch[2] || '').trim().toLowerCase()
      const res = await this.session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
        expression: `(() => {
          const targetRole = ${JSON.stringify(role)};
          const needle = ${JSON.stringify(nameNeedle)};
          const nthIdx = ${nth};
          const ROLE_TAGS = {
            button: 'button, [role="button"], input[type="button"], input[type="submit"]',
            link: 'a[href], [role="link"]',
            textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="password"], textarea, [role="textbox"], [contenteditable="true"]',
            checkbox: 'input[type="checkbox"], [role="checkbox"]',
            radio: 'input[type="radio"], [role="radio"]',
            combobox: 'select, [role="combobox"]',
            heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
            tab: '[role="tab"]',
            menuitem: '[role="menuitem"]',
          };
          const css = ROLE_TAGS[targetRole] || ('[role="' + targetRole + '"]');
          const hits = [];
          function walk(root) {
            for (const el of root.querySelectorAll(css)) {
              const accName = (
                el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.getAttribute('placeholder') ||
                el.innerText ||
                el.value ||
                el.textContent || ''
              ).replace(/\\s+/g, ' ').trim().toLowerCase();
              if (!needle || accName === needle || accName.includes(needle)) hits.push(el);
            }
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
            }
          }
          walk(document);
          return hits[nthIdx] || null;
        })()`,
        returnByValue: false,
      })
      return res.result?.objectId
    }

    // label=... locator
    if (selector.startsWith('label=')) {
      const needle = selector.slice(6).trim().toLowerCase()
      const res = await this.session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
        expression: `(() => {
          const needle = ${JSON.stringify(needle)};
          const hits = [];
          for (const lbl of document.querySelectorAll('label')) {
            const t = (lbl.innerText || lbl.textContent || '').trim().toLowerCase();
            if (t === needle || t.includes(needle)) {
              const forId = lbl.getAttribute('for');
              const ctrl = forId ? document.getElementById(forId) : lbl.querySelector('input, textarea, select');
              if (ctrl) hits.push(ctrl);
            }
          }
          for (const el of document.querySelectorAll('[aria-label]')) {
            const t = (el.getAttribute('aria-label') || '').trim().toLowerCase();
            if (t === needle || t.includes(needle)) hits.push(el);
          }
          return hits[${nth}] || null;
        })()`,
        returnByValue: false,
      })
      return res.result?.objectId
    }

    // placeholder=... locator
    if (selector.startsWith('placeholder=')) {
      const needle = selector.slice(12).trim().toLowerCase()
      const res = await this.session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
        expression: `(() => {
          const needle = ${JSON.stringify(needle)};
          const hits = Array.from(document.querySelectorAll('[placeholder]')).filter((el) =>
            (el.getAttribute('placeholder') || '').trim().toLowerCase().includes(needle)
          );
          return hits[${nth}] || null;
        })()`,
        returnByValue: false,
      })
      return res.result?.objectId
    }

    // text=... or standard CSS selector (with Shadow DOM + nth support)
    const expr = selector.startsWith('text=')
      ? `(() => {
          const needle = ${JSON.stringify(selector.slice(5))}.trim().toLowerCase();
          const exact = [];
          const partial = [];
          function walk(root) {
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
              const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (txt === needle) exact.push(el);
              else if (txt.includes(needle) && el.children.length === 0) partial.push(el);
            }
          }
          walk(document);
          const list = exact.length ? exact : partial;
          return list[${nth}] || null;
        })()`
      : `(() => {
          const sel = ${JSON.stringify(selector)};
          const hits = [];
          function walk(root) {
            try { hits.push(...root.querySelectorAll(sel)); } catch {}
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) walk(el.shadowRoot);
            }
          }
          walk(document);
          return hits[${nth}] || null;
        })()`

    const res = await this.session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: expr,
      returnByValue: false,
    })
    return res.result?.objectId
  }

  /**
   * Verifies pre-click actionability (position stability, enabled state, and non-occlusion).
   * If a fixed/sticky header occludes the target, automatically re-centers it in viewport.
   */
  private async ensureClickActionable(
    el: ResolvedElement,
    targetLabel: string,
  ): Promise<{ el: ResolvedElement; underOwnPill: boolean }> {
    let current = el
    let underOwnPill = false
    // 1. Wait briefly for CSS animations/transitions to settle (max ~320ms)
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(35)
      const nextBox = await this.readElementViewportBox(current)
      if (!nextBox) break
      const moved =
        Math.abs(nextBox.x - current.box.x) > 2 ||
        Math.abs(nextBox.y - current.box.y) > 2
      current = {
        ...current,
        box: nextBox,
        center: { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 },
      }
      if (!moved) break
    }

    // 2. Check disabled state and hit-test occlusion (only in main frame where elementFromPoint matches viewport coords)
    if (current.sessionId) return { el: current, underOwnPill: false }
    for (let retry = 0; retry < 2; retry++) {
      const check = await this.session
        .send<{
          result?: {
            value?: {
              ok: boolean
              reason?: string
              occluder?: string
              isFixedOrSticky?: boolean
              underOwnPill?: boolean
            }
          }
        }>('Runtime.callFunctionOn', {
          objectId: current.objectId,
          arguments: [{ value: current.center.x }, { value: current.center.y }],
          functionDeclaration: `function(cx, cy) {
            if (this.disabled === true || this.getAttribute?.('aria-disabled') === 'true') {
              return { ok: false, reason: 'disabled' };
            }
            const style = getComputedStyle(this);
            if (style.pointerEvents === 'none') {
              return { ok: false, reason: 'pointer-events-none' };
            }
            function deepHit(root, x, y) {
              let hit = root.elementFromPoint(x, y);
              while (hit && hit.shadowRoot) {
                const inner = hit.shadowRoot.elementFromPoint(x, y);
                if (!inner || inner === hit) break;
                hit = inner;
              }
              return hit;
            }
            let hit = deepHit(document, cx, cy);
            let hitOwnPill = false;
            if (hit && hit.id === '__browserpilot_ui_host') {
              hitOwnPill = true;
              const prevDisplay = hit.style.display;
              hit.style.display = 'none';
              hit = deepHit(document, cx, cy);
              const uiHost = document.getElementById('__browserpilot_ui_host');
              if (uiHost) uiHost.style.display = prevDisplay;
            }
            if (!hit) return { ok: true, underOwnPill: hitOwnPill };
            if (hit === this || this.contains(hit) || hit.contains(this)) return { ok: true, underOwnPill: hitOwnPill };
            // Allow clicking associated <label> for form controls
            if (this.id && hit.closest && hit.closest('label[for="' + CSS.escape(this.id) + '"]')) return { ok: true, underOwnPill: hitOwnPill };
            // Walk up occluder to detect fixed/sticky header vs modal overlay
            let cur = hit;
            let isFixedOrSticky = false;
            while (cur && cur !== document.body && cur !== document.documentElement) {
              const pos = getComputedStyle(cur).position;
              if (pos === 'fixed' || pos === 'sticky') {
                isFixedOrSticky = true;
                break;
              }
              cur = cur.parentElement;
            }
            const tag = hit.tagName?.toLowerCase() || 'element';
            const cls = typeof hit.className === 'string' && hit.className.trim()
              ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.')
              : '';
            const id = hit.id ? '#' + hit.id : '';
            const txt = (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
            return {
              ok: false,
              reason: 'occluded',
              occluder: '<' + tag + id + cls + '>' + (txt ? ' ("' + txt + '")' : ''),
              isFixedOrSticky,
              underOwnPill: hitOwnPill,
            };
          }`,
          returnByValue: true,
        })
        .catch(() => null)

      const val = check?.result?.value
      if (val?.underOwnPill) underOwnPill = true
      if (!val || val.ok) return { el: current, underOwnPill }

      if (val.reason === 'disabled') {
        throw new Error(`Element "${targetLabel}" is disabled and cannot be clicked.`)
      }
      if (val.reason === 'pointer-events-none') {
        throw new Error(`Element "${targetLabel}" has pointer-events: none (pass force: true to override).`)
      }
      if (val.reason === 'occluded' && val.isFixedOrSticky && retry === 0) {
        // Re-center in viewport to clear sticky header/footer and re-measure
        await this.session
          .send('Runtime.callFunctionOn', {
            objectId: current.objectId,
            functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`,
          })
          .catch(() => {})
        await sleep(60)
        const recentered = await this.readElementViewportBox(current)
        if (recentered) {
          current = {
            ...current,
            box: recentered,
            center: { x: recentered.x + recentered.width / 2, y: recentered.y + recentered.height / 2 },
          }
          continue
        }
      }
      if (val.reason === 'occluded') {
        throw new Error(
          `Element "${targetLabel}" is occluded at (${Math.round(current.center.x)}, ${Math.round(current.center.y)}) by ${val.occluder ?? 'another element'}. Dismiss the overlay/banner first or pass force: true.`,
        )
      }
    }
    return { el: current, underOwnPill }
  }

  private async readElementViewportBox(el: ResolvedElement): Promise<BoundingBox | null> {
    try {
      const res = await this.session.send<{ result?: { value?: BoundingBox } }>(
        'Runtime.callFunctionOn',
        {
          objectId: el.objectId,
          functionDeclaration: `function() {
            const r = this.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
          }`,
          returnByValue: true,
        },
        { sessionId: el.sessionId },
      )
      const b = res.result?.value
      if (!b || b.width <= 0 || b.height <= 0) return null
      if (el.frameOffset) {
        return {
          x: b.x + el.frameOffset.x,
          y: b.y + el.frameOffset.y,
          width: b.width,
          height: b.height,
        }
      }
      return b
    } catch {
      return null
    }
  }

  async click(targetOrCoords: string | { x: number; y: number }, options: ClickOptions = {}): Promise<void> {
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1
    const modifiers = modifierBitmask(options.modifiers)

    let x: number
    let y: number
    let underOwnPill = false
    if (typeof targetOrCoords === 'string') {
      let el = await this.resolveElement(targetOrCoords, options.timeoutMs)
      if (!options.force) {
        const checked = await this.ensureClickActionable(el, targetOrCoords)
        el = checked.el
        underOwnPill = checked.underOwnPill
      }
      x = el.center.x
      y = el.center.y
      await this.session.transport
        .setControlBanner?.(this.tabId, { active: true, status: `Clicking ${targetOrCoords}`, mode: 'working' })
        .catch(() => {})
      await this.session.transport.highlightElement?.(this.tabId, el.box, `click ${targetOrCoords}`).catch(() => {})
    } else {
      x = targetOrCoords.x
      y = targetOrCoords.y
      await this.session.transport
        .setControlBanner?.(this.tabId, { active: true, status: `Clicking (${Math.round(x)}, ${Math.round(y)})`, mode: 'working' })
        .catch(() => {})
    }

    if (underOwnPill) {
      await this.evaluate(`(() => { const h = document.getElementById('__browserpilot_ui_host'); if (h) h.style.display = 'none'; })()`).catch(() => {})
    }
    try {
      await this.mouseClick(x, y, { button, clickCount, modifiers })
    } finally {
      if (underOwnPill) {
        await this.evaluate(`(() => { const h = document.getElementById('__browserpilot_ui_host'); if (h) h.style.display = ''; })()`).catch(() => {})
      }
    }
  }

  async dblclick(targetOrCoords: string | { x: number; y: number }): Promise<void> {
    await this.click(targetOrCoords, { clickCount: 2 })
  }

  async rightClick(targetOrCoords: string | { x: number; y: number }): Promise<void> {
    await this.click(targetOrCoords, { button: 'right' })
  }

  async hover(targetOrCoords: string | { x: number; y: number }, timeoutMs?: number): Promise<void> {
    let x: number
    let y: number
    if (typeof targetOrCoords === 'string') {
      const el = await this.resolveElement(targetOrCoords, timeoutMs)
      x = el.center.x
      y = el.center.y
      await this.session.transport.highlightElement?.(this.tabId, el.box, `hover ${targetOrCoords}`).catch(() => {})
    } else {
      x = targetOrCoords.x
      y = targetOrCoords.y
    }
    await this.mouseMove(x, y)
  }

  async mouseMove(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, options.steps ?? 1)
    const startX = this.lastMousePos.x
    const startY = this.lastMousePos.y
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      // Ease-out cubic glide for natural pointer feel
      const eased = steps > 1 ? 1 - Math.pow(1 - t, 2) : 1
      const cx = startX + (x - startX) * eased
      const cy = startY + (y - startY) * eased
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cx,
        y: cy,
      })
      if (steps > 1) {
        await this.session.transport.moveGhostCursor?.(this.tabId, cx, cy, false).catch(() => {})
        await sleep(8)
      }
    }
    this.lastMousePos = { x, y }
    if (steps === 1) {
      await this.session.transport.moveGhostCursor?.(this.tabId, x, y, false).catch(() => {})
    }
  }

  async mouseDown(x: number, y: number, opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    const button = opts.button ?? 'left'
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: buttonBitmask(button),
      clickCount: opts.clickCount ?? 1,
      modifiers: opts.modifiers ?? 0,
    })
    this.lastMousePos = { x, y }
    await this.session.transport.moveGhostCursor?.(this.tabId, x, y, true).catch(() => {})
  }

  async mouseUp(x: number, y: number, opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    const button = opts.button ?? 'left'
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: opts.clickCount ?? 1,
      modifiers: opts.modifiers ?? 0,
    })
    this.lastMousePos = { x, y }
    await this.session.transport.moveGhostCursor?.(this.tabId, x, y, false).catch(() => {})
  }

  async mouseClick(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left'
    const clicks = opts.clickCount ?? 1
    const dist = Math.hypot(x - this.lastMousePos.x, y - this.lastMousePos.y)
    await this.mouseMove(x, y, { steps: dist > 40 ? 4 : 1 })
    for (let c = 1; c <= clicks; c++) {
      await this.mouseDown(x, y, { button, clickCount: c, modifiers: opts.modifiers })
      await this.mouseUp(x, y, { button, clickCount: c, modifiers: opts.modifiers })
    }
  }

  async wheel(deltaX: number, deltaY: number, pos?: { x: number; y: number }): Promise<void> {
    const x = pos?.x ?? this.lastMousePos.x ?? 400
    const y = pos?.y ?? this.lastMousePos.y ?? 300
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    })
  }

  async drag(
    from: string | { x: number; y: number },
    to: string | { x: number; y: number },
    options: { steps?: number } = {},
  ): Promise<void> {
    const start = typeof from === 'string' ? (await this.resolveElement(from)).center : from
    const end = typeof to === 'string' ? (await this.resolveElement(to)).center : to
    await this.mouseMove(start.x, start.y)
    await this.mouseDown(start.x, start.y)
    await this.mouseMove(end.x, end.y, { steps: options.steps ?? 12 })
    await this.mouseUp(end.x, end.y)
  }

  async scroll(options: {
    target?: string
    deltaX?: number
    deltaY?: number
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
  }): Promise<ScrollResult> {
    const amount = options.amount ?? 500
    let dx = options.deltaX ?? 0
    let dy = options.deltaY ?? 0
    if (options.direction === 'down') dy = amount
    else if (options.direction === 'up') dy = -amount
    else if (options.direction === 'right') dx = amount
    else if (options.direction === 'left') dx = -amount

    await this.session.transport
      .setControlBanner?.(this.tabId, {
        active: true,
        status: `Scrolling ${options.direction ?? (dy >= 0 ? 'down' : 'up')}`,
        mode: 'working',
      })
      .catch(() => {})

    const probeMainScrollContainer = async () => {
      return await this.evaluate<{
        x: number
        y: number
        scrollX: number
        scrollY: number
        maxScrollY: number
        container: string
      }>(`(() => {
        const vw = window.innerWidth || 1280;
        const vh = window.innerHeight || 720;
        const docEl = document.scrollingElement || document.documentElement;
        const docMaxY = Math.max(0, (docEl?.scrollHeight || 0) - vh);
        if (docMaxY > 24) {
          return {
            x: Math.round(vw / 2),
            y: Math.round(vh / 2),
            scrollX: Math.round(window.scrollX || docEl.scrollLeft || 0),
            scrollY: Math.round(window.scrollY || docEl.scrollTop || 0),
            maxScrollY: Math.round(docMaxY),
            container: 'window',
          };
        }
        // SPA layout where an inner container (main/section/div) owns scroll
        let best = null;
        let bestArea = 0;
        for (const el of document.querySelectorAll('main, [role="main"], section, article, div')) {
          const st = getComputedStyle(el);
          if (!/(auto|scroll|overlay)/.test(st.overflowY)) continue;
          const maxY = el.scrollHeight - el.clientHeight;
          if (maxY <= 24) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 160 || r.height < 160) continue;
          const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
          const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
          const area = visW * visH;
          if (area > bestArea) {
            bestArea = area;
            const id = el.id ? '#' + el.id : '';
            best = {
              x: Math.round(Math.max(r.left, 0) + visW / 2),
              y: Math.round(Math.max(r.top, 0) + visH / 2),
              scrollX: Math.round(el.scrollLeft),
              scrollY: Math.round(el.scrollTop),
              maxScrollY: Math.round(maxY),
              container: el.tagName.toLowerCase() + id,
            };
          }
        }
        return best || {
          x: Math.round(vw / 2),
          y: Math.round(vh / 2),
          scrollX: Math.round(window.scrollX || 0),
          scrollY: Math.round(window.scrollY || 0),
          maxScrollY: Math.round(docMaxY),
          container: 'window',
        };
      })()`)
    }

    const before = await probeMainScrollContainer()

    if (options.target) {
      const el = await this.resolveElement(options.target)
      if (dx !== 0 || dy !== 0) {
        await this.wheel(dx, dy, el.center)
        await sleep(120)
      }
    } else {
      await this.wheel(dx, dy, { x: before.x, y: before.y })
      await sleep(120)
    }

    const after = await probeMainScrollContainer()
    const percentY = after.maxScrollY > 0 ? Math.min(100, Math.round((after.scrollY / after.maxScrollY) * 100)) : 100
    return {
      scrolled: after.scrollY !== before.scrollY || after.scrollX !== before.scrollX,
      scrollX: after.scrollX,
      scrollY: after.scrollY,
      maxScrollY: after.maxScrollY,
      percentY,
      atTop: after.scrollY <= 1,
      atBottom: after.maxScrollY <= 1 || after.scrollY >= after.maxScrollY - 2,
      container: after.container,
    }
  }

  /**
   * Focuses element, clears existing value, and inserts text via trusted CDP Input.insertText.
   * Works cleanly with React/Vue controlled inputs, textareas, and contenteditable elements.
   */
  async fill(target: string, value: string, options: { clear?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const el = await this.resolveElement(target, options.timeoutMs)
    await this.session.transport
      .setControlBanner?.(this.tabId, { active: true, status: `Filling ${target}`, mode: 'working' })
      .catch(() => {})
    await this.session.transport.highlightElement?.(this.tabId, el.box, `fill ${target}`).catch(() => {})

    // Click to focus natively
    await this.mouseClick(el.center.x, el.center.y)
    await this.session
      .send(
        'Runtime.callFunctionOn',
        {
          objectId: el.objectId,
          functionDeclaration: `function() {
            if (typeof this.focus === 'function') this.focus();
            if (${options.clear !== false}) {
              if (typeof this.select === 'function') {
                this.select();
              } else if (this.isContentEditable) {
                const range = document.createRange();
                range.selectNodeContents(this);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
              }
            }
          }`,
        },
        { sessionId: el.sessionId },
      )
      .catch(() => {})

    if (options.clear !== false) {
      await this.pressKey('Backspace')
    }

    if (value.length > 0) {
      await this.session.send('Input.insertText', { text: value })
    }

    // Verify value actually applied on standard inputs (fallback for tricky controlled widgets)
    await this.session
      .send(
        'Runtime.callFunctionOn',
        {
          objectId: el.objectId,
          arguments: [{ value }],
          functionDeclaration: `function(expected) {
            const tag = this.tagName?.toLowerCase();
            if ((tag === 'input' || tag === 'textarea') && this.value !== expected) {
              const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(this, expected);
              else this.value = expected;
              this.dispatchEvent(new Event('input', { bubbles: true }));
              this.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }`,
        },
        { sessionId: el.sessionId },
      )
      .catch(() => {})
  }

  async type(target: string | null, text: string, options: { delayMs?: number } = {}): Promise<void> {
    if (target) {
      await this.click(target)
    }
    const delayMs = options.delayMs ?? 0
    if (delayMs <= 0) {
      await this.session.send('Input.insertText', { text })
      return
    }
    for (const ch of text) {
      await this.session.send('Input.insertText', { text: ch })
      await sleep(delayMs)
    }
  }

  async pressKey(combo: string, options: { modifiers?: KeyModifier[] } = {}): Promise<void> {
    const parts = combo.split('+').map((s) => s.trim())
    const keyPart = parts.pop()!
    const mods: KeyModifier[] = [...(options.modifiers ?? [])]
    for (const p of parts) {
      const lower = p.toLowerCase()
      if (lower === 'cmd' || lower === 'meta' || lower === 'command') mods.push('Meta')
      else if (lower === 'ctrl' || lower === 'control') mods.push('Control')
      else if (lower === 'alt' || lower === 'option') mods.push('Alt')
      else if (lower === 'shift') mods.push('Shift')
    }

    const mask = modifierBitmask(mods)
    const def = resolveKeyDef(keyPart)
    const commands = resolveEditingCommands(def.key, mods)
    const hasAccel = mods.includes('Meta') || mods.includes('Control')

    const activeMods: KeyModifier[] = []
    for (const m of mods) {
      activeMods.push(m)
      await this.keyDown(m, modifierBitmask(activeMods))
    }
    await this.session.send('Input.dispatchKeyEvent', {
      type: def.text && !hasAccel ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      text: hasAccel ? undefined : def.text,
      unmodifiedText: def.text,
      modifiers: mask,
      ...(commands.length ? { commands } : {}),
    })
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers: mask,
    })
    for (let i = mods.length - 1; i >= 0; i--) {
      activeMods.pop()
      await this.keyUp(mods[i], modifierBitmask(activeMods))
    }
  }

  /**
   * Fills multiple form fields (text, select, checkbox, radio) in a single structured call.
   */
  async fillForm(fields: FormFieldInput[]): Promise<FormFillResult> {
    const filled: FormFillResult['filled'] = []
    for (const field of fields) {
      const kind = field.type ?? 'auto'
      let detectedType = kind
      if (kind === 'auto') {
        const el = await this.resolveElement(field.target)
        const meta = await this.session
          .send<{ result?: { value?: { tag: string; inputType: string } } }>(
            'Runtime.callFunctionOn',
            {
              objectId: el.objectId,
              functionDeclaration: `function() { return { tag: (this.tagName || '').toLowerCase(), inputType: (this.type || '').toLowerCase() }; }`,
              returnByValue: true,
            },
            { sessionId: el.sessionId },
          )
          .catch(() => null)
        const tag = meta?.result?.value?.tag ?? ''
        const inputType = meta?.result?.value?.inputType ?? ''
        if (tag === 'select') detectedType = 'select'
        else if (inputType === 'checkbox') detectedType = 'checkbox'
        else if (inputType === 'radio') detectedType = 'radio'
        else detectedType = 'text'
      }

      if (detectedType === 'select') {
        const selected = await this.selectOption(field.target, String(field.value))
        filled.push({ target: field.target, type: 'select', value: selected })
      } else if (detectedType === 'checkbox') {
        const desired = field.value === true || String(field.value).toLowerCase() === 'true'
        const el = await this.resolveElement(field.target)
        const current = await this.session
          .send<{ result?: { value?: boolean } }>(
            'Runtime.callFunctionOn',
            {
              objectId: el.objectId,
              functionDeclaration: `function() { return Boolean(this.checked || this.getAttribute?.('aria-checked') === 'true'); }`,
              returnByValue: true,
            },
            { sessionId: el.sessionId },
          )
          .catch(() => null)
        if (Boolean(current?.result?.value) !== desired) {
          await this.click(field.target)
        }
        filled.push({ target: field.target, type: 'checkbox', value: desired })
      } else if (detectedType === 'radio') {
        await this.click(field.target)
        filled.push({ target: field.target, type: 'radio', value: field.value })
      } else {
        await this.fill(field.target, String(field.value))
        filled.push({ target: field.target, type: 'text', value: String(field.value) })
      }
    }
    return { filled }
  }

  /**
   * Displays an interactive in-page Human Handoff card ("Your Turn") and pauses until
   * the user clicks "Done, Continue AI" or "Cancel" inside the browser tab.
   * Works identically in both Chrome Extension mode and Direct CDP mode.
   */
  async requestHumanHandoff(
    message: string,
    options: { timeoutMs?: number } = {},
  ): Promise<HumanHandoffResult> {
    const timeoutMs = options.timeoutMs ?? 300_000
    const start = Date.now()
    const bindingName = '__browserpilotHandoffDone'

    await this.session.ensureBaseDomains()
    await this.session.send('Runtime.addBinding', { name: bindingName }).catch(() => {})
    await this.session.transport
      .setControlBanner?.(this.tabId, { active: true, status: 'Waiting for you...', mode: 'handoff' })
      .catch(() => {})

    let resolveAction!: (action: 'resume' | 'cancel') => void
    const decisionPromise = new Promise<'resume' | 'cancel'>((resolve) => {
      resolveAction = resolve
    })

    const offBinding = this.session.on('Runtime.bindingCalled', (params) => {
      if (params.name !== bindingName) return
      const payload = String(params.payload ?? '')
      resolveAction(payload === 'cancel' ? 'cancel' : 'resume')
    })

    const injectCard = async () => {
      await this.evaluate(`(() => {
        const old = document.getElementById('__browserpilot_handoff_host');
        if (old) old.remove();
        const host = document.createElement('div');
        host.id = '__browserpilot_handoff_host';
        host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = \`
          .bp-edge {
            position: fixed; inset: 0; pointer-events: none;
            box-shadow: inset 0 0 0 3px rgba(245, 158, 11, 0.72), inset 0 0 26px rgba(245, 158, 11, 0.22);
          }
          .bp-card {
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            pointer-events: auto;
            display: flex; align-items: center; gap: 14px; max-width: 560px;
            background: rgba(15, 23, 42, 0.94); color: #f8fafc;
            border: 1px solid rgba(251, 191, 36, 0.55);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            border-radius: 14px; padding: 12px 16px;
            box-shadow: 0 14px 36px rgba(2, 6, 23, 0.45);
            font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .bp-dot {
            width: 10px; height: 10px; border-radius: 999px; flex: none;
            background: #fbbf24; box-shadow: 0 0 10px #f59e0b;
          }
          .bp-msg { flex: 1; color: #f1f5f9; }
          .bp-title { font-weight: 700; font-size: 12px; color: #fcd34d; margin-bottom: 2px; }
          .bp-actions { display: flex; gap: 8px; flex: none; }
          button {
            cursor: pointer; border-radius: 8px; border: 1px solid transparent;
            padding: 7px 12px; font: 600 12px/1 -apple-system, BlinkMacSystemFont, sans-serif;
          }
          .bp-resume { background: linear-gradient(135deg, #2dd4bf, #06b6d4); color: #042f2e; }
          .bp-resume:hover { filter: brightness(1.06); }
          .bp-cancel { background: rgba(148, 163, 184, 0.16); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.3); }
          .bp-cancel:hover { background: rgba(148, 163, 184, 0.28); }
        \`;
        shadow.appendChild(style);
        const edge = document.createElement('div');
        edge.className = 'bp-edge';
        const card = document.createElement('div');
        card.className = 'bp-card';
        const dot = document.createElement('div');
        dot.className = 'bp-dot';
        const msgWrap = document.createElement('div');
        msgWrap.className = 'bp-msg';
        const title = document.createElement('div');
        title.className = 'bp-title';
        title.textContent = 'BrowserPilot · Your Turn';
        const body = document.createElement('div');
        body.textContent = ${JSON.stringify(message)};
        msgWrap.append(title, body);
        const actions = document.createElement('div');
        actions.className = 'bp-actions';
        const btnResume = document.createElement('button');
        btnResume.className = 'bp-resume';
        btnResume.textContent = 'Done, Continue AI';
        btnResume.onclick = () => { globalThis.${bindingName}?.('resume'); host.remove(); };
        const btnCancel = document.createElement('button');
        btnCancel.className = 'bp-cancel';
        btnCancel.textContent = 'Cancel';
        btnCancel.onclick = () => { globalThis.${bindingName}?.('cancel'); host.remove(); };
        actions.append(btnResume, btnCancel);
        card.append(dot, msgWrap, actions);
        shadow.append(edge, card);
        (document.documentElement || document.body).appendChild(host);
      })()`).catch(() => {})
    }

    await injectCard()
    // Re-inject card automatically if the user navigates to another page during manual handoff
    const offLoad = this.session.on('Page.loadEventFired', () => {
      void injectCard()
    })

    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const outcome = await Promise.race([
        decisionPromise,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs)
        }),
      ])
      const meta = await this.getUrlAndTitle().catch(() => ({ url: '', title: '' }))
      return {
        resumed: outcome === 'resume',
        cancelled: outcome === 'cancel',
        timedOut: outcome === 'timeout',
        elapsedMs: Date.now() - start,
        url: meta.url,
        title: meta.title,
      }
    } finally {
      if (timer) clearTimeout(timer)
      offBinding()
      offLoad()
      await this.evaluate(`document.getElementById('__browserpilot_handoff_host')?.remove()`).catch(() => {})
      await this.session.transport
        .setControlBanner?.(this.tabId, { active: true, status: 'Active', mode: 'working' })
        .catch(() => {})
    }
  }

  async keyDown(keyName: string, modifiers = 0): Promise<void> {
    const def = resolveKeyDef(keyName)
    await this.session.send('Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      text: def.text,
      modifiers,
    })
  }

  async keyUp(keyName: string, modifiers = 0): Promise<void> {
    const def = resolveKeyDef(keyName)
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers,
    })
  }

  async selectOption(target: string, valueOrLabel: string): Promise<string> {
    const el = await this.resolveElement(target)
    const res = await this.session.send<{ result?: { value?: string } }>(
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        arguments: [{ value: valueOrLabel }],
        returnByValue: true,
        functionDeclaration: `function(val) {
          const opts = Array.from(this.options || []);
          const match = opts.find((o) => o.value === val || o.text.trim() === val);
          if (!match) throw new Error('Option not found: ' + val);
          this.value = match.value;
          match.selected = true;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return match.value;
        }`,
      },
      { sessionId: el.sessionId },
    )
    return res.result?.value ?? valueOrLabel
  }

  async uploadFiles(target: string, filePaths: string[]): Promise<void> {
    const el = await this.resolveElement(target)
    if (!el.backendNodeId) {
      throw new Error(`Cannot upload files: unable to resolve backendNodeId for ${target}`)
    }
    const absolutePaths = filePaths.map((p) => path.resolve(p))
    await this.session.send(
      'DOM.setFileInputFiles',
      {
        backendNodeId: el.backendNodeId,
        files: absolutePaths,
      },
      { sessionId: el.sessionId },
    )
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.session.send<{
      result?: { value?: T; description?: string; type?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Evaluation error'
      throw new Error(msg)
    }
    return res.result?.value as T
  }

  async screenshot(
    options: ScreenshotOptions = {},
  ): Promise<{
    base64: string
    mimeType: string
    path?: string
    region?: { x: number; y: number; width: number; height: number; scale: number }
  }> {
    const format = options.format ?? 'png'
    const params: Record<string, unknown> = { format }
    if (format !== 'png' && options.quality !== undefined) {
      params.quality = options.quality
    }

    let region: { x: number; y: number; width: number; height: number; scale: number } | undefined

    // Hide BrowserPilot's own UI overlays (glow border, floating pill, highlight, ghost cursor) so screenshots stay clean
    await this.session.transport.setOverlayVisible?.(this.tabId, false).catch(() => {})
    await this.evaluate(`(() => {
      const el = document.getElementById('__browserpilot_ui_host');
      if (el) el.style.visibility = 'hidden';
    })()`).catch(() => {})

    try {
      const metrics = await this.session.send<{
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
        await this.evaluate(`(() => {
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
        })()`).catch(() => {})
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

      const res = await this.session.send<{ data: string }>('Page.captureScreenshot', params)
      let base64 = res.data
      const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'

      // Pure-browser canvas resize if maxDimension requested (zero native sharp dependency!)
      if (options.maxDimension && options.maxDimension > 0) {
        const resized = await this.resizeBase64InPage(base64, mimeType, options.maxDimension, options.quality)
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
        await this.evaluate(`document.getElementById('__browserpilot_grid_overlay')?.remove()`).catch(() => {})
      }
      await this.evaluate(`(() => {
        const el = document.getElementById('__browserpilot_ui_host');
        if (el) el.style.visibility = '';
      })()`).catch(() => {})
      await this.session.transport.setOverlayVisible?.(this.tabId, true).catch(() => {})
    }
  }

  private async resizeBase64InPage(
    base64: string,
    mimeType: string,
    maxDimension: number,
    quality?: number,
  ): Promise<string | null> {
    try {
      const dataUrl = `data:${mimeType};base64,${base64}`
      const res = await this.evaluate<string | null>(`(async () => {
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

  async setViewport(width: number, height: number, deviceScaleFactor = 1, mobile = false): Promise<void> {
    await this.session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    })
  }

  async emulate(options: EmulateOptions): Promise<void> {
    if (options.width && options.height) {
      await this.setViewport(options.width, options.height, options.deviceScaleFactor ?? 1, options.mobile ?? false)
    }
    if (options.userAgent) {
      await this.session.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent })
    }
    if (options.colorScheme) {
      await this.session.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: options.colorScheme }],
      })
    }
    if (options.cpuThrottlingRate !== undefined) {
      await this.session.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottlingRate })
    }
    if (options.networkPreset) {
      await this.session.enableDomain('Network')
      const presets: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
        online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
        offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
        'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
        'fast-3g': { offline: false, latency: 562, downloadThroughput: 180_000, uploadThroughput: 84_000 },
        '4g': { offline: false, latency: 170, downloadThroughput: 1_500_000, uploadThroughput: 750_000 },
      }
      const cfg = presets[options.networkPreset]
      if (cfg) await this.session.send('Network.emulateNetworkConditions', cfg)
    }
    if (options.timezone) {
      await this.session.send('Emulation.setTimezoneOverride', { timezoneId: options.timezone })
    }
    if (options.locale) {
      await this.session.send('Emulation.setLocaleOverride', { locale: options.locale })
    }
    if (options.geolocation) {
      await this.session.send('Emulation.setGeolocationOverride', {
        latitude: options.geolocation.latitude,
        longitude: options.geolocation.longitude,
        accuracy: options.geolocation.accuracy ?? 50,
      })
    }
  }

  // Page-scoped cookie operations (never wipes user's whole browser profile!)
  async getCookies(urls?: string[]): Promise<Array<Record<string, unknown>>> {
    const targetUrls = urls ?? [(await this.getUrlAndTitle()).url].filter((u) => u.startsWith('http'))
    const res = await this.session.send<{ cookies: Array<Record<string, unknown>> }>('Network.getCookies', {
      urls: targetUrls,
    })
    return res.cookies ?? []
  }

  async setCookie(cookie: {
    name: string
    value: string
    url?: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
    expires?: number
  }): Promise<boolean> {
    const params: Record<string, unknown> = { ...cookie }
    if (!params.url && !params.domain) {
      params.url = (await this.getUrlAndTitle()).url
    }
    const res = await this.session.send<{ success?: boolean }>('Network.setCookie', params)
    return res.success !== false
  }

  async deleteCookies(name: string, options: { url?: string; domain?: string; path?: string } = {}): Promise<void> {
    const params: Record<string, unknown> = { name, ...options }
    if (!params.url && !params.domain) {
      params.url = (await this.getUrlAndTitle()).url
    }
    await this.session.send('Network.deleteCookies', params)
  }

  async getStorage(kind: 'local' | 'session'): Promise<Record<string, string>> {
    const api = kind === 'local' ? 'localStorage' : 'sessionStorage'
    return await this.evaluate<Record<string, string>>(`(() => {
      const out = {};
      for (let i = 0; i < ${api}.length; i++) {
        const k = ${api}.key(i);
        if (k !== null) out[k] = ${api}.getItem(k) ?? '';
      }
      return out;
    })()`)
  }

  async setStorage(kind: 'local' | 'session', key: string, value: string): Promise<void> {
    const api = kind === 'local' ? 'localStorage' : 'sessionStorage'
    await this.evaluate(`${api}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`)
  }

  async clearStorage(kind: 'local' | 'session'): Promise<void> {
    const api = kind === 'local' ? 'localStorage' : 'sessionStorage'
    await this.evaluate(`${api}.clear()`)
  }
}
