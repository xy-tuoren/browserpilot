import type { FrameInfo } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import { Locator, STABLE_LOCATOR_FUNCTION } from './locator.js'
import { resolveActionableForClick, resolveElement } from './page/actionability.js'
import { capturePageScreenshot, exportPageToPDF } from './page/capture.js'
import { findElementsByQuery, type FindElementMatch, type FindElementsOptions } from './page/find.js'
import {
  clearWebStorage,
  deletePageCookies,
  emulatePageEnvironment,
  evaluateInPage,
  getPageCookies,
  getWebStorage,
  grantBrowserPermissions,
  PageInitScriptRegistry,
  probeAndScrollPage,
  readPageClipboard,
  resetBrowserPermissions,
  scrollPageUntilTarget,
  setPageCookie,
  setPageViewport,
  setWebStorage,
  writePageClipboard,
} from './page/context.js'
import {
  fillElement,
  fillFormFields,
  selectDropdownOption,
  setCheckboxState,
  setRangeInputValue,
  typeIntoElement,
  uploadElementFiles,
  waitForPageFileChooser,
  type PageFormsDeps,
} from './page/forms.js'
import { requestActionApproval, requestHumanHandoff, type ActionApprovalResult } from './page/handoff.js'
import { modifierBitmask, PageInputDriver } from './page/input.js'
import type {
  ClickOptions,
  DragOptions,
  EmulateOptions,
  FileChooserHandle,
  FillOptions,
  FormFieldInput,
  FormFillResult,
  HumanHandoffResult,
  InitScriptEntry,
  KeyModifier,
  MouseButton,
  PageActionReadyMeta,
  PageActionTraceInput,
  PageTraceHook,
  PdfOptions,
  ResolvedElement,
  ScreenshotOptions,
  ScrollResult,
  ScrollUntilOptions,
  ScrollUntilResult,
  SwipeOptions,
  WaitForFileChooserOptions,
} from './page/types.js'
import type { SnapshotEngine } from './snapshot.js'
import { waitForPageLoad, waitForSelector, type WaitSelectorState } from './wait.js'

export type { ActionApprovalResult, FindElementMatch, FindElementsOptions }
export type {
  ClickOptions,
  DragOptions,
  EmulateOptions,
  FileChooserHandle,
  FillOptions,
  FormFieldInput,
  FormFillResult,
  HumanHandoffResult,
  InitScriptEntry,
  KeyModifier,
  MouseButton,
  PageActionReadyMeta,
  PageActionTraceInput,
  PageTraceHook,
  PdfOptions,
  ResolvedElement,
  ScreenshotOptions,
  ScrollResult,
  ScrollUntilOptions,
  ScrollUntilResult,
  SwipeOptions,
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
  private readonly initScripts: PageInitScriptRegistry
  private traceHook?: PageTraceHook
  private gifCaptureHook?: { isRecording: () => boolean; captureFrame: (label: string, point?: { x: number; y: number }) => Promise<unknown> }
  private traceDepth = 0

  constructor(session: TabCDPSession, snapshotEngine: SnapshotEngine) {
    this.session = session
    this.snapshotEngine = snapshotEngine
    this.input = new PageInputDriver(session)
    this.initScripts = new PageInitScriptRegistry(session, <T = unknown>(expr: string) => this.evaluate<T>(expr))
  }

  setTraceHook(hook?: PageTraceHook): void {
    this.traceHook = hook
  }

  setGifHook(
    hook?: { isRecording: () => boolean; captureFrame: (label: string, point?: { x: number; y: number }) => Promise<unknown> },
  ): void {
    this.gifCaptureHook = hook
  }

  private async runTraced<T>(
    input: PageActionTraceInput,
    fn: (markReady: (meta?: PageActionReadyMeta) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const needTrace = this.traceDepth === 0 && Boolean(this.traceHook?.isActive())
    const needGif = this.traceDepth === 0 && Boolean(this.gifCaptureHook?.isRecording())
    if (!needTrace && !needGif) {
      return await fn(async () => {})
    }
    this.traceDepth++
    let capturedPoint = input.point
    const wrappedFn = async (traceMarkReady: (meta?: PageActionReadyMeta) => Promise<void>) => {
      const res = await fn(async (meta) => {
        if (meta?.point) capturedPoint = meta.point
        await traceMarkReady(meta)
      })
      if (needGif) {
        await this.gifCaptureHook?.captureFrame(input.title, capturedPoint).catch(() => {})
      }
      return res
    }
    try {
      if (needTrace && this.traceHook) {
        return await this.traceHook.runStep(input, wrappedFn)
      }
      return await wrappedFn(async () => {})
    } finally {
      this.traceDepth--
    }
  }

  private get actionabilityDeps() {
    return {
      session: this.session,
      snapshotEngine: this.snapshotEngine,
      evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr),
    }
  }

  private get formsDeps(): PageFormsDeps {
    return {
      session: this.session,
      tabId: this.tabId,
      resolveElement: (t, timeout, opts) => this.resolveElement(t, timeout, opts),
      mouseClick: (x, y) => this.mouseClick(x, y),
      pressKey: (combo) => this.pressKey(combo),
      click: (target, opts) => this.click(target, opts),
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
    return await this.runTraced(
      { action: 'navigate', title: `navigate ${url}`, value: url, captureBeforeImmediately: true },
      async () => {
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
      },
    )
  }

  async reload(ignoreCache = false): Promise<{ url: string; title: string }> {
    return await this.runTraced(
      { action: 'reload', title: 'reload page', captureBeforeImmediately: true },
      async () => {
        await this.session.ensureBaseDomains()
        const loaded = this.session.once('Page.domContentEventFired', undefined, 20_000).catch(() => null)
        await this.session.send('Page.reload', { ignoreCache })
        await loaded
        return await this.getUrlAndTitle()
      },
    )
  }

  async goBack(): Promise<{ url: string; title: string }> {
    return await this.runTraced(
      { action: 'goBack', title: 'goBack', captureBeforeImmediately: true },
      async () => {
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
      },
    )
  }

  async goForward(): Promise<{ url: string; title: string }> {
    return await this.runTraced(
      { action: 'goForward', title: 'goForward', captureBeforeImmediately: true },
      async () => {
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
      },
    )
  }

  // ============================================================================
  // Element Resolution & Trusted Mouse / Keyboard Interaction
  // ============================================================================

  async resolveElement(
    target: string,
    timeoutMs: number = 8_000,
    options: { allowHidden?: boolean; strict?: boolean } = {},
  ): Promise<ResolvedElement> {
    return await resolveElement(this.actionabilityDeps, target, timeoutMs, options)
  }

  async find(query: string, options: FindElementsOptions = {}): Promise<FindElementMatch[]> {
    return await findElementsByQuery(this.actionabilityDeps, query, options)
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
    const actionName = clickCount >= 2 ? 'dblclick' : button === 'right' ? 'rightClick' : 'click'
    const label =
      typeof targetOrCoords === 'string'
        ? targetOrCoords
        : `(${Math.round(targetOrCoords.x)}, ${Math.round(targetOrCoords.y)})`

    await this.runTraced(
      {
        action: actionName,
        title: `${actionName} ${label}`,
        ...(typeof targetOrCoords === 'string' ? { target: targetOrCoords } : { point: targetOrCoords }),
      },
      async (markReady) => {
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
          await markReady({ box: el.box, point: el.center })
          void this.session.transport
            .setControlBanner?.(this.tabId, { active: true, status: `Clicking ${targetOrCoords}`, mode: 'working' })
            .catch(() => {})
          void this.session.transport.highlightElement?.(this.tabId, el.box, `click ${targetOrCoords}`).catch(() => {})
        } else {
          x = targetOrCoords.x
          y = targetOrCoords.y
          await markReady({ point: { x, y } })
          void this.session.transport
            .setControlBanner?.(this.tabId, {
              active: true,
              status: `Clicking (${Math.round(x)}, ${Math.round(y)})`,
              mode: 'working',
            })
            .catch(() => {})
        }

        if (underOwnPill) {
          await this.evaluate(
            `(() => { const h = document.getElementById('__browserpilot_ui_host'); if (h) h.style.display = 'none'; })()`,
          ).catch(() => {})
        }
        try {
          await this.mouseClick(x, y, { button, clickCount, modifiers })
        } finally {
          if (underOwnPill) {
            await this.evaluate(
              `(() => { const h = document.getElementById('__browserpilot_ui_host'); if (h) h.style.display = ''; })()`,
            ).catch(() => {})
          }
        }
      },
    )
  }

  async dblclick(targetOrCoords: string | { x: number; y: number }): Promise<void> {
    await this.click(targetOrCoords, { clickCount: 2 })
  }

  async rightClick(targetOrCoords: string | { x: number; y: number }): Promise<void> {
    await this.click(targetOrCoords, { button: 'right' })
  }

  async hover(targetOrCoords: string | { x: number; y: number }, timeoutMs?: number): Promise<void> {
    const label =
      typeof targetOrCoords === 'string'
        ? targetOrCoords
        : `(${Math.round(targetOrCoords.x)}, ${Math.round(targetOrCoords.y)})`
    await this.runTraced(
      {
        action: 'hover',
        title: `hover ${label}`,
        ...(typeof targetOrCoords === 'string' ? { target: targetOrCoords } : { point: targetOrCoords }),
      },
      async (markReady) => {
        let x: number
        let y: number
        if (typeof targetOrCoords === 'string') {
          const el = await this.resolveElement(targetOrCoords, timeoutMs)
          x = el.center.x
          y = el.center.y
          await markReady({ box: el.box, point: el.center })
          void this.session.transport.highlightElement?.(this.tabId, el.box, `hover ${targetOrCoords}`).catch(() => {})
        } else {
          x = targetOrCoords.x
          y = targetOrCoords.y
          await markReady({ point: { x, y } })
        }
        await this.mouseMove(x, y)
      },
    )
  }

  mouseMove(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    return this.input.mouseMove(x, y, options)
  }

  mouseDown(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    return this.input.mouseDown(x, y, opts)
  }

  mouseUp(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    return this.input.mouseUp(x, y, opts)
  }

  mouseClick(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    return this.input.mouseClick(x, y, opts)
  }

  wheel(deltaX: number, deltaY: number, pos?: { x: number; y: number }): Promise<void> {
    return this.input.wheel(deltaX, deltaY, pos)
  }

  async drag(
    from: string | { x: number; y: number },
    to: string | { x: number; y: number },
    options: DragOptions = {},
  ): Promise<void> {
    const mode = options.mode ?? 'auto'
    const startEl = typeof from === 'string' ? await this.resolveElement(from) : null
    const endEl = typeof to === 'string' ? await this.resolveElement(to) : null
    const start = startEl ? startEl.center : (from as { x: number; y: number })
    const end = endEl ? endEl.center : (to as { x: number; y: number })

    let useHtml5 = mode === 'html5'
    if (mode === 'auto') {
      const checkDraggable = await this.evaluate<boolean>(
        `(() => {
          const el = document.elementFromPoint(${Math.round(start.x)}, ${Math.round(start.y)});
          if (!el) return false;
          const d = el.closest?.('[draggable="true"]');
          return Boolean(d || el.draggable === true);
        })()`,
      ).catch(() => false)
      useHtml5 = Boolean(checkDraggable)
    }

    if (useHtml5) {
      await this.mouseMove(start.x, start.y)
      await this.evaluate(
        `(() => {
          const sx = ${Math.round(start.x)}, sy = ${Math.round(start.y)};
          const ex = ${Math.round(end.x)}, ey = ${Math.round(end.y)};
          const rawSrc = document.elementFromPoint(sx, sy);
          const src = rawSrc?.closest?.('[draggable="true"]') || rawSrc;
          const dst = document.elementFromPoint(ex, ey);
          if (!src || !dst) return false;
          const dt = new DataTransfer();
          const fire = (target, type, x, y) => {
            const ev = new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              composed: true,
              clientX: x,
              clientY: y,
              dataTransfer: dt,
            });
            target.dispatchEvent(ev);
          };
          fire(src, 'dragstart', sx, sy);
          fire(dst, 'dragenter', ex, ey);
          fire(dst, 'dragover', ex, ey);
          fire(dst, 'drop', ex, ey);
          fire(src, 'dragend', ex, ey);
          return true;
        })()`,
      )
      await this.mouseMove(end.x, end.y, { steps: Math.min(6, options.steps ?? 6) })
      return
    }

    await this.mouseMove(start.x, start.y)
    await this.mouseDown(start.x, start.y)
    await this.mouseMove(end.x, end.y, { steps: options.steps ?? 12 })
    await this.mouseUp(end.x, end.y)
  }

  async tap(targetOrCoords: string | { x: number; y: number }, timeoutMs?: number): Promise<void> {
    const label =
      typeof targetOrCoords === 'string'
        ? targetOrCoords
        : `(${Math.round(targetOrCoords.x)}, ${Math.round(targetOrCoords.y)})`
    await this.runTraced(
      {
        action: 'tap',
        title: `tap ${label}`,
        ...(typeof targetOrCoords === 'string' ? { target: targetOrCoords } : { point: targetOrCoords }),
      },
      async (markReady) => {
        if (typeof targetOrCoords === 'string') {
          const el = await this.resolveElement(targetOrCoords, timeoutMs)
          await markReady({ box: el.box, point: el.center })
          await this.input.touchTap(el.center.x, el.center.y)
        } else {
          await markReady({ point: targetOrCoords })
          await this.input.touchTap(targetOrCoords.x, targetOrCoords.y)
        }
      },
    )
  }

  async swipe(
    from: string | { x: number; y: number },
    to: string | { x: number; y: number },
    options: SwipeOptions = {},
  ): Promise<void> {
    const start = typeof from === 'string' ? (await this.resolveElement(from)).center : from
    const end = typeof to === 'string' ? (await this.resolveElement(to)).center : to
    await this.runTraced(
      {
        action: 'swipe',
        title: `swipe (${Math.round(start.x)},${Math.round(start.y)}) -> (${Math.round(end.x)},${Math.round(end.y)})`,
        point: start,
      },
      async () => {
        await this.input.touchSwipe(start, end, options)
      },
    )
  }

  scrollUntil(target: string, options: ScrollUntilOptions = {}): Promise<ScrollUntilResult> {
    return scrollPageUntilTarget(
      {
        resolveTargetNow: async (sel) => {
          try {
            return await this.resolveElement(sel, 220)
          } catch {
            return null
          }
        },
        scroll: (opts) => this.scroll(opts),
      },
      target,
      options,
    )
  }

  mouseStroke(
    points: Array<{ x: number; y: number }>,
    options: { button?: MouseButton; stepsPerSegment?: number; delayMs?: number } = {},
  ): Promise<void> {
    return this.input.mouseStroke(points, options)
  }

  async pressKey(
    combo: string,
    options: { modifiers?: KeyModifier[]; action?: 'press' | 'down' | 'up'; repeat?: number } = {},
  ): Promise<void> {
    await this.runTraced(
      { action: 'pressKey', title: `pressKey ${combo}`, key: combo, captureBeforeImmediately: true },
      async () => {
        await this.input.pressKey(combo, options)
      },
    )
  }

  keyDown(keyName: string, modifiers = 0): Promise<void> {
    return this.input.keyDown(keyName, modifiers)
  }

  keyUp(keyName: string, modifiers = 0): Promise<void> {
    return this.input.keyUp(keyName, modifiers)
  }

  scroll(options: {
    target?: string
    deltaX?: number
    deltaY?: number
    direction?: 'up' | 'down' | 'left' | 'right'
    amount?: number
  }): Promise<ScrollResult> {
    return probeAndScrollPage(
      {
        session: this.session,
        tabId: this.tabId,
        evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr),
        resolveElement: (target) => this.resolveElement(target),
        wheel: (dx, dy, pos) => this.wheel(dx, dy, pos),
      },
      options,
    )
  }

  // ============================================================================
  // Forms, Inputs, Checkboxes, Selects & File Uploads
  // ============================================================================

  async fill(target: string, value: string, options: FillOptions = {}): Promise<void> {
    const preview = /password|passwd|pwd|secret|token/i.test(target)
      ? '<REDACTED>'
      : value.length > 40
        ? `${value.slice(0, 40)}…`
        : value
    await this.runTraced(
      { action: 'fill', title: `fill ${target} = ${JSON.stringify(preview)}`, target, value },
      (markReady) => fillElement(this.formsDeps, target, value, options, markReady),
    )
  }

  async type(target: string | null, text: string, options: { delayMs?: number } = {}): Promise<void> {
    await this.runTraced(
      {
        action: 'type',
        title: target ? `type ${target}` : 'type keyboard',
        ...(target ? { target } : {}),
        value: text,
        captureBeforeImmediately: !target,
      },
      (markReady) => typeIntoElement(this.formsDeps, target, text, options, markReady),
    )
  }

  async check(target: string, options: { timeoutMs?: number; force?: boolean } = {}): Promise<boolean> {
    return await this.runTraced({ action: 'check', title: `check ${target}`, target }, (markReady) =>
      setCheckboxState(this.formsDeps, target, true, options, markReady),
    )
  }

  async uncheck(target: string, options: { timeoutMs?: number; force?: boolean } = {}): Promise<boolean> {
    return await this.runTraced({ action: 'uncheck', title: `uncheck ${target}`, target }, (markReady) =>
      setCheckboxState(this.formsDeps, target, false, options, markReady),
    )
  }

  setRangeValue(target: string, value: number | string, timeoutMs?: number): Promise<string> {
    return setRangeInputValue(this.formsDeps, target, value, timeoutMs)
  }

  fillForm(fields: FormFieldInput[]): Promise<FormFillResult> {
    return fillFormFields(
      {
        ...this.formsDeps,
        fill: (t, v) => this.fill(t, v),
        check: (t) => this.check(t),
        uncheck: (t) => this.uncheck(t),
        selectOption: (t, vals) => this.selectOption(t, vals),
        setRangeValue: (t, val) => this.setRangeValue(t, val),
        uploadFiles: (t, paths) => this.uploadFiles(t, paths),
      },
      fields,
    )
  }

  async selectOption(target: string, valueOrLabels: string | string[]): Promise<string[]> {
    const wanted = Array.isArray(valueOrLabels) ? valueOrLabels : [valueOrLabels]
    return await this.runTraced(
      {
        action: 'selectOption',
        title: `selectOption ${target} = ${JSON.stringify(wanted.join(','))}`,
        target,
        value: wanted.join(','),
      },
      (markReady) => selectDropdownOption(this.formsDeps, target, wanted, markReady),
    )
  }

  waitForFileChooser(options: WaitForFileChooserOptions = {}): Promise<FileChooserHandle> {
    return waitForPageFileChooser(this.session, options)
  }

  uploadFiles(target: string, filePaths: string[]): Promise<void> {
    return uploadElementFiles(this.formsDeps, target, filePaths)
  }

  // ============================================================================
  // Human Handoff, Capture, PDF & Evaluation
  // ============================================================================

  requestHumanHandoff(message: string, options: { timeoutMs?: number; language?: 'zh' | 'en' } = {}): Promise<HumanHandoffResult> {
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

  requestActionApproval(options: {
    action: string
    detail: string
    reason?: string
    timeoutMs?: number
    language?: 'zh' | 'en'
  }): Promise<ActionApprovalResult> {
    return requestActionApproval(
      {
        session: this.session,
        evaluate: <T = unknown>(expr: string) => this.evaluate<T>(expr),
        getUrlAndTitle: () => this.getUrlAndTitle(),
      },
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

  evaluate<T = unknown>(expression: string, options: { frame?: string } = {}): Promise<T> {
    return evaluateInPage<T>(this.session, expression, options)
  }

  // ============================================================================
  // Clipboard, Init Scripts, Permissions, Emulation, Cookies & Storage
  // ============================================================================

  readClipboard(): Promise<{ text: string; html?: string }> {
    return readPageClipboard(this.session, <T = unknown>(expr: string) => this.evaluate<T>(expr))
  }

  writeClipboard(text: string, html?: string): Promise<void> {
    return writePageClipboard(this.session, <T = unknown>(expr: string) => this.evaluate<T>(expr), text, html)
  }

  addInitScript(script: string, options: { runNow?: boolean } = {}): Promise<InitScriptEntry> {
    return this.initScripts.add(script, options)
  }

  removeInitScript(id: string): Promise<boolean> {
    return this.initScripts.remove(id)
  }

  listInitScripts(): InitScriptEntry[] {
    return this.initScripts.list()
  }

  grantPermissions(permissions: string[], origin?: string): Promise<void> {
    return grantBrowserPermissions(
      this.session,
      <T = unknown>(expr: string) => this.evaluate<T>(expr),
      permissions,
      origin,
    )
  }

  resetPermissions(): Promise<void> {
    return resetBrowserPermissions(this.session)
  }

  setViewport(width: number, height: number, deviceScaleFactor = 1, mobile = false): Promise<void> {
    return setPageViewport(this.session, width, height, deviceScaleFactor, mobile)
  }

  emulate(options: EmulateOptions): Promise<void> {
    return emulatePageEnvironment(this.session, options)
  }

  getCookies(urls?: string[]): Promise<Array<Record<string, unknown>>> {
    return getPageCookies(this.session, () => this.getUrlAndTitle(), urls)
  }

  setCookie(cookie: {
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
    return setPageCookie(this.session, () => this.getUrlAndTitle(), cookie)
  }

  deleteCookies(name: string, options: { url?: string; domain?: string; path?: string } = {}): Promise<void> {
    return deletePageCookies(this.session, () => this.getUrlAndTitle(), name, options)
  }

  getStorage(kind: 'local' | 'session'): Promise<Record<string, string>> {
    return getWebStorage(<T = unknown>(expr: string) => this.evaluate<T>(expr), kind)
  }

  setStorage(kind: 'local' | 'session', key: string, value: string): Promise<void> {
    return setWebStorage(<T = unknown>(expr: string) => this.evaluate<T>(expr), kind, key, value)
  }

  clearStorage(kind: 'local' | 'session'): Promise<void> {
    return clearWebStorage(<T = unknown>(expr: string) => this.evaluate<T>(expr), kind)
  }
}
