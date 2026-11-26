import path from 'node:path'
import type { TabCDPSession } from '../cdp-client.js'
import { sleep } from '../wait.js'
import type {
  ClickOptions,
  FileChooserHandle,
  FillOptions,
  FormFieldInput,
  FormFillResult,
  PageActionReadyMeta,
  ResolvedElement,
  WaitForFileChooserOptions,
} from './types.js'

export interface PageFormsDeps {
  session: TabCDPSession
  tabId: number
  resolveElement: (
    target: string,
    timeoutMs?: number,
    options?: { allowHidden?: boolean; strict?: boolean },
  ) => Promise<ResolvedElement>
  mouseClick: (x: number, y: number) => Promise<void>
  pressKey: (combo: string) => Promise<void>
  click: (target: string, options?: ClickOptions) => Promise<void>
}

export async function fillElement(
  deps: PageFormsDeps,
  target: string,
  value: string,
  options: FillOptions,
  markReady: (meta?: PageActionReadyMeta) => Promise<void>,
): Promise<void> {
  const resolveBudget = options.timeoutMs ?? 8_000
  const actionBudget = options.timeoutMs ?? 1_500
  const start = Date.now()
  let actionDeadline: number | null = null

  let el!: ResolvedElement
  let editableCheck!: { ok: boolean; reason?: string; isContentEditable?: boolean }

  while (true) {
    const remaining = Math.max(100, resolveBudget - (Date.now() - start))
    el = await deps.resolveElement(target, remaining, { strict: options.strict })
    if (options.force) break
    if (actionDeadline === null) actionDeadline = Date.now() + actionBudget

    const stateRes = await deps.session
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

  await markReady({ box: el.box, point: el.center })
  void deps.session.transport
    .setControlBanner?.(deps.tabId, { active: true, status: `Filling ${target}`, mode: 'working' })
    .catch(() => {})
  void deps.session.transport.highlightElement?.(deps.tabId, el.box, `fill ${target}`).catch(() => {})

  await deps.mouseClick(el.center.x, el.center.y)

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

  const selectRes = await deps.session
    .send<{ result?: { value?: { hadContent: boolean; isContentEditable: boolean; connected: boolean } } }>(
      'Runtime.callFunctionOn',
      { objectId: el.objectId, returnByValue: true, functionDeclaration: selectAllFn },
      { sessionId: el.sessionId },
    )
    .catch(() => null)

  let selState = selectRes?.result?.value
  if (!selState || !selState.connected) {
    el = await deps.resolveElement(target, 2_000, { strict: options.strict })
    const retrySel = await deps.session
      .send<{ result?: { value?: { hadContent: boolean; isContentEditable: boolean; connected: boolean } } }>(
        'Runtime.callFunctionOn',
        { objectId: el.objectId, returnByValue: true, functionDeclaration: selectAllFn },
        { sessionId: el.sessionId },
      )
      .catch(() => null)
    selState = retrySel?.result?.value ?? { hadContent: false, isContentEditable: false, connected: true }
  }

  if (options.clear !== false && selState.hadContent) {
    if (selState.isContentEditable) {
      // Rich-text editors (ProseMirror, Slate, TipTap, Draft.js, Quill) track internal state
      // through native editing commands rather than raw DOM mutations.
      await deps.pressKey(process.platform === 'darwin' ? 'Cmd+a' : 'Ctrl+a')
    }
    await deps.pressKey('Backspace')
  }

  if (value.length > 0) {
    await deps.session.send('Input.insertText', { text: value })
  }

  await deps.session
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
            return;
          }
          if (this.isContentEditable && expected.length > 0) {
            const current = (this.innerText ?? this.textContent ?? '').replace(/\\u200B/g, '').trim();
            if (!current.includes(expected.trim())) {
              try {
                const doc = this.ownerDocument || document;
                if (typeof this.focus === 'function') this.focus();
                doc.execCommand('insertText', false, expected);
              } catch {}
            }
          }
        }`,
      },
      { sessionId: el.sessionId },
    )
    .catch(() => {})
}

export async function typeIntoElement(
  deps: PageFormsDeps,
  target: string | null,
  text: string,
  options: { delayMs?: number },
  markReady: (meta?: PageActionReadyMeta) => Promise<void>,
): Promise<void> {
  if (target) {
    const el = await deps.resolveElement(target)
    await markReady({ box: el.box, point: el.center })
    await deps.click(target)
  }
  const delayMs = options.delayMs ?? 0
  if (delayMs <= 0) {
    await deps.session.send('Input.insertText', { text })
    return
  }
  for (const ch of text) {
    await deps.session.send('Input.insertText', { text: ch })
    await sleep(delayMs)
  }
}

export async function setCheckboxState(
  deps: PageFormsDeps,
  target: string,
  desiredChecked: boolean,
  options: { timeoutMs?: number; force?: boolean },
  markReady: (meta?: PageActionReadyMeta) => Promise<void>,
): Promise<boolean> {
  const el = await deps.resolveElement(target, options.timeoutMs)
  await markReady({ box: el.box, point: el.center })
  const res = await deps.session
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
  if (res?.result?.value === desiredChecked) return false
  await deps.click(target, { timeoutMs: options.timeoutMs, force: options.force })
  return true
}

export async function setRangeInputValue(
  deps: PageFormsDeps,
  target: string,
  value: number | string,
  timeoutMs?: number,
): Promise<string> {
  const el = await deps.resolveElement(target, timeoutMs)
  const strVal = String(value)
  const res = await deps.session.send<{ result?: { value?: string } }>(
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

export async function selectDropdownOption(
  deps: PageFormsDeps,
  target: string,
  wanted: string[],
  markReady: (meta?: PageActionReadyMeta) => Promise<void>,
): Promise<string[]> {
  const el = await deps.resolveElement(target)
  await markReady({ box: el.box, point: el.center })
  const res = await deps.session.send<{
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

export async function waitForPageFileChooser(
  session: TabCDPSession,
  options: WaitForFileChooserOptions = {},
): Promise<FileChooserHandle> {
  await session.ensureBaseDomains()
  const timeoutMs = options.timeoutMs ?? 15_000

  await session.send('Page.setInterceptFileChooserDialog', { enabled: true })

  let cleanedUp = false
  const disableIntercept = async () => {
    if (cleanedUp) return
    cleanedUp = true
    await session.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {})
  }

  const chooserPromise = session.once('Page.fileChooserOpened', undefined, timeoutMs)

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
      ev.sessionId ?? session.getChildSessions().find((c) => c.targetId === frameId)?.sessionId

    const handle: FileChooserHandle = {
      isMultiple: mode === 'selectMultiple',
      frameId,
      backendNodeId,
      setFiles: async (filePaths: string[]) => {
        const absolutePaths = filePaths.map((p) => path.resolve(p))
        try {
          await session.send(
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

export async function uploadElementFiles(
  deps: PageFormsDeps,
  target: string,
  filePaths: string[],
): Promise<void> {
  const el = await deps.resolveElement(target, undefined, { allowHidden: true })
  const meta = await deps.session
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
    await deps.session.send(
      'DOM.setFileInputFiles',
      { backendNodeId: el.backendNodeId, files: absolutePaths },
      { sessionId: el.sessionId },
    )
    return
  }

  await waitForPageFileChooser(deps.session, {
    action: () => deps.click(target),
    files: filePaths,
  })
}

export async function fillFormFields(
  deps: PageFormsDeps & {
    fill: (target: string, value: string) => Promise<void>
    check: (target: string) => Promise<boolean>
    uncheck: (target: string) => Promise<boolean>
    selectOption: (target: string, valueOrLabels: string | string[]) => Promise<string[]>
    setRangeValue: (target: string, value: number | string) => Promise<string>
    uploadFiles: (target: string, filePaths: string[]) => Promise<void>
  },
  fields: FormFieldInput[],
): Promise<FormFillResult> {
  const filled: FormFillResult['filled'] = []
  for (const field of fields) {
    const kind = field.type ?? 'auto'
    let detectedType = kind
    if (kind === 'auto') {
      const el = await deps.resolveElement(field.target, undefined, { allowHidden: true })
      const meta = await deps.session
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
      const selected = await deps.selectOption(field.target, vals)
      filled.push({ target: field.target, type: 'select', value: selected.length === 1 ? selected[0] : selected })
    } else if (detectedType === 'checkbox') {
      const desired = field.value === true || String(field.value).toLowerCase() === 'true'
      if (desired) await deps.check(field.target)
      else await deps.uncheck(field.target)
      filled.push({ target: field.target, type: 'checkbox', value: desired })
    } else if (detectedType === 'radio') {
      await deps.check(field.target)
      filled.push({ target: field.target, type: 'radio', value: field.value })
    } else if (detectedType === 'range') {
      const applied = await deps.setRangeValue(
        field.target,
        typeof field.value === 'number' ? field.value : String(field.value),
      )
      filled.push({ target: field.target, type: 'range', value: applied })
    } else if (detectedType === 'file') {
      const paths = Array.isArray(field.value) ? field.value.map(String) : [String(field.value)]
      await deps.uploadFiles(field.target, paths)
      filled.push({ target: field.target, type: 'file', value: paths })
    } else {
      await deps.fill(field.target, String(field.value))
      filled.push({ target: field.target, type: 'text', value: String(field.value) })
    }
  }
  return { filled }
}
