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

export {
  normalizeNavigationUrl,
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

export async function executeTool(
  ctx: ToolRuntimeContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolExecutionResult> {
  try {
    if (name === 'browser_status') {
      const clients = ctx.listClients()
      const sessions = clients.length > 0 ? ctx.getManager().listSessions() : []
      return textResult(JSON.stringify({ clients, sessions }, null, 2))
    }

    const clientId = args.clientId as string | undefined
    const manager = ctx.getManager(clientId)
    const sessionId = args.sessionId as string | undefined
    const explicitTabId = typeof args.tabId === 'number' ? args.tabId : undefined

    const dispatchCtx: ToolDispatchContext = {
      manager,
      sessionId,
      explicitTabId,
      resolveTab: () => manager.resolveActiveTab({ tabId: explicitTabId, sessionId }),
    }

    const result =
      (await executeNavigationTool(dispatchCtx, name, args)) ??
      (await executeInteractionTool(dispatchCtx, name, args)) ??
      (await executeDevToolsTool(dispatchCtx, name, args)) ??
      (await executeContextTool(dispatchCtx, name, args))

    if (result) return result
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
}
