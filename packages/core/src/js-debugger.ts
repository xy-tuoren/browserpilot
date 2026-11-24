import type {
  DebuggerBreakpoint,
  DebuggerCallFrame,
  DebuggerPausedState,
  DebuggerScopeVariable,
  DebuggerScriptInfo,
} from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

interface RawCallFrame {
  callFrameId: string
  functionName: string
  location: { scriptId: string; lineNumber: number; columnNumber?: number }
  url: string
  scopeChain: Array<{ type: string; object: { objectId?: string } }>
}

/**
 * Live CDP JavaScript Debugger: script discovery, breakpoints, stepping,
 * scope variable inspection, and call-frame expression evaluation.
 */
export class JSDebugger {
  private readonly session: TabCDPSession
  private enabled = false
  private scripts = new Map<string, DebuggerScriptInfo>()
  private breakpoints = new Map<string, DebuggerBreakpoint>()
  private paused = false
  private pauseReason: string | undefined
  private rawCallFrames: RawCallFrame[] = []
  private unsubscribers: Array<() => void> = []

  constructor(session: TabCDPSession) {
    this.session = session

    this.unsubscribers.push(
      session.on('Debugger.scriptParsed', (params) => {
        const scriptId = String(params.scriptId ?? '')
        if (!scriptId) return
        this.scripts.set(scriptId, {
          scriptId,
          url: String(params.url ?? ''),
          startLine: Number(params.startLine ?? 0) + 1,
          endLine: Number(params.endLine ?? 0) + 1,
          isModule: params.isModule as boolean | undefined,
          sourceMapURL: params.sourceMapURL as string | undefined,
        })
      }),
    )

    this.unsubscribers.push(
      session.on('Debugger.paused', (params) => {
        this.paused = true
        this.pauseReason = String(params.reason ?? 'other')
        this.rawCallFrames = (params.callFrames as RawCallFrame[] | undefined) ?? []
      }),
    )

    this.unsubscribers.push(
      session.on('Debugger.resumed', () => {
        this.paused = false
        this.pauseReason = undefined
        this.rawCallFrames = []
      }),
    )
  }

  async enable(): Promise<void> {
    if (this.enabled) return
    await this.session.send('Debugger.enable')
    this.enabled = true
  }

  async disable(): Promise<void> {
    if (!this.enabled) return
    await this.session.send('Debugger.disable').catch(() => {})
    this.enabled = false
    this.paused = false
    this.rawCallFrames = []
  }

  listScripts(options: { search?: string | RegExp } = {}): DebuggerScriptInfo[] {
    let list = Array.from(this.scripts.values()).filter((s) => Boolean(s.url))
    if (options.search !== undefined) {
      const regex =
        options.search instanceof RegExp
          ? options.search
          : new RegExp(options.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      list = list.filter((s) => regex.test(s.url))
    }
    return list
  }

  async setBreakpoint(options: {
    url?: string
    urlRegex?: string
    lineNumber: number
    columnNumber?: number
    condition?: string
  }): Promise<DebuggerBreakpoint> {
    await this.enable()
    const params: Record<string, unknown> = {
      lineNumber: Math.max(0, options.lineNumber - 1),
    }
    if (options.url) params.url = options.url
    if (options.urlRegex) params.urlRegex = options.urlRegex
    if (options.columnNumber !== undefined) params.columnNumber = Math.max(0, options.columnNumber - 1)
    if (options.condition) params.condition = options.condition

    const res = await this.session.send<{ breakpointId: string }>('Debugger.setBreakpointByUrl', params)
    const bp: DebuggerBreakpoint = {
      breakpointId: res.breakpointId,
      url: options.url ?? options.urlRegex ?? '',
      lineNumber: options.lineNumber,
      columnNumber: options.columnNumber,
      condition: options.condition,
    }
    this.breakpoints.set(bp.breakpointId, bp)
    return bp
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    await this.session.send('Debugger.removeBreakpoint', { breakpointId })
    this.breakpoints.delete(breakpointId)
  }

  listBreakpoints(): DebuggerBreakpoint[] {
    return Array.from(this.breakpoints.values())
  }

  async setPauseOnExceptions(state: 'none' | 'uncaught' | 'all'): Promise<void> {
    await this.enable()
    await this.session.send('Debugger.setPauseOnExceptions', { state })
  }

  async pause(): Promise<void> {
    await this.enable()
    await this.session.send('Debugger.pause')
  }

  async resume(): Promise<void> {
    await this.session.send('Debugger.resume')
  }

  async stepOver(): Promise<void> {
    await this.session.send('Debugger.stepOver')
  }

  async stepInto(): Promise<void> {
    await this.session.send('Debugger.stepInto')
  }

  async stepOut(): Promise<void> {
    await this.session.send('Debugger.stepOut')
  }

  async waitForPause(timeoutMs: number = 10_000): Promise<DebuggerPausedState> {
    if (this.paused) return await this.getPausedState()
    await this.session.once('Debugger.paused', undefined, timeoutMs)
    return await this.getPausedState()
  }

  async getPausedState(includeVariables = true): Promise<DebuggerPausedState> {
    if (!this.paused) {
      return { paused: false, callFrames: [] }
    }
    const frames: DebuggerCallFrame[] = []
    for (let i = 0; i < Math.min(this.rawCallFrames.length, 10); i++) {
      const raw = this.rawCallFrames[i]
      const script = this.scripts.get(raw.location.scriptId)
      const frame: DebuggerCallFrame = {
        callFrameId: raw.callFrameId,
        functionName: raw.functionName || '(anonymous)',
        url: raw.url || script?.url || '',
        lineNumber: raw.location.lineNumber + 1,
        columnNumber: (raw.location.columnNumber ?? 0) + 1,
      }
      if (includeVariables && i === 0) {
        frame.variables = await this.inspectScopeChain(raw)
      }
      frames.push(frame)
    }
    return {
      paused: true,
      reason: this.pauseReason,
      callFrames: frames,
    }
  }

  private async inspectScopeChain(frame: RawCallFrame): Promise<DebuggerScopeVariable[]> {
    const vars: DebuggerScopeVariable[] = []
    for (const scope of frame.scopeChain) {
      if (scope.type === 'global' || !scope.object.objectId) continue
      try {
        const res = await this.session.send<{
          result?: Array<{
            name: string
            value?: { type?: string; value?: unknown; description?: string }
          }>
        }>('Runtime.getProperties', {
          objectId: scope.object.objectId,
          ownProperties: true,
          generatePreview: true,
        })
        for (const prop of (res.result ?? []).slice(0, 30)) {
          const val = prop.value
          vars.push({
            name: prop.name,
            type: val?.type ?? 'undefined',
            value:
              val?.value !== undefined
                ? JSON.stringify(val.value)
                : String(val?.description ?? val?.type ?? 'undefined').slice(0, 200),
            scopeType: scope.type,
          })
        }
      } catch {
        // ignore inaccessible scope
      }
    }
    return vars
  }

  async evaluateOnCallFrame(callFrameId: string, expression: string): Promise<unknown> {
    const res = await this.session.send<{
      result?: { value?: unknown; description?: string }
      exceptionDetails?: { text?: string }
    }>('Debugger.evaluateOnCallFrame', {
      callFrameId,
      expression,
      returnByValue: true,
    })
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text ?? 'evaluateOnCallFrame failed')
    }
    return res.result?.value ?? res.result?.description
  }

  getScriptByIdOrUrl(scriptIdOrUrl: string): DebuggerScriptInfo | undefined {
    const direct = this.scripts.get(scriptIdOrUrl)
    if (direct) return direct
    return Array.from(this.scripts.values()).find(
      (s) => s.url === scriptIdOrUrl || (s.url && s.url.includes(scriptIdOrUrl)),
    )
  }

  dispose(): void {
    for (const off of this.unsubscribers) off()
    this.unsubscribers = []
  }
}

/**
 * Live in-memory Script & CSS Editor (view, grep across loaded scripts, live-patch via CDP).
 */
export class LiveEditor {
  private readonly session: TabCDPSession
  private readonly dbg: JSDebugger

  constructor(session: TabCDPSession, dbg: JSDebugger) {
    this.session = session
    this.dbg = dbg
  }

  async enable(): Promise<void> {
    await this.dbg.enable()
    await this.session.enableDomain('CSS').catch(() => {})
  }

  async getScriptSource(scriptIdOrUrl: string): Promise<{ scriptId: string; url: string; source: string }> {
    await this.enable()
    const info = this.dbg.getScriptByIdOrUrl(scriptIdOrUrl)
    if (!info) throw new Error(`Script not found: ${scriptIdOrUrl}`)
    const res = await this.session.send<{ scriptSource: string }>('Debugger.getScriptSource', {
      scriptId: info.scriptId,
    })
    return { scriptId: info.scriptId, url: info.url, source: res.scriptSource ?? '' }
  }

  async grepScripts(
    pattern: string | RegExp,
    options: { maxMatches?: number } = {},
  ): Promise<Array<{ scriptId: string; url: string; line: number; preview: string }>> {
    await this.enable()
    const maxMatches = options.maxMatches ?? 30
    const regex =
      pattern instanceof RegExp
        ? pattern
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

    const hits: Array<{ scriptId: string; url: string; line: number; preview: string }> = []
    for (const script of this.dbg.listScripts()) {
      if (hits.length >= maxMatches) break
      try {
        const res = await this.session.send<{ scriptSource: string }>('Debugger.getScriptSource', {
          scriptId: script.scriptId,
        })
        const lines = (res.scriptSource ?? '').split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            hits.push({
              scriptId: script.scriptId,
              url: script.url,
              line: i + 1,
              preview: lines[i].trim().slice(0, 180),
            })
            if (hits.length >= maxMatches) break
          }
        }
      } catch {
        // skip unreadable script
      }
    }
    return hits
  }

  async editScript(
    scriptIdOrUrl: string,
    oldString: string,
    newString: string,
  ): Promise<{ scriptId: string; url: string; status: string }> {
    const { scriptId, url, source } = await this.getScriptSource(scriptIdOrUrl)
    if (!source.includes(oldString)) {
      throw new Error(`Target snippet not found in script ${url || scriptId}`)
    }
    const updated = source.replace(oldString, newString)
    try {
      const res = await this.session.send<{ status?: string }>('Debugger.setScriptSource', {
        scriptId,
        scriptSource: updated,
        allowTopFrameEditing: true,
      })
      return { scriptId, url, status: res.status ?? 'Ok' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/no longer available|not supported|liveedit/i.test(msg)) {
        // Modern V8 removed Debugger.setScriptSource; re-evaluate patched script in page context
        let evalRes = await this.session.send<{ exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
          'Runtime.evaluate',
          { expression: updated, returnByValue: false },
        )
        const firstErr = evalRes.exceptionDetails?.exception?.description ?? evalRes.exceptionDetails?.text ?? ''
        if (evalRes.exceptionDetails && /already been declared/i.test(firstErr)) {
          evalRes = await this.session.send<{ exceptionDetails?: { text?: string; exception?: { description?: string } } }>(
            'Runtime.evaluate',
            { expression: `(() => {\n${updated}\n})()`, returnByValue: false },
          )
        }
        if (evalRes.exceptionDetails) {
          throw new Error(
            `Live script fallback evaluation failed: ${evalRes.exceptionDetails.exception?.description ?? evalRes.exceptionDetails.text}`,
          )
        }
        return { scriptId, url, status: 'EvaluatedFallback' }
      }
      throw err
    }
  }

  async editStyleSheet(styleSheetId: string, oldString: string, newString: string): Promise<void> {
    await this.session.enableDomain('CSS')
    const cur = await this.session.send<{ text: string }>('CSS.getStyleSheetText', { styleSheetId })
    if (!cur.text.includes(oldString)) {
      throw new Error(`Target snippet not found in stylesheet ${styleSheetId}`)
    }
    await this.session.send('CSS.setStyleSheetText', {
      styleSheetId,
      text: cur.text.replace(oldString, newString),
    })
  }
}
