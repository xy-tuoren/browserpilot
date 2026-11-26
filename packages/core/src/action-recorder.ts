import {
  compileRecordingArtifacts,
   compressRecordedSteps,
  computeStableDomSelector,
  type ActionRecordingResult,
  type RecordedStep,
} from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

const BINDING_NAME = '__browserpilotRecordEvent'

export function buildCaptureScript(maskPasswords: boolean): string {
  return `(() => {
    if (globalThis.__bpActionRecorderInstalled) {
      globalThis.__bpActionRecorderEnabled = true;
      return;
    }
    globalThis.__bpActionRecorderInstalled = true;
    globalThis.__bpActionRecorderEnabled = true;
    globalThis.__bpAssertMode = Boolean(globalThis.__bpAssertMode);

    const pendingInputs = new Map();
    const lastEmittedValue = new WeakMap();
    const stableSelector = ${computeStableDomSelector.toString()};

    function isElem(node) {
      return Boolean(node && typeof node === 'object' && node.nodeType === 1);
    }

    function emit(payload) {
      if (!globalThis.__bpActionRecorderEnabled) return;
      if (typeof globalThis.${BINDING_NAME} === 'function') {
        try { globalThis.${BINDING_NAME}(JSON.stringify(payload)); } catch {}
      }
    }

    function interactiveTarget(raw) {
      if (!isElem(raw)) return null;
      return raw.closest('button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [contenteditable="true"], label') || raw;
    }

    function recordInputNow(el) {
      if (!isElem(el)) return;
      const tag = el.tagName.toLowerCase();
      const sel = stableSelector(el);
      if (tag === 'select') {
        const sVal = String(el.value ?? '');
        if (lastEmittedValue.get(el) === sVal) return;
        lastEmittedValue.set(el, sVal);
        emit({ action: 'select_option', url: location.href, target: sel, value: sVal });
        return;
      }
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        return;
      }
      const isPassword = ${maskPasswords} && tag === 'input' && el.type === 'password';
      const val = el.isContentEditable ? (el.innerText || '') : (el.value || '');
      const masked = isPassword ? '<REDACTED_PASSWORD>' : val;
      if (lastEmittedValue.get(el) === masked) return;
      lastEmittedValue.set(el, masked);
      emit({
        action: 'fill',
        url: location.href,
        target: sel,
        value: masked,
      });
    }

    function flushPendingInputs() {
      for (const [el, timer] of pendingInputs.entries()) {
        clearTimeout(timer);
        pendingInputs.delete(el);
        recordInputNow(el);
      }
    }
    globalThis.__bpFlushRecordedInputs = flushPendingInputs;

    function attachListeners(doc) {
      if (!doc || doc.__bpListenersBound) return;
      doc.__bpListenersBound = true;

      doc.addEventListener('click', (e) => {
        if (!globalThis.__bpActionRecorderEnabled) return;
        const rawTarget = e.composedPath ? e.composedPath()[0] : e.target;
        if (isElem(rawTarget) && rawTarget.closest && rawTarget.closest('#__browserpilot_ui_host')) return;
        const el = interactiveTarget(isElem(rawTarget) ? rawTarget : e.target);
        if (!el) return;

        flushPendingInputs();

        // Alt+Shift+Click or active Assert Mode records an assertion without triggering navigation
        if ((e.altKey && e.shiftKey) || globalThis.__bpAssertMode) {
          e.preventDefault();
          e.stopPropagation();
          globalThis.__bpAssertMode = false;
          const sel = stableSelector(el);
          const tag = el.tagName.toLowerCase();
          if ((tag === 'input' || tag === 'textarea' || tag === 'select') && typeof el.value === 'string') {
            emit({ action: 'assert_value', url: location.href, target: sel, value: el.value });
          } else {
            const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
            if (txt) {
              emit({ action: 'assert_text', url: location.href, target: sel, value: txt, text: txt });
            } else {
              emit({ action: 'assert_visible', url: location.href, target: sel });
            }
          }
          return;
        }

        const tag = el.tagName.toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        const sel = stableSelector(el);

        // Checkbox / switch state transitions
        if ((tag === 'input' && el.type === 'checkbox') || role === 'checkbox' || role === 'switch') {
          const checked = tag === 'input' ? Boolean(el.checked) : el.getAttribute('aria-checked') !== 'true';
          emit({
            action: checked ? 'check' : 'uncheck',
            url: location.href,
            target: sel,
            coordinates: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
          });
          return;
        }

        emit({
          action: 'click',
          url: location.href,
          target: sel,
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) || undefined,
          coordinates: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
        });
      }, true);

      doc.addEventListener('dblclick', (e) => {
        if (!globalThis.__bpActionRecorderEnabled) return;
        const rawTarget = e.composedPath ? e.composedPath()[0] : e.target;
        const el = interactiveTarget(isElem(rawTarget) ? rawTarget : e.target);
        if (!el) return;
        flushPendingInputs();
        emit({
          action: 'dblclick',
          url: location.href,
          target: stableSelector(el),
          text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) || undefined,
          coordinates: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
        });
      }, true);

      doc.addEventListener('input', (e) => {
        if (!globalThis.__bpActionRecorderEnabled) return;
        const rawTarget = e.composedPath ? e.composedPath()[0] : e.target;
        const el = isElem(rawTarget) ? rawTarget : e.target;
        if (!isElem(el)) return;
        const prev = pendingInputs.get(el);
        if (prev) clearTimeout(prev);
        pendingInputs.set(el, setTimeout(() => {
          pendingInputs.delete(el);
          recordInputNow(el);
        }, 300));
      }, true);

      doc.addEventListener('change', (e) => {
        if (!globalThis.__bpActionRecorderEnabled) return;
        const rawTarget = e.composedPath ? e.composedPath()[0] : e.target;
        const el = isElem(rawTarget) ? rawTarget : e.target;
        if (!isElem(el)) return;
        const prev = pendingInputs.get(el);
        if (prev) {
          clearTimeout(prev);
          pendingInputs.delete(el);
        }
        recordInputNow(el);
      }, true);

      doc.addEventListener('keydown', (e) => {
        if (!globalThis.__bpActionRecorderEnabled) return;
        if (['Enter', 'Escape'].includes(e.key)) {
          flushPendingInputs();
          emit({ action: 'press_key', url: location.href, key: e.key });
        }
      }, true);
    }

    attachListeners(document);

    // Also attach to accessible same-origin iframes (present and dynamically added)
    function bindSameOriginIframes() {
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) attachListeners(frame.contentDocument);
          if (!frame.__bpLoadHooked) {
            frame.__bpLoadHooked = true;
            frame.addEventListener('load', () => {
              try { if (frame.contentDocument) attachListeners(frame.contentDocument); } catch {}
            });
          }
        } catch {}
      }
    }
    bindSameOriginIframes();
    const mo = new MutationObserver(() => bindSameOriginIframes());
    if (document.documentElement) {
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }

    let lastScrollY = Math.round(window.scrollY || 0);
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
      if (!globalThis.__bpActionRecorderEnabled) return;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const curY = Math.round(window.scrollY || 0);
        const delta = curY - lastScrollY;
        if (Math.abs(delta) >= 200) {
          emit({ action: 'scroll', url: location.href, value: String(delta) });
          lastScrollY = curY;
        }
      }, 300);
    }, { passive: true });
  })()`
}

export function buildActionRecordingResult(
  rawSteps: RecordedStep[],
  durationMs: number,
  extras?: {
    apiCalls?: Array<{ timestamp: number; method: string; url: string; status?: number }>
    errors?: Array<{ timestamp: number; kind: 'console' | 'exception' | 'dialog'; text: string }>
  },
): ActionRecordingResult {
  return compileRecordingArtifacts(rawSteps, durationMs, extras)
}

/**
 * Records live user interactions (clicks, dblclicks, checks, fills, selects, keys, scrolls,
 * navigations, and assertions) across Shadow DOM & same-origin iframes, plus concurrent
 * XHR/Fetch API calls, dialogs, and uncaught exceptions.
 */
export class ActionRecorder {
  private readonly session: TabCDPSession
  private recording = false
  private startedAt = 0
  private steps: RecordedStep[] = []
  private apiCalls: Array<{ timestamp: number; method: string; url: string; status?: number }> = []
  private errors: Array<{ timestamp: number; kind: 'console' | 'exception' | 'dialog'; text: string }> = []
  private pendingReqMethods = new Map<string, string>()
  private scriptId: string | null = null
  private unsubs: Array<() => void> = []
  private stepListeners = new Set<(step: RecordedStep, compressed: RecordedStep[]) => void>()

  constructor(session: TabCDPSession) {
    this.session = session
  }

  isRecording(): boolean {
    return this.recording
  }

  getSteps(): RecordedStep[] {
    return compressRecordedSteps(this.steps)
  }

  onStep(listener: (step: RecordedStep, compressed: RecordedStep[]) => void): () => void {
    this.stepListeners.add(listener)
    return () => this.stepListeners.delete(listener)
  }

  deleteStep(index: number): RecordedStep[] {
    const compressed = compressRecordedSteps(this.steps)
    if (index >= 0 && index < compressed.length) {
      compressed.splice(index, 1)
      this.steps = compressed
    }
    return [...this.steps]
  }

  clearSteps(): void {
    this.steps = []
  }

  async setAssertMode(enabled: boolean): Promise<void> {
    await this.session
      .send('Runtime.evaluate', { expression: `globalThis.__bpAssertMode = ${Boolean(enabled)};` })
      .catch(() => {})
  }

  private pushStep(step: RecordedStep): void {
    this.steps.push(step)
    if (this.stepListeners.size > 0) {
      const compressed = compressRecordedSteps(this.steps)
      for (const fn of this.stepListeners) {
        try {
          fn(step, compressed)
        } catch {}
      }
    }
  }

  async start(options: { maskPasswords?: boolean } = {}): Promise<{ startedAt: number; url: string }> {
    if (this.recording) {
      throw new Error('Action recorder is already running on this tab')
    }
    await this.session.ensureBaseDomains()
    const maskPasswords = options.maskPasswords !== false
    this.steps = []
    this.apiCalls = []
    this.errors = []
    this.pendingReqMethods.clear()
    this.startedAt = Date.now()
    this.recording = true

    const initialUrlRes = await this.session.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    })
    const initialUrl = initialUrlRes.result?.value ?? ''
    if (initialUrl && initialUrl !== 'about:blank') {
      this.pushStep({ timestamp: this.startedAt, action: 'navigate', url: initialUrl })
    }

    await this.session.send('Runtime.addBinding', { name: BINDING_NAME })
    const scriptSource = buildCaptureScript(maskPasswords)

    const added = await this.session.send<{ identifier?: string }>('Page.addScriptToEvaluateOnNewDocument', {
      source: scriptSource,
    })
    this.scriptId = added.identifier ?? null

    await this.session.send('Runtime.evaluate', { expression: scriptSource })

    this.unsubs.push(
      this.session.on('Runtime.bindingCalled', (params) => {
        if (!this.recording || params.name !== BINDING_NAME) return
        try {
          const parsed = JSON.parse(String(params.payload ?? '{}')) as Partial<RecordedStep>
          if (!parsed.action) return
          this.pushStep({
            timestamp: Date.now(),
            action: parsed.action,
            url: parsed.url ?? '',
            target: parsed.target,
            value: parsed.value,
            key: parsed.key,
            text: parsed.text,
            coordinates: parsed.coordinates,
          })
        } catch {
          // ignore malformed payload
        }
      }),
      this.session.on('Page.frameNavigated', (params) => {
        if (!this.recording) return
        const frame = params.frame as { parentId?: string; url?: string } | undefined
        if (frame && !frame.parentId && frame.url && frame.url !== 'about:blank') {
          this.pushStep({
            timestamp: Date.now(),
            action: 'navigate',
            url: frame.url,
          })
        }
      }),
      this.session.on('Network.requestWillBeSent', (params) => {
        if (!this.recording) return
        const id = String(params.requestId ?? '')
        const type = String(params.type ?? '')
        const req = params.request as { method?: string } | undefined
        if (id && (type === 'XHR' || type === 'Fetch')) {
          this.pendingReqMethods.set(id, req?.method ?? 'GET')
        }
      }),
      this.session.on('Network.responseReceived', (params) => {
        if (!this.recording) return
        const id = String(params.requestId ?? '')
        const method = this.pendingReqMethods.get(id)
        if (!method) return
        this.pendingReqMethods.delete(id)
        const res = params.response as { url?: string; status?: number } | undefined
        if (res?.url && this.apiCalls.length < 100) {
          this.apiCalls.push({ timestamp: Date.now(), method, url: res.url, status: res.status })
        }
      }),
      this.session.on('Runtime.exceptionThrown', (params) => {
        if (!this.recording || this.errors.length >= 50) return
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        const text = details?.exception?.description ?? details?.text ?? 'Uncaught exception'
        this.errors.push({ timestamp: Date.now(), kind: 'exception', text: text.slice(0, 200) })
      }),
      this.session.on('Page.javascriptDialogOpening', (params) => {
        if (!this.recording || this.errors.length >= 50) return
        this.errors.push({
          timestamp: Date.now(),
          kind: 'dialog',
          text: `${String(params.type ?? 'alert')}: ${String(params.message ?? '').slice(0, 200)}`,
        })
      }),
    )

    return { startedAt: this.startedAt, url: initialUrl }
  }

  async stop(): Promise<ActionRecordingResult> {
    if (!this.recording) {
      throw new Error('Action recorder is not running on this tab')
    }
    // Flush any pending debounced input before disabling
    await this.session
      .send('Runtime.evaluate', {
        expression: 'if (typeof globalThis.__bpFlushRecordedInputs === "function") globalThis.__bpFlushRecordedInputs();',
      })
      .catch(() => {})

    this.recording = false
    const durationMs = Date.now() - this.startedAt

    for (const off of this.unsubs) off()
    this.unsubs = []

    if (this.scriptId) {
      await this.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }).catch(() => {})
      this.scriptId = null
    }
    await this.session
      .send('Runtime.evaluate', { expression: 'globalThis.__bpActionRecorderEnabled = false; globalThis.__bpAssertMode = false;' })
      .catch(() => {})

    return buildActionRecordingResult(this.steps, durationMs, {
      apiCalls: this.apiCalls,
      errors: this.errors,
    })
  }

  dispose(): void {
    this.recording = false
    this.stepListeners.clear()
    for (const off of this.unsubs) off()
    this.unsubs = []
  }
}
