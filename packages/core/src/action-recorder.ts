import type { ActionRecordingResult, RecordedStep } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

const BINDING_NAME = '__browserpilotRecordEvent'

function buildCaptureScript(maskPasswords: boolean): string {
  return `(() => {
    if (globalThis.__bpActionRecorderInstalled) {
      globalThis.__bpActionRecorderEnabled = true;
      return;
    }
    globalThis.__bpActionRecorderInstalled = true;
    globalThis.__bpActionRecorderEnabled = true;

    function emit(payload) {
      if (!globalThis.__bpActionRecorderEnabled) return;
      if (typeof globalThis.${BINDING_NAME} === 'function') {
        try { globalThis.${BINDING_NAME}(JSON.stringify(payload)); } catch {}
      }
    }

    function stableSelector(el) {
      if (!el || !(el instanceof Element)) return '';
      const tid = el.getAttribute('data-testid');
      if (tid) return '[data-testid="' + tid.replace(/"/g, '\\\\"') + '"]';
      if (el.id) return '#' + CSS.escape(el.id);
      const tag = el.tagName.toLowerCase();
      const nameAttr = el.getAttribute('name');
      if (nameAttr) return tag + '[name="' + nameAttr.replace(/"/g, '\\\\"') + '"]';
      const aria = el.getAttribute('aria-label');
      if (aria) return tag + '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
      const ph = el.getAttribute('placeholder');
      if (ph) return 'placeholder=' + ph;
      const role = el.getAttribute('role') || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : '');
      const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (role && text && text.length <= 60) {
        return 'role=' + role + '[name="' + text.replace(/"/g, '\\\\"') + '"]';
      }
      const classes = Array.from(el.classList || []).slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      return tag + classes;
    }

    function interactiveTarget(raw) {
      if (!(raw instanceof Element)) return null;
      return raw.closest('button, a, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], label') || raw;
    }

    document.addEventListener('click', (e) => {
      const el = interactiveTarget(e.target);
      if (!el) return;
      const tag = el.tagName.toLowerCase();
      // Skip redundant click right on text inputs when followed by fill
      emit({
        action: 'click',
        url: location.href,
        target: stableSelector(el),
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) || undefined,
        coordinates: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
        tag,
      });
    }, true);

    const inputTimers = new WeakMap();
    const recordInput = (el) => {
      const tag = el.tagName.toLowerCase();
      const sel = stableSelector(el);
      if (tag === 'select') {
        emit({ action: 'select_option', url: location.href, target: sel, value: el.value });
        return;
      }
      if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
        return; // captured via click
      }
      const isPassword = ${maskPasswords} && tag === 'input' && el.type === 'password';
      const val = el.isContentEditable ? (el.innerText || '') : (el.value || '');
      emit({
        action: 'fill',
        url: location.href,
        target: sel,
        value: isPassword ? '<REDACTED_PASSWORD>' : val,
      });
    };

    document.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      const prev = inputTimers.get(el);
      if (prev) clearTimeout(prev);
      inputTimers.set(el, setTimeout(() => recordInput(el), 350));
    }, true);

    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!(el instanceof Element)) return;
      const prev = inputTimers.get(el);
      if (prev) clearTimeout(prev);
      recordInput(el);
    }, true);

    document.addEventListener('keydown', (e) => {
      if (['Enter', 'Escape', 'Tab'].includes(e.key)) {
        emit({ action: 'press_key', url: location.href, key: e.key });
      }
    }, true);

    let lastScrollY = Math.round(window.scrollY || 0);
    let scrollTimer = null;
    window.addEventListener('scroll', () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const curY = Math.round(window.scrollY || 0);
        const delta = curY - lastScrollY;
        if (Math.abs(delta) >= 180) {
          emit({ action: 'scroll', url: location.href, value: String(delta) });
          lastScrollY = curY;
        }
      }, 300);
    }, { passive: true });
  })()`
}

/**
 * Compresses raw recorded events (collapsing repeated fills on the same input
 * and click-before-fill noise) and renders executable batch steps, JS script,
 * and reusable Agent Skill Markdown.
 */
export function buildActionRecordingResult(
  rawSteps: RecordedStep[],
  durationMs: number,
  extras?: {
    apiCalls?: Array<{ timestamp: number; method: string; url: string; status?: number }>
    errors?: Array<{ timestamp: number; kind: 'console' | 'exception' | 'dialog'; text: string }>
  },
): ActionRecordingResult {
  const steps: RecordedStep[] = []
  for (const s of rawSteps) {
    const prev = steps[steps.length - 1]
    // Collapse consecutive fills on the same input target
    if (s.action === 'fill' && prev?.action === 'fill' && prev.target === s.target) {
      prev.value = s.value
      prev.timestamp = s.timestamp
      continue
    }
    // Collapse click immediately before fill/select on the exact same element
    if ((s.action === 'fill' || s.action === 'select_option') && prev?.action === 'click' && prev.target === s.target) {
      steps.pop()
    }
    // Skip duplicate consecutive navigations to same URL
    if (s.action === 'navigate' && prev?.action === 'navigate' && prev.url === s.url) {
      continue
    }
    steps.push({ ...s })
  }

  const batchSteps: Array<Record<string, unknown>> = steps.map((s) => {
    switch (s.action) {
      case 'navigate':
        return { action: 'navigate', url: s.url }
      case 'click':
        return { action: 'click', target: s.target }
      case 'fill':
        return { action: 'fill', target: s.target, value: s.value ?? '' }
      case 'select_option':
        return { action: 'select_option', target: s.target, value: s.value ?? '' }
      case 'press_key':
        return { action: 'press_key', key: s.key ?? 'Enter' }
      case 'scroll': {
        const dy = Number(s.value ?? 400)
        return { action: 'scroll', direction: dy >= 0 ? 'down' : 'up', amount: Math.abs(dy) }
      }
    }
  })

  const scriptLines: string[] = [
    '// Recorded by BrowserPilot Action Recorder',
    'const t = await tabs.current();',
  ]
  for (const s of steps) {
    switch (s.action) {
      case 'navigate':
        scriptLines.push(`await t.page.navigate(${JSON.stringify(s.url)});`)
        break
      case 'click':
        scriptLines.push(`await t.page.click(${JSON.stringify(s.target ?? '')});`)
        break
      case 'fill':
        scriptLines.push(`await t.page.fill(${JSON.stringify(s.target ?? '')}, ${JSON.stringify(s.value ?? '')});`)
        break
      case 'select_option':
        scriptLines.push(`await t.page.selectOption(${JSON.stringify(s.target ?? '')}, ${JSON.stringify(s.value ?? '')});`)
        break
      case 'press_key':
        scriptLines.push(`await t.page.pressKey(${JSON.stringify(s.key ?? 'Enter')});`)
        break
      case 'scroll': {
        const dy = Number(s.value ?? 400)
        scriptLines.push(`await t.page.scroll({ deltaY: ${dy} });`)
        break
      }
    }
  }
  const execScript = scriptLines.join('\n')

  const mdLines: string[] = [
    '# Recorded BrowserPilot Workflow',
    '',
    `Recorded ${steps.length} step(s) in ${(durationMs / 1000).toFixed(1)}s.`,
    '',
    '## Steps',
  ]
  steps.forEach((s, idx) => {
    const desc =
      s.action === 'navigate'
        ? `Navigate to \`${s.url}\``
        : s.action === 'click'
          ? `Click \`${s.target}\`${s.text ? ` ("${s.text}")` : ''}`
          : s.action === 'fill'
            ? `Fill \`${s.target}\` with \`${s.value ?? ''}\``
            : s.action === 'select_option'
              ? `Select \`${s.value ?? ''}\` in \`${s.target}\``
              : s.action === 'press_key'
                ? `Press key \`${s.key}\``
                : `Scroll ${Number(s.value ?? 0) >= 0 ? 'down' : 'up'} ${Math.abs(Number(s.value ?? 0))}px`
    mdLines.push(`${idx + 1}. ${desc}`)
  })
  if (extras?.apiCalls?.length) {
    mdLines.push('', '## Observed API Calls')
    for (const c of extras.apiCalls.slice(0, 20)) {
      mdLines.push(`- \`${c.method} ${c.status ?? '?'}\` ${c.url}`)
    }
  }
  if (extras?.errors?.length) {
    mdLines.push('', '## Observed Errors / Dialogs')
    for (const e of extras.errors.slice(0, 15)) {
      mdLines.push(`- [${e.kind}] ${e.text}`)
    }
  }
  mdLines.push('', '## Replay Script (`browserpilot exec`)', '```js', execScript, '```')

  return {
    durationMs,
    steps,
    ...(extras?.apiCalls?.length ? { apiCalls: extras.apiCalls } : {}),
    ...(extras?.errors?.length ? { errors: extras.errors } : {}),
    batchSteps,
    execScript,
    skillMarkdown: mdLines.join('\n'),
  }
}

/**
 * Records live user interactions (clicks, fills, selects, keys, scrolls, navigations)
 * plus concurrent XHR/Fetch API calls, dialogs, and uncaught exceptions across page loads.
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

  constructor(session: TabCDPSession) {
    this.session = session
  }

  isRecording(): boolean {
    return this.recording
  }

  getSteps(): RecordedStep[] {
    return [...this.steps]
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
      this.steps.push({ timestamp: this.startedAt, action: 'navigate', url: initialUrl })
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
          this.steps.push({
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
          this.steps.push({
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
    this.recording = false
    const durationMs = Date.now() - this.startedAt

    for (const off of this.unsubs) off()
    this.unsubs = []

    if (this.scriptId) {
      await this.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }).catch(() => {})
      this.scriptId = null
    }
    await this.session
      .send('Runtime.evaluate', { expression: 'globalThis.__bpActionRecorderEnabled = false;' })
      .catch(() => {})

    return buildActionRecordingResult(this.steps, durationMs, {
      apiCalls: this.apiCalls,
      errors: this.errors,
    })
  }

  dispose(): void {
    this.recording = false
    for (const off of this.unsubs) off()
    this.unsubs = []
  }
}
