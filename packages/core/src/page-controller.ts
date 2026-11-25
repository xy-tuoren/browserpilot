import path from 'node:path'
import type { FrameInfo } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import { Locator, STABLE_LOCATOR_FUNCTION } from './locator.js'
import { resolveActionableForClick, resolveElement } from './page/actionability.js'
import { capturePageScreenshot, exportPageToPDF } from './page/capture.js'
import { requestHumanHandoff } from './page/handoff.js'
import { modifierBitmask, PageInputDriver } from './page/input.js'
import type {
  ClickOptions,
  EmulateOptions,
  FileChooserHandle,
  FillOptions,
  FormFieldInput,
  FormFillResult,
  HumanHandoffResult,
  InitScriptEntry,
  KeyModifier,
  MouseButton,
  PdfOptions,
  ResolvedElement,
  ScreenshotOptions,
  ScrollResult,
  WaitForFileChooserOptions,
} from './page/types.js'
import type { SnapshotEngine } from './snapshot.js'
import { sleep, waitForPageLoad, waitForSelector, type WaitSelectorState } from './wait.js'

export type {
  ClickOptions,
  EmulateOptions,
  FileChooserHandle,
  FillOptions,
  FormFieldInput,
  FormFillResult,
  HumanHandoffResult,
  InitScriptEntry,
  KeyModifier,
  MouseButton,
  PdfOptions,
  ResolvedElement,
  ScreenshotOptions,
  ScrollResult,
  WaitForFileChooserOptions,
} from './page/types.js'

/**
 * Pure-CDP Page Controller executing browser-trusted (`isTrusted === true`)
 * interactions, waits, uploads, captures, and context controls without Playwright/Puppeteer.
 */
export class PageController {
  readonly session: TabCDPSession
  readonly snapshotEngine: SnapshotEngine
  private readonly input: PageInputDriver
  private initScripts: InitScriptEntry[] = []

  constructor(session: TabCDPSession, snapshotEngine: SnapshotEngine) {
    this.session = session
    this.snapshotEngine = snapshotEngine
    this.input = new PageInputDriver(session)
  }

  private get actionabilityDeps() {
    return {
      session: this.session,
      snapshotEngine: this.snapshotEngine,
      evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr),
    }
  }

  locator(selector: string): Locator {
    return new Locator(this, selector)
  }

  frameLocator(iframeSelector: string): Locator {
    return new Locator(this, iframeSelector)
  }

  async listFrames(): Promise<FrameInfo[]> {
    return await this.session.listFrames()
  }

  async waitForLocator(
    selector: string,
    options: { state?: WaitSelectorState; timeoutMs?: number; frame?: string } = {},
  ): Promise<boolean> {
    return await waitForSelector(this.session, selector, options)
  }

  get tabId(): number {
    return this.session.tabId
  }

  // ============================================================================
  // Navigation
  // ============================================================================

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

  // ============================================================================
  // Element Resolution & Trusted Interaction
  // ============================================================================

  async resolveElement(
    target: string,
    timeoutMs: number = 8_000,
    options: { allowHidden?: boolean; strict?: boolean } = {},
  ): Promise<ResolvedElement> {
    return await resolveElement(this.actionabilityDeps, target, timeoutMs, options)
  }

  async readElementProperty<T = unknown>(target: string, functionDeclaration: string, timeoutMs = 8_000): Promise<T> {
    const el = await this.resolveElement(target, timeoutMs, { allowHidden: true })
    const res = await this.session.send<{ result?: { value?: T } }>(
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        functionDeclaration,
        returnByValue: true,
      },
      { sessionId: el.sessionId },
    )
    return res.result?.value as T
  }

  async getLocatorString(target: string, timeoutMs = 8_000): Promise<string> {
    return await this.readElementProperty<string>(target, STABLE_LOCATOR_FUNCTION, timeoutMs)
  }

  async click(targetOrCoords: string | { x: number; y: number }, options: ClickOptions = {}): Promise<void> {
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1
    const modifiers = modifierBitmask(options.modifiers)

    let x: number
    let y: number
    let underOwnPill = false
    if (typeof targetOrCoords === 'string') {
      const checked = await resolveActionableForClick(this.actionabilityDeps, targetOrCoords, {
        timeoutMs: options.timeoutMs,
        force: options.force,
        strict: options.strict,
      })
      const el = checked.el
      underOwnPill = checked.underOwnPill
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

  mouseMove(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    return this.input.mouseMove(x, y, options)
  }

  mouseDown(x: number, y: number, opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    return this.input.mouseDown(x, y, opts)
  }

  mouseUp(x: number, y: number, opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    return this.input.mouseUp(x, y, opts)
  }

  mouseClick(x: number, y: number, opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {}): Promise<void> {
    return this.input.mouseClick(x, y, opts)
  }

  wheel(deltaX: number, deltaY: number, pos?: { x: number; y: number }): Promise<void> {
    return this.input.wheel(deltaX, deltaY, pos)
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

  mouseStroke(
    points: Array<{ x: number; y: number }>,
    options: { button?: MouseButton; stepsPerSegment?: number; delayMs?: number } = {},
  ): Promise<void> {
    return this.input.mouseStroke(points, options)
  }

  pressKey(
    combo: string,
    options: { modifiers?: KeyModifier[]; action?: 'press' | 'down' | 'up'; repeat?: number } = {},
  ): Promise<void> {
    return this.input.pressKey(combo, options)
  }

  keyDown(keyName: string, modifiers = 0): Promise<void> {
    return this.input.keyDown(keyName, modifiers)
  }

  keyUp(keyName: string, modifiers = 0): Promise<void> {
    return this.input.keyUp(keyName, modifiers)
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

  async fill(target: string, value: string, options: FillOptions = {}): Promise<void> {
    const resolveBudget = options.timeoutMs ?? 8_000
    const actionBudget = options.timeoutMs ?? 1_500
    const start = Date.now()
    let actionDeadline: number | null = null

    let el!: ResolvedElement
    let editableCheck!: { ok: boolean; reason?: string; isContentEditable?: boolean }

    while (true) {
      const remaining = Math.max(100, resolveBudget - (Date.now() - start))
      el = await this.resolveElement(target, remaining, { strict: options.strict })
      if (options.force) break
      if (actionDeadline === null) actionDeadline = Date.now() + actionBudget

      const stateRes = await this.session
        .send<{ result?: { value?: { ok: boolean; reason?: string; isContentEditable?: boolean } } }>(
          'Runtime.callFunctionOn',
          {
            objectId: el.objectId,
            returnByValue: true,
            functionDeclaration: `function() {
              if (!this.isConnected) return { ok: false, reason: 'detached' };
              if (this.disabled === true || this.getAttribute?.('aria-disabled') === 'true') {
                return { ok: false, reason: 'disabled' };
              }
              if (this.readOnly === true || this.getAttribute?.('aria-readonly') === 'true') {
                return { ok: false, reason: 'readonly' };
              }
              return { ok: true, isContentEditable: Boolean(this.isContentEditable) };
            }`,
          },
          { sessionId: el.sessionId },
        )
        .catch(() => null)

      editableCheck = stateRes?.result?.value ?? { ok: false, reason: 'detached' }
      if (editableCheck.ok) break
      if (Date.now() >= actionDeadline) {
        if (editableCheck.reason === 'disabled') {
          throw new Error(`Element "${target}" is disabled and cannot be filled.`)
        }
        if (editableCheck.reason === 'readonly') {
          throw new Error(`Element "${target}" is read-only and cannot be filled (pass force: true to override).`)
        }
        throw new Error(`Element "${target}" detached from DOM before fill.`)
      }
      await sleep(editableCheck.reason === 'detached' ? 35 : 80)
    }

    await this.session.transport
      .setControlBanner?.(this.tabId, { active: true, status: `Filling ${target}`, mode: 'working' })
      .catch(() => {})
    await this.session.transport.highlightElement?.(this.tabId, el.box, `fill ${target}`).catch(() => {})

    await this.mouseClick(el.center.x, el.center.y)

    const selectAllFn = `function() {
      if (!this.isConnected) return { hadContent: false, isContentEditable: false, connected: false };
      const doc = this.ownerDocument || document;
      const win = doc.defaultView || window;
      if (typeof this.focus === 'function') this.focus();
      const isCE = Boolean(this.isContentEditable);
      let hadContent = false;
      if (${options.clear !== false}) {
        if (!isCE && typeof this.value === 'string') {
          hadContent = this.value.length > 0;
          if (hadContent) {
            try {
              if (typeof this.select === 'function') this.select();
              if (typeof this.setSelectionRange === 'function') {
                this.setSelectionRange(0, this.value.length);
              }
            } catch {}
          }
        } else if (isCE) {
          const rawText = (this.innerText ?? this.textContent ?? '').replace(/\\u200B/g, '');
          hadContent = rawText.replace(/\\n+$/, '').length > 0;
          if (hadContent) {
            const range = doc.createRange();
            range.selectNodeContents(this);
            const sel = win.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }
        }
      }
      return { hadContent, isContentEditable: isCE, connected: true };
    }`

    const selectRes = await this.session
      .send<{ result?: { value?: { hadContent: boolean; isContentEditable: boolean; connected: boolean } } }>(
        'Runtime.callFunctionOn',
        { objectId: el.objectId, returnByValue: true, functionDeclaration: selectAllFn },
        { sessionId: el.sessionId },
      )
      .catch(() => null)

    let selState = selectRes?.result?.value
    if (!selState || !selState.connected) {
      el = await this.resolveElement(target, 2_000, { strict: options.strict })
      const retrySel = await this.session
        .send<{ result?: { value?: { hadContent: boolean; isContentEditable: boolean; connected: boolean } } }>(
          'Runtime.callFunctionOn',
          { objectId: el.objectId, returnByValue: true, functionDeclaration: selectAllFn },
          { sessionId: el.sessionId },
        )
        .catch(() => null)
      selState = retrySel?.result?.value ?? { hadContent: false, isContentEditable: false, connected: true }
    }

    if (options.clear !== false && selState.hadContent) {
      await this.pressKey('Backspace')
    }

    if (value.length > 0) {
      await this.session.send('Input.insertText', { text: value })
    }

    await this.session
      .send(
        'Runtime.callFunctionOn',
        {
          objectId: el.objectId,
          arguments: [{ value }],
          functionDeclaration: `function(expected) {
            if (!this.isConnected) return;
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
    if (target) await this.click(target)
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

  async check(target: string, options: { timeoutMs?: number; force?: boolean } = {}): Promise<boolean> {
    const el = await this.resolveElement(target, options.timeoutMs)
    const res = await this.session
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
    if (res?.result?.value === true) return false
    await this.click(target, { timeoutMs: options.timeoutMs, force: options.force })
    return true
  }

  async uncheck(target: string, options: { timeoutMs?: number; force?: boolean } = {}): Promise<boolean> {
    const el = await this.resolveElement(target, options.timeoutMs)
    const res = await this.session
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
    if (res?.result?.value === false) return false
    await this.click(target, { timeoutMs: options.timeoutMs, force: options.force })
    return true
  }

  async setRangeValue(target: string, value: number | string, timeoutMs?: number): Promise<string> {
    const el = await this.resolveElement(target, timeoutMs)
    const strVal = String(value)
    const res = await this.session.send<{ result?: { value?: string } }>(
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        arguments: [{ value: strVal }],
        returnByValue: true,
        functionDeclaration: `function(val) {
          const tag = (this.tagName || '').toLowerCase();
          if (tag === 'input') {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(this, val);
            else this.value = val;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return this.value;
          }
          this.setAttribute('aria-valuenow', val);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return val;
        }`,
      },
      { sessionId: el.sessionId },
    )
    return res.result?.value ?? strVal
  }

  async fillForm(fields: FormFieldInput[]): Promise<FormFillResult> {
    const filled: FormFillResult['filled'] = []
    for (const field of fields) {
      const kind = field.type ?? 'auto'
      let detectedType = kind
      if (kind === 'auto') {
        const el = await this.resolveElement(field.target, undefined, { allowHidden: true })
        const meta = await this.session
          .send<{ result?: { value?: { tag: string; inputType: string; role: string } } }>(
            'Runtime.callFunctionOn',
            {
              objectId: el.objectId,
              functionDeclaration: `function() { return { tag: (this.tagName || '').toLowerCase(), inputType: (this.type || '').toLowerCase(), role: (this.getAttribute?.('role') || '').toLowerCase() }; }`,
              returnByValue: true,
            },
            { sessionId: el.sessionId },
          )
          .catch(() => null)
        const tag = meta?.result?.value?.tag ?? ''
        const inputType = meta?.result?.value?.inputType ?? ''
        const role = meta?.result?.value?.role ?? ''
        if (tag === 'select') detectedType = 'select'
        else if (inputType === 'checkbox' || role === 'checkbox' || role === 'switch') detectedType = 'checkbox'
        else if (inputType === 'radio' || role === 'radio') detectedType = 'radio'
        else if (inputType === 'range' || role === 'slider') detectedType = 'range'
        else if (inputType === 'file') detectedType = 'file'
        else detectedType = 'text'
      }

      if (detectedType === 'select') {
        const vals = Array.isArray(field.value) ? field.value.map(String) : String(field.value)
        const selected = await this.selectOption(field.target, vals)
        filled.push({ target: field.target, type: 'select', value: selected.length === 1 ? selected[0] : selected })
      } else if (detectedType === 'checkbox') {
        const desired = field.value === true || String(field.value).toLowerCase() === 'true'
        if (desired) await this.check(field.target)
        else await this.uncheck(field.target)
        filled.push({ target: field.target, type: 'checkbox', value: desired })
      } else if (detectedType === 'radio') {
        await this.check(field.target)
        filled.push({ target: field.target, type: 'radio', value: field.value })
      } else if (detectedType === 'range') {
        const applied = await this.setRangeValue(field.target, typeof field.value === 'number' ? field.value : String(field.value))
        filled.push({ target: field.target, type: 'range', value: applied })
      } else if (detectedType === 'file') {
        const paths = Array.isArray(field.value) ? field.value.map(String) : [String(field.value)]
        await this.uploadFiles(field.target, paths)
        filled.push({ target: field.target, type: 'file', value: paths })
      } else {
        await this.fill(field.target, String(field.value))
        filled.push({ target: field.target, type: 'text', value: String(field.value) })
      }
    }
    return { filled }
  }

  async selectOption(target: string, valueOrLabels: string | string[]): Promise<string[]> {
    const el = await this.resolveElement(target)
    const wanted = Array.isArray(valueOrLabels) ? valueOrLabels : [valueOrLabels]
    const res = await this.session.send<{
      result?: { value?: string[] }
      exceptionDetails?: { exception?: { description?: string }; text?: string }
    }>(
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        arguments: [{ value: wanted }],
        returnByValue: true,
        functionDeclaration: `function(vals) {
          const opts = Array.from(this.options || []);
          const selected = [];
          if (this.multiple) {
            for (const o of opts) o.selected = false;
          }
          for (const val of vals) {
            const match = opts.find((o) => o.value === val || o.text.trim() === val);
            if (!match) throw new Error('Option not found: ' + val);
            match.selected = true;
            if (!this.multiple) this.value = match.value;
            selected.push(match.value);
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return selected;
        }`,
      },
      { sessionId: el.sessionId },
    )
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'selectOption failed')
    }
    return res.result?.value ?? wanted
  }

  // ============================================================================
  // File Chooser & Uploads
  // ============================================================================

  async waitForFileChooser(options: WaitForFileChooserOptions = {}): Promise<FileChooserHandle> {
    await this.session.ensureBaseDomains()
    const timeoutMs = options.timeoutMs ?? 15_000

    await this.session.send('Page.setInterceptFileChooserDialog', { enabled: true })

    let cleanedUp = false
    const disableIntercept = async () => {
      if (cleanedUp) return
      cleanedUp = true
      await this.session.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
    }

    const chooserPromise = this.session.once('Page.fileChooserOpened', undefined, timeoutMs)

    try {
      if (options.action) await options.action()
      const ev = await chooserPromise
      const frameId = String(ev.params.frameId ?? '')
      const mode = String(ev.params.mode ?? 'selectSingle')
      const backendNodeId = Number(ev.params.backendNodeId ?? 0)
      if (!backendNodeId) {
        await disableIntercept()
        throw new Error('File chooser opened without a valid backendNodeId')
      }

      const childSessionId =
        ev.sessionId ??
        this.session.getChildSessions().find((c) => c.targetId === frameId)?.sessionId

      const handle: FileChooserHandle = {
        isMultiple: mode === 'selectMultiple',
        frameId,
        backendNodeId,
        setFiles: async (filePaths: string[]) => {
          const absolutePaths = filePaths.map((p) => path.resolve(p))
          try {
            await this.session.send(
              'DOM.setFileInputFiles',
              { backendNodeId, files: absolutePaths },
              { sessionId: childSessionId },
            )
          } finally {
            await disableIntercept()
          }
        },
        cancel: async () => {
          await disableIntercept()
        },
      }

      if (options.files) {
        await handle.setFiles(options.files)
      }
      return handle
    } catch (err) {
      await disableIntercept()
      throw err
    }
  }

  async uploadFiles(target: string, filePaths: string[]): Promise<void> {
    const el = await this.resolveElement(target, undefined, { allowHidden: true })
    const meta = await this.session
      .send<{ result?: { value?: { isFileInput: boolean } } }>(
        'Runtime.callFunctionOn',
        {
          objectId: el.objectId,
          returnByValue: true,
          functionDeclaration: `function() {
            const tag = (this.tagName || '').toLowerCase();
            return { isFileInput: tag === 'input' && (this.type || '').toLowerCase() === 'file' };
          }`,
        },
        { sessionId: el.sessionId },
      )
      .catch(() => null)

    if (meta?.result?.value?.isFileInput) {
      if (!el.backendNodeId) {
        throw new Error(`Cannot upload files: unable to resolve backendNodeId for ${target}`)
      }
      const absolutePaths = filePaths.map((p) => path.resolve(p))
      await this.session.send(
        'DOM.setFileInputFiles',
        { backendNodeId: el.backendNodeId, files: absolutePaths },
        { sessionId: el.sessionId },
      )
      return
    }

    await this.waitForFileChooser({
      action: () => this.click(target),
      files: filePaths,
    })
  }

  // ============================================================================
  // Human Handoff, Capture, PDF & Evaluation
  // ============================================================================

  requestHumanHandoff(message: string, options: { timeoutMs?: number } = {}): Promise<HumanHandoffResult> {
    return requestHumanHandoff(
      {
        session: this.session,
        evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr),
        getUrlAndTitle: () => this.getUrlAndTitle(),
      },
      message,
      options,
    )
  }

  printToPDF(options: PdfOptions = {}): Promise<{ base64: string; path?: string; sizeBytes: number }> {
    return exportPageToPDF(
      { session: this.session, evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr) },
      options,
    )
  }

  screenshot(options: ScreenshotOptions = {}) {
    return capturePageScreenshot(
      { session: this.session, evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr) },
      options,
    )
  }

  async evaluate<T = unknown>(expression: string, options: { frame?: string } = {}): Promise<T> {
    let sessionId: string | undefined
    let contextId: number | undefined
    if (options.frame) {
      const frameCtx = await this.session.resolveFrame(options.frame)
      if (!frameCtx) throw new Error(`Frame not found: ${options.frame}`)
      sessionId = frameCtx.sessionId
      contextId = frameCtx.contextId
    }
    const evalParams: Record<string, unknown> = {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }
    if (contextId !== undefined && !sessionId) evalParams.contextId = contextId

    const res = await this.session.send<{
      result?: { value?: T; description?: string; type?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', evalParams, { sessionId })
    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Evaluation error'
      throw new Error(msg)
    }
    return res.result?.value as T
  }

  // ============================================================================
  // Clipboard, Init Scripts, Permissions, Emulation, Cookies & Storage
  // ============================================================================

  async readClipboard(): Promise<{ text: string; html?: string }> {
    await this.grantPermissions(['clipboardReadWrite']).catch(() => {})
    return await this.evaluate<{ text: string; html?: string }>(`(async () => {
      if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
        try {
          const items = await navigator.clipboard.read();
          let text = '';
          let html;
          for (const item of items) {
            if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
            if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
          }
          if (text || html) return html ? { text, html } : { text };
        } catch {}
      }
      if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
        return { text: await navigator.clipboard.readText() };
      }
      throw new Error('Clipboard API unavailable on this origin (requires HTTPS or localhost)');
    })()`)
  }

  async writeClipboard(text: string, html?: string): Promise<void> {
    await this.grantPermissions(['clipboardReadWrite', 'clipboardSanitizedWrite']).catch(() => {})
    await this.evaluate(`(async () => {
      const plain = ${JSON.stringify(text)};
      const rich = ${html !== undefined ? JSON.stringify(html) : 'null'};
      if (rich && navigator.clipboard && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
        try {
          const item = new ClipboardItem({
            'text/plain': new Blob([plain], { type: 'text/plain' }),
            'text/html': new Blob([rich], { type: 'text/html' }),
          });
          await navigator.clipboard.write([item]);
          return true;
        } catch {}
      }
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(plain);
          return true;
        } catch {}
      }
      const ta = document.createElement('textarea');
      ta.value = plain;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    })()`)
  }

  async addInitScript(script: string, options: { runNow?: boolean } = {}): Promise<InitScriptEntry> {
    await this.session.ensureBaseDomains()
    const res = await this.session.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', {
      source: script,
    })
    const entry: InitScriptEntry = {
      id: res.identifier,
      preview: script.replace(/\s+/g, ' ').trim().slice(0, 100),
      createdAt: Date.now(),
    }
    this.initScripts.push(entry)
    if (options.runNow) await this.evaluate(script).catch(() => {})
    return entry
  }

  async removeInitScript(id: string): Promise<boolean> {
    await this.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })
    const before = this.initScripts.length
    this.initScripts = this.initScripts.filter((s) => s.id !== id)
    return this.initScripts.length < before
  }

  listInitScripts(): InitScriptEntry[] {
    return [...this.initScripts]
  }

  async grantPermissions(permissions: string[], origin?: string): Promise<void> {
    const targetOrigin = origin ?? (await this.evaluate<string>('location.origin').catch(() => ''))
    const map: Record<string, string> = {
      'clipboard-read': 'clipboardReadWrite',
      'clipboard-write': 'clipboardSanitizedWrite',
      camera: 'videoCapture',
      microphone: 'audioCapture',
    }
    const normalized = permissions.map((p) => map[p] ?? p)
    const params: Record<string, unknown> = { permissions: normalized }
    if (targetOrigin && targetOrigin !== 'null') params.origin = targetOrigin
    if (this.session.transport.sendBrowser) {
      await this.session.transport.sendBrowser('Browser.grantPermissions', params)
    } else {
      await this.session.send('Browser.grantPermissions', params)
    }
  }

  async resetPermissions(): Promise<void> {
    if (this.session.transport.sendBrowser) {
      await this.session.transport.sendBrowser('Browser.resetPermissions', {})
    } else {
      await this.session.send('Browser.resetPermissions', {})
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
    if (!params.url && !params.domain) params.url = (await this.getUrlAndTitle()).url
    const res = await this.session.send<{ success?: boolean }>('Network.setCookie', params)
    return res.success !== false
  }

  async deleteCookies(name: string, options: { url?: string; domain?: string; path?: string } = {}): Promise<void> {
    const params: Record<string, unknown> = { name, ...options }
    if (!params.url && !params.domain) params.url = (await this.getUrlAndTitle()).url
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
