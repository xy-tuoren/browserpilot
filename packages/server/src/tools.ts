import { CONTEXT_TOOL_DEFINITIONS, executeContextTool } from './tools/context.js'
import { DEVTOOLS_TOOL_DEFINITIONS, executeDevToolsTool } from './tools/devtools.js'
import { executeInteractionTool, INTERACTION_TOOL_DEFINITIONS } from './tools/interaction.js'
import { executeNavigationTool, NAVIGATION_TOOL_DEFINITIONS } from './tools/navigation.js'
import {
  normalizeNavigationUrl,
  textResult,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolExecutionResult,
  type ToolResultContent,
  type ToolRuntimeContext,
} from './tools/types.js'
import { validateAndNormalizeToolArgs } from './tools/validate.js'

export {
  normalizeNavigationUrl,
  validateAndNormalizeToolArgs,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolResultContent,
  type ToolRuntimeContext,
}

const STATUS_TOOL_DEFINITION: ToolDefinition = {
  name: 'browser_status',
  description: 'Check connected Chrome extensions/browsers, active transports, and stateful sessions.',
  inputSchema: { type: 'object', properties: {} },
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  STATUS_TOOL_DEFINITION,
  ...NAVIGATION_TOOL_DEFINITIONS,
  ...INTERACTION_TOOL_DEFINITIONS,
  ...DEVTOOLS_TOOL_DEFINITIONS,
  ...CONTEXT_TOOL_DEFINITIONS,
]

const TOOL_DEFINITION_MAP = new Map<string, ToolDefinition>(TOOL_DEFINITIONS.map((t) => [t.name, t]))

function buildReplayStepFromTool(
  name: string,
  args: Record<string, unknown>,
): { detail?: string; step?: Record<string, unknown> } {
  const target = typeof args.target === 'string' ? args.target : undefined
  switch (name) {
    case 'browser_navigate':
      return { detail: String(args.url ?? ''), step: { action: 'navigate', url: String(args.url ?? '') } }
    case 'browser_click':
      return {
        detail: target,
        step: { action: Number(args.clickCount) === 2 ? 'dblclick' : 'click', target },
      }
    case 'browser_fill': {
      const isSecret = target ? /password|passwd|pwd|secret|token/i.test(target) : false
      const val = String(args.value ?? '')
      return {
        detail: `${target ?? ''} = ${isSecret ? '<REDACTED>' : JSON.stringify(val.slice(0, 48))}`,
        step: isSecret ? undefined : { action: 'fill', target, value: val },
      }
    }
    case 'browser_type':
      return {
        detail: `${target ? `${target}: ` : ''}${String(args.text ?? '').slice(0, 48)}`,
        step: { action: 'type', ...(target ? { target } : {}), text: String(args.text ?? '') },
      }
    case 'browser_press_key':
      return { detail: String(args.key ?? ''), step: { action: 'press_key', key: String(args.key ?? '') } }
    case 'browser_check':
      return {
        detail: `${args.checked === false ? 'uncheck' : 'check'} ${target ?? ''}`,
        step: { action: args.checked === false ? 'uncheck' : 'check', target },
      }
    case 'browser_select_option':
      return {
        detail: `${target ?? ''} = ${JSON.stringify(args.values ?? args.value ?? '')}`,
        step: { action: 'select_option', target, value: args.values ?? args.value ?? '' },
      }
    case 'browser_scroll':
      return {
        detail: args.untilTarget ? `until ${String(args.untilTarget)}` : String(args.direction ?? 'down'),
        step: {
          action: 'scroll',
          ...(target ? { target } : {}),
          ...(args.untilTarget ? { untilTarget: String(args.untilTarget) } : {}),
          ...(args.direction ? { direction: String(args.direction) } : {}),
        },
      }
    case 'browser_drag':
      return {
        detail: `${String(args.fromTarget ?? '')} -> ${String(args.toTarget ?? '')}`,
        step: {
          action: 'drag',
          fromTarget: args.fromTarget,
          toTarget: args.toTarget,
          ...(args.mode ? { mode: args.mode } : {}),
        },
      }
    case 'browser_touch':
      return {
        detail: `${String(args.action ?? 'tap')} ${target ?? String(args.fromTarget ?? '')}`.trim(),
        step:
          args.action === 'swipe'
            ? { action: 'swipe', fromTarget: args.fromTarget, toTarget: args.toTarget }
            : { action: 'tap', target },
      }
    case 'browser_snapshot':
      return { detail: args.scope ? `scope=${String(args.scope)}` : args.viewportOnly ? 'viewport' : args.interactiveOnly ? 'interactive' : 'full' }
    case 'browser_exec':
      return { detail: String(args.code ?? '').replace(/\s+/g, ' ').trim().slice(0, 64) }
    case 'browser_handoff':
      return { detail: String(args.message ?? '').slice(0, 64) }
    default:
      return { detail: target || (typeof args.url === 'string' ? args.url : undefined) }
  }
}

function reportToolActivity(
  manager: ReturnType<ToolRuntimeContext['getManager']>,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  durationMs: number,
  explicitTabId?: number,
): void {
  if (name === 'browser_tabs' || name === 'browser_status' || name === 'browser_frames') return
  const transport = manager.getTransport() as { rpc?: (method: string, params?: Record<string, unknown>) => Promise<unknown> }
  if (typeof transport.rpc !== 'function') return
  const info = buildReplayStepFromTool(name, args)
  void transport
    .rpc('extension.logActivity', {
      action: name.replace(/^browser_/, ''),
      status: ok ? 'ok' : 'error',
      detail: info.detail,
      tabId: explicitTabId,
      durationMs,
      ...(info.step ? { step: info.step } : {}),
    })
    .catch(() => {})
}

export async function executeTool(
  ctx: ToolRuntimeContext,
  name: string,
  rawArgs: Record<string, unknown> = {},
): Promise<ToolExecutionResult> {
  const startedAt = Date.now()
  let resolvedManager: ReturnType<ToolRuntimeContext['getManager']> | null = null
  let resolvedArgs: Record<string, unknown> = rawArgs
  let resolvedTabId: number | undefined
  try {
    const def = TOOL_DEFINITION_MAP.get(name)
    if (!def) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }

    const args = validateAndNormalizeToolArgs(def, rawArgs)
    resolvedArgs = args

    if (name === 'browser_status') {
      const clients = ctx.listClients()
      const sessions = clients.length > 0 ? ctx.getManager().listSessions() : []
      return textResult(JSON.stringify({ clients, sessions }, null, 2))
    }

    const clientId = args.clientId as string | undefined
    const manager = ctx.getManager(clientId)
    resolvedManager = manager
    const sessionId = args.sessionId as string | undefined
    const explicitTabId = typeof args.tabId === 'number' ? args.tabId : undefined
    resolvedTabId = explicitTabId

    const dispatchCtx: ToolDispatchContext = {
      manager,
      sessionId,
      explicitTabId,
      resolveTab: () => manager.resolveActiveTab({ tabId: explicitTabId, sessionId }),
      registerTraceHtml: ctx.registerTraceHtml,
    }

    const result =
      (await executeNavigationTool(dispatchCtx, name, args)) ??
      (await executeInteractionTool(dispatchCtx, name, args)) ??
      (await executeDevToolsTool(dispatchCtx, name, args)) ??
      (await executeContextTool(dispatchCtx, name, args))

    if (result) {
      reportToolActivity(manager, name, args, !result.isError, Date.now() - startedAt, explicitTabId)
      return result
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  } catch (err) {
    if (resolvedManager) {
      reportToolActivity(resolvedManager, name, resolvedArgs, false, Date.now() - startedAt, resolvedTabId)
    }
    return {
      content: [{ type: 'text', text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
}
