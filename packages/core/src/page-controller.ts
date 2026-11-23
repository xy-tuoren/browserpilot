import fs from 'node:fs/promises'
import path from 'node:path'
import type { BoundingBox } from '@devpilot/protocol'
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
}

export interface ScreenshotOptions {
  path?: string
  fullPage?: boolean
  format?: 'png' | 'jpeg' | 'webp'
  quality?: number
  clip?: BoundingBox
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
        if (sessionId && refTarget?.frameId) {
          const frameOffset = await this.getIframeOffset(refTarget.frameId)
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

  private async getIframeOffset(frameId: string): Promise<{ x: number; y: number }> {
    try {
      const owner = await this.session.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId })
      if (!owner.backendNodeId) return { x: 0, y: 0 }
      const box = await this.session.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', {
        backendNodeId: owner.backendNodeId,
      })
      const c = box.model?.content
      if (c && c.length >= 2) return { x: c[0], y: c[1] }
    } catch {
      // fallback
    }
    return { x: 0, y: 0 }
  }

  private async queryElementObjectId(selector: string): Promise<string | undefined> {
    // Support text=..., role=..., and standard CSS selectors (including Shadow DOM fallback)
    const expr = selector.startsWith('text=')
      ? `(() => {
          const needle = ${JSON.stringify(selector.slice(5))}.trim().toLowerCase();
          function walk(root) {
            const els = root.querySelectorAll('*');
            let best = null;
            for (const el of els) {
              if (el.shadowRoot) { const hit = walk(el.shadowRoot); if (hit) return hit; }
              const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
              if (txt === needle) return el;
              if (!best && txt.includes(needle) && el.children.length === 0) best = el;
            }
            return best;
          }
          return walk(document);
        })()`
      : `(() => {
          const sel = ${JSON.stringify(selector)};
          const direct = document.querySelector(sel);
          if (direct) return direct;
          // Deep search open shadow roots
          function walkShadow(root) {
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) {
                const hit = el.shadowRoot.querySelector(sel) || walkShadow(el.shadowRoot);
                if (hit) return hit;
              }
            }
            return null;
          }
          return walkShadow(document);
        })()`

    const res = await this.session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: expr,
      returnByValue: false,
    })
    return res.result?.objectId
  }

  async click(targetOrCoords: string | { x: number; y: number }, options: ClickOptions = {}): Promise<void> {
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1
    const modifiers = modifierBitmask(options.modifiers)

    let x: number
    let y: number
    if (typeof targetOrCoords === 'string') {
      const el = await this.resolveElement(targetOrCoords, options.timeoutMs)
      x = el.center.x
      y = el.center.y
      await this.session.transport.highlightElement?.(this.tabId, el.box, `click ${targetOrCoords}`).catch(() => {})
    } else {
      x = targetOrCoords.x
      y = targetOrCoords.y
    }

    await this.mouseClick(x, y, { button, clickCount, modifiers })
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
      const cx = startX + ((x - startX) * i) / steps
      const cy = startY + ((y - startY) * i) / steps
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cx,
        y: cy,
      })
      if (steps > 1) await sleep(12)
    }
    this.lastMousePos = { x, y }
    await this.session.transport.moveGhostCursor?.(this.tabId, x, y, false).catch(() => {})
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
    await this.mouseMove(x, y)
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
  }): Promise<void> {
    const amount = options.amount ?? 500
    let dx = options.deltaX ?? 0
    let dy = options.deltaY ?? 0
    if (options.direction === 'down') dy = amount
    else if (options.direction === 'up') dy = -amount
    else if (options.direction === 'right') dx = amount
    else if (options.direction === 'left') dx = -amount

    if (options.target) {
      const el = await this.resolveElement(options.target)
      if (dx === 0 && dy === 0) return // already scrolled into view
      await this.wheel(dx, dy, el.center)
    } else {
      await this.wheel(dx, dy, { x: 400, y: 300 })
    }
  }

  /**
   * Focuses element, clears existing value, and inserts text via trusted CDP Input.insertText.
   * Works cleanly with React/Vue controlled inputs, textareas, and contenteditable elements.
   */
  async fill(target: string, value: string, options: { clear?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const el = await this.resolveElement(target, options.timeoutMs)
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

    for (const m of mods) await this.keyDown(m)
    await this.session.send('Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      text: def.text,
      unmodifiedText: def.text,
      modifiers: mask,
    })
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers: mask,
    })
    for (const m of [...mods].reverse()) await this.keyUp(m)
  }

  async keyDown(keyName: string): Promise<void> {
    const def = resolveKeyDef(keyName)
    await this.session.send('Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      text: def.text,
    })
  }

  async keyUp(keyName: string): Promise<void> {
    const def = resolveKeyDef(keyName)
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
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

  async screenshot(options: ScreenshotOptions = {}): Promise<{ base64: string; mimeType: string; path?: string }> {
    const format = options.format ?? 'png'
    const params: Record<string, unknown> = { format }
    if (format !== 'png' && options.quality !== undefined) {
      params.quality = options.quality
    }

    if (options.clip) {
      params.clip = { ...options.clip, scale: 1 }
    } else if (options.fullPage) {
      const metrics = await this.session.send<{
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
      }>('Page.getLayoutMetrics')
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 1280, height: 720 }
      params.clip = {
        x: 0,
        y: 0,
        width: size.width,
        height: Math.min(size.height, 16_384),
        scale: 1,
      }
      params.captureBeyondViewport = true
    } else {
      // Capture at CSS scale (1x) to avoid huge Retina 2x/3x images
      const metrics = await this.session.send<{
        cssVisualViewport?: { pageX: number; pageY: number; clientWidth: number; clientHeight: number }
      }>('Page.getLayoutMetrics')
      if (metrics.cssVisualViewport) {
        params.clip = {
          x: metrics.cssVisualViewport.pageX,
          y: metrics.cssVisualViewport.pageY,
          width: metrics.cssVisualViewport.clientWidth,
          height: metrics.cssVisualViewport.clientHeight,
          scale: 1,
        }
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
      return { base64, mimeType, path: absPath }
    }

    return { base64, mimeType }
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
