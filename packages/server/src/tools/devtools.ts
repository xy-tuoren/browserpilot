import { formatConsoleLogs, formatNetworkEntries, formatStylesAsText } from '@browserpilot/core'
import type { ConsoleLevel } from '@browserpilot/protocol'
import { textResult, type ToolDefinition, type ToolDispatchContext, type ToolExecutionResult } from './types.js'

export const DEVTOOLS_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the page (or a specific iframe) context (supports async/Promises) and return JSON result.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
        frame: { type: 'string', description: 'Optional iframe CSS selector, frameId, name, or URL substring/regex' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'browser_console',
    description: 'Read buffered browser console logs, warnings, and uncaught exceptions with sinceLastCall & search.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'log', 'info', 'warn', 'error', 'debug', 'exception'] },
        search: { type: 'string' },
        count: { type: 'number' },
        sinceLastCall: { type: 'boolean' },
        clear: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_network',
    description:
      'Inspect captured HTTP/S requests (headers, timing, JS initiator stack, status) or fetch response body for a requestId.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        method: { type: 'string' },
        status: { type: 'number' },
        failedOnly: { type: 'boolean' },
        resourceType: { type: 'string' },
        count: { type: 'number' },
        sinceLastCall: { type: 'boolean' },
        requestId: { type: 'string', description: 'Fetch detailed headers, timing, initiator, and response body for this requestId' },
        clear: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_network_intercept',
    description: 'Add, list, remove, or clear Fetch request interception rules (mock responses, block requests, modify headers).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove', 'clear'] },
        ruleId: { type: 'string' },
        urlPattern: { type: 'string', description: 'Wildcard URL pattern like */api/users*' },
        interceptAction: { type: 'string', enum: ['mock', 'block', 'modify-headers'] },
        status: { type: 'number' },
        contentType: { type: 'string' },
        body: { type: 'string' },
        headers: { type: 'object' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_styles',
    description:
      'Inspect DevTools Styles cascade (inline, matched rules with source file:line, overridden props, inherited rules) and optionally force :hover/:focus/:active.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ref or CSS selector' },
        forcePseudoStates: { type: 'array', items: { type: 'string', enum: ['hover', 'focus', 'active', 'visited', 'focus-visible'] } },
        includeInherited: { type: 'boolean' },
        computedProperties: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_react_info',
    description: 'Inspect React component name, dev source file:line, hierarchy, and sanitized props via React Fiber.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_debugger',
    description: 'Live CDP JavaScript debugger: list scripts, set/remove breakpoints, pause/resume/step, inspect call frame variables.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'enable',
            'disable',
            'list_scripts',
            'set_breakpoint',
            'remove_breakpoint',
            'list_breakpoints',
            'pause',
            'resume',
            'step_over',
            'step_into',
            'step_out',
            'state',
            'eval_frame',
            'pause_on_exceptions',
          ],
        },
        search: { type: 'string' },
        url: { type: 'string' },
        lineNumber: { type: 'number' },
        condition: { type: 'string' },
        breakpointId: { type: 'string' },
        callFrameId: { type: 'string' },
        expression: { type: 'string' },
        exceptionState: { type: 'string', enum: ['none', 'uncaught', 'all'] },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_live_edit',
    description: 'Grep across loaded page scripts or live-patch JavaScript/CSS in memory without reloading.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['grep_scripts', 'get_script', 'edit_script', 'list_stylesheets', 'edit_stylesheet'] },
        pattern: { type: 'string' },
        scriptIdOrUrl: { type: 'string' },
        styleSheetId: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_performance',
    description: 'Collect Core Web Vitals (LCP/CLS/FCP/TTFB), CDP metrics, V8 heap summary, CPU profiling, or Tracing insights.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['metrics', 'heap', 'cpu_start', 'cpu_stop', 'trace_start', 'trace_stop'],
        },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_cdp',
    description: 'Send any raw Chrome DevTools Protocol (CDP) command to the active tab (profile-wide destructive commands blocked).',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string' },
        params: { type: 'object' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['method'],
    },
  },
]

export async function executeDevToolsTool(
  ctx: ToolDispatchContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const { resolveTab } = ctx

  switch (name) {
    case 'browser_evaluate': {
      const tab = await resolveTab()
      const val = await tab.page.evaluate(String(args.expression), { frame: args.frame as string | undefined })
      return textResult(typeof val === 'string' ? val : JSON.stringify(val, null, 2))
    }

    case 'browser_console': {
      const tab = await resolveTab()
      if (args.clear) {
        tab.console.clear()
        return textResult('Cleared console buffer')
      }
      const entries = tab.console.getLogs({
        level: args.level as ConsoleLevel | 'all' | undefined,
        search: args.search as string | undefined,
        count: args.count as number | undefined,
        sinceLastCall: args.sinceLastCall as boolean | undefined,
      })
      return textResult(formatConsoleLogs(entries), { count: entries.length })
    }

    case 'browser_network': {
      const tab = await resolveTab()
      if (args.clear) {
        tab.network.clear()
        return textResult('Cleared network buffer')
      }
      if (typeof args.requestId === 'string') {
        const entry = tab.network.getRequests({ count: 2000 }).find((r) => r.requestId === args.requestId)
        let body: { body: string; base64Encoded: boolean } | null = null
        try {
          body = await tab.network.getResponseBody(args.requestId)
        } catch {}
        return textResult(
          JSON.stringify(
            {
              entry,
              body: body ? (body.base64Encoded ? `<base64 ${body.body.length} chars>` : body.body.slice(0, 16_000)) : null,
            },
            null,
            2,
          ),
        )
      }
      const entries = tab.network.getRequests({
        search: args.search as string | undefined,
        method: args.method as string | undefined,
        status: args.status as number | undefined,
        failedOnly: args.failedOnly as boolean | undefined,
        resourceType: args.resourceType as string | undefined,
        count: args.count as number | undefined,
        sinceLastCall: args.sinceLastCall as boolean | undefined,
      })
      return textResult(formatNetworkEntries(entries), { count: entries.length })
    }

    case 'browser_network_intercept': {
      const tab = await resolveTab()
      const action = String(args.action)
      if (action === 'list') return textResult(JSON.stringify(tab.network.listInterceptRules(), null, 2))
      if (action === 'clear') {
        await tab.network.clearInterceptRules()
        return textResult('Cleared all network intercept rules')
      }
      if (action === 'remove') {
        const ok = await tab.network.removeInterceptRule(String(args.ruleId))
        return textResult(ok ? `Removed rule ${args.ruleId}` : `Rule ${args.ruleId} not found`)
      }
      const rule = await tab.network.addInterceptRule({
        urlPattern: String(args.urlPattern ?? '*'),
        action: (args.interceptAction as 'mock' | 'block' | 'modify-headers') ?? 'mock',
        status: args.status as number | undefined,
        contentType: args.contentType as string | undefined,
        body: args.body as string | undefined,
        headers: args.headers as Record<string, string> | undefined,
      })
      return textResult(`Added intercept rule ${rule.id}: ${rule.action} ${rule.urlPattern}`, { rule })
    }

    case 'browser_styles': {
      const tab = await resolveTab()
      const target = String(args.target)
      if (Array.isArray(args.forcePseudoStates)) {
        await tab.styles.forcePseudoState(
          target,
          tab.snapshots,
          args.forcePseudoStates as Array<'hover' | 'focus' | 'active' | 'visited' | 'focus-visible'>,
        )
      }
      const styles = await tab.styles.getStyles(target, tab.snapshots, {
        includeInherited: args.includeInherited as boolean | undefined,
        computedProperties: args.computedProperties as string[] | undefined,
      })
      return textResult(formatStylesAsText(styles), { styles })
    }

    case 'browser_react_info': {
      const tab = await resolveTab()
      const info = await tab.getReactInfo(String(args.target))
      return textResult(info ? JSON.stringify(info, null, 2) : 'No React Fiber metadata found on element.')
    }

    case 'browser_debugger': {
      const tab = await resolveTab()
      const action = String(args.action)
      switch (action) {
        case 'enable':
          await tab.debugger.enable()
          return textResult('Debugger enabled')
        case 'disable':
          await tab.debugger.disable()
          return textResult('Debugger disabled')
        case 'list_scripts':
          return textResult(JSON.stringify(tab.debugger.listScripts({ search: args.search as string | undefined }), null, 2))
        case 'set_breakpoint': {
          const bp = await tab.debugger.setBreakpoint({
            url: args.url as string | undefined,
            lineNumber: Number(args.lineNumber),
            condition: args.condition as string | undefined,
          })
          return textResult(JSON.stringify(bp, null, 2))
        }
        case 'remove_breakpoint':
          await tab.debugger.removeBreakpoint(String(args.breakpointId))
          return textResult(`Removed breakpoint ${args.breakpointId}`)
        case 'list_breakpoints':
          return textResult(JSON.stringify(tab.debugger.listBreakpoints(), null, 2))
        case 'pause':
          await tab.debugger.pause()
          return textResult('Pause requested')
        case 'resume':
          await tab.debugger.resume()
          return textResult('Resumed execution')
        case 'step_over':
          await tab.debugger.stepOver()
          return textResult('Stepped over')
        case 'step_into':
          await tab.debugger.stepInto()
          return textResult('Stepped into')
        case 'step_out':
          await tab.debugger.stepOut()
          return textResult('Stepped out')
        case 'state':
          return textResult(JSON.stringify(await tab.debugger.getPausedState(true), null, 2))
        case 'eval_frame':
          return textResult(
            JSON.stringify(await tab.debugger.evaluateOnCallFrame(String(args.callFrameId), String(args.expression)), null, 2),
          )
        case 'pause_on_exceptions':
          await tab.debugger.setPauseOnExceptions((args.exceptionState as 'none' | 'uncaught' | 'all') ?? 'uncaught')
          return textResult(`pauseOnExceptions = ${args.exceptionState ?? 'uncaught'}`)
        default:
          throw new Error(`Unknown debugger action: ${action}`)
      }
    }

    case 'browser_live_edit': {
      const tab = await resolveTab()
      const action = String(args.action)
      if (action === 'grep_scripts') {
        const hits = await tab.editor.grepScripts(String(args.pattern ?? ''))
        return textResult(JSON.stringify(hits, null, 2))
      }
      if (action === 'get_script') {
        const s = await tab.editor.getScriptSource(String(args.scriptIdOrUrl))
        return textResult(s.source.slice(0, 30_000))
      }
      if (action === 'edit_script') {
        const r = await tab.editor.editScript(String(args.scriptIdOrUrl), String(args.oldString), String(args.newString))
        return textResult(JSON.stringify(r))
      }
      if (action === 'list_stylesheets') {
        await tab.session.enableDomain('CSS')
        return textResult(JSON.stringify(tab.styles.getStyleSheets(), null, 2))
      }
      if (action === 'edit_stylesheet') {
        await tab.editor.editStyleSheet(String(args.styleSheetId), String(args.oldString), String(args.newString))
        return textResult(`Updated stylesheet ${args.styleSheetId}`)
      }
      throw new Error(`Unknown live_edit action: ${action}`)
    }

    case 'browser_performance': {
      const tab = await resolveTab()
      const action = String(args.action)
      if (action === 'metrics') return textResult(JSON.stringify(await tab.performance.getMetrics(), null, 2))
      if (action === 'heap') return textResult(JSON.stringify(await tab.performance.getHeapSummary(), null, 2))
      if (action === 'cpu_start') {
        await tab.performance.startCPUProfile()
        return textResult('CPU profiler started')
      }
      if (action === 'cpu_stop') return textResult(JSON.stringify(await tab.performance.stopCPUProfile(), null, 2))
      if (action === 'trace_start') {
        await tab.performance.startTrace()
        return textResult('Performance trace started')
      }
      if (action === 'trace_stop') return textResult(JSON.stringify(await tab.performance.stopTrace(), null, 2))
      throw new Error(`Unknown performance action: ${action}`)
    }

    case 'browser_cdp': {
      const tab = await resolveTab()
      const res = await tab.session.send(
        String(args.method),
        args.params as Record<string, unknown> | undefined,
      )
      return textResult(JSON.stringify(res, null, 2))
    }

    default:
      return null
  }
}
