import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DirectCDPTransport, SessionManager } from '@browserpilot/core'
import { BROWSERPILOT_VERSION, type BrowserClientInfo } from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import {
  executeTool,
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolRuntimeContext,
} from './tools.js'

export type McpCapabilityGroup = 'core' | 'interaction' | 'extraction' | 'devtools' | 'context' | 'media' | 'all'

export interface StartMcpOptions {
  cdpEndpoint?: string
  daemonHost?: string
  daemonPort?: number
  daemonToken?: string
  /** Expose all 52 tools instead of the lean low-token core profile */
  full?: boolean
  /** Comma-separated or array of capability groups: core, interaction, extraction, devtools, context, media, all */
  capabilities?: string | string[]
}

/**
 * Default lean `core` MCP toolset (~70% lower prompt schema token overhead than all 52 tools):
 * covers tabs, navigation, AXTree/SoM/screenshot perception, ref-based interaction, console/network
 * inspection, human handoff, and `browser_exec` (Code Mode sandbox unlocking every advanced API).
 */
export const CORE_MCP_TOOL_NAMES = new Set<string>([
  'browser_status',
  'browser_tabs',
  'browser_open_tab',
  'browser_select_tab',
  'browser_close_tab',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_labeled_screenshot',
  'browser_click',
  'browser_fill',
  'browser_select_option',
  'browser_press_key',
  'browser_scroll',
  'browser_wait',
  'browser_handoff',
  'browser_console',
  'browser_network',
  'browser_exec',
])

const CAPABILITY_GROUP_TOOLS: Record<Exclude<McpCapabilityGroup, 'core' | 'all'>, ReadonlySet<string>> = {
  interaction: new Set([
    'browser_check',
    'browser_fill_form',
    'browser_type',
    'browser_hover',
    'browser_drag',
    'browser_upload_file',
    'browser_handle_dialog',
    'browser_batch',
  ]),
  extraction: new Set([
    'browser_frames',
    'browser_clean_html',
    'browser_markdown',
    'browser_inspect_element',
    'browser_pinned',
    'browser_evaluate',
  ]),
  devtools: new Set([
    'browser_network_intercept',
    'browser_styles',
    'browser_react_info',
    'browser_debugger',
    'browser_live_edit',
    'browser_performance',
    'browser_cdp',
  ]),
  context: new Set([
    'browser_history',
    'browser_clipboard',
    'browser_pdf',
    'browser_init_script',
    'browser_permissions',
    'browser_emulate',
    'browser_cookies',
    'browser_storage',
  ]),
  media: new Set(['browser_record', 'browser_downloads', 'browser_action_recorder', 'browser_trace']),
}

/**
 * Resolves the MCP tool definitions to advertise in `tools/list`.
 * Defaults to the token-efficient `core` profile (19 tools + `browser_exec`), while `--full` or
 * `capabilities: 'all'` (or `BROWSERPILOT_MCP_CAPS=all`) exposes all 52 tools.
 */
export function resolveMcpToolDefinitions(options: Pick<StartMcpOptions, 'full' | 'capabilities'> = {}): ToolDefinition[] {
  const rawCaps = options.capabilities ?? process.env.BROWSERPILOT_MCP_CAPS
  const capsList = Array.isArray(rawCaps)
    ? rawCaps
    : typeof rawCaps === 'string'
      ? rawCaps
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
      : []

  if (options.full || capsList.includes('all') || capsList.includes('full')) {
    return TOOL_DEFINITIONS
  }

  const allowed = new Set<string>(CORE_MCP_TOOL_NAMES)
  for (const cap of capsList) {
    if (cap === 'core') continue
    if (cap === 'record') {
      for (const t of CAPABILITY_GROUP_TOOLS.media) allowed.add(t)
      continue
    }
    const group = CAPABILITY_GROUP_TOOLS[cap as keyof typeof CAPABILITY_GROUP_TOOLS]
    if (group) {
      for (const t of group) allowed.add(t)
    }
  }

  return TOOL_DEFINITIONS.filter((t) => allowed.has(t.name))
}

/**
 * Starts the BrowserPilot Model Context Protocol (MCP) server on stdio.
 * Advertises the lean `core` toolset by default (or optional capability groups / `--full` 52 tools),
 * while `tools/call` still supports invoking any registered BrowserPilot tool.
 */
export async function startMcpServer(options: StartMcpOptions = {}): Promise<void> {
  let directManager: SessionManager | null = null
  let directClientInfo: BrowserClientInfo | null = null
  let daemonClient: DaemonClient | null = null
  const advertisedTools = resolveMcpToolDefinitions(options)

  if (options.cdpEndpoint) {
    const transport = await DirectCDPTransport.connect(options.cdpEndpoint)
    directManager = new SessionManager(transport)
    directClientInfo = {
      clientId: 'direct-cdp',
      transport: 'direct-cdp',
      browser: `Chromium (${options.cdpEndpoint})`,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      attachedTabCount: 0,
    }
  }

  const server = new Server(
    { name: 'browserpilot', version: BROWSERPILOT_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertisedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = (request.params.arguments as Record<string, unknown> | undefined) ?? {}

    let result: ToolExecutionResult
    if (directManager && directClientInfo) {
      const ctx: ToolRuntimeContext = {
        getManager: () => directManager!,
        listClients: () => [directClientInfo!],
      }
      result = await executeTool(ctx, name, args)
    } else {
      const ensureDaemon = async () => {
        if (!daemonClient) {
          daemonClient = await DaemonClient.connectOrStart({
            host: options.daemonHost,
            port: options.daemonPort,
            token: options.daemonToken,
          })
        }
        return daemonClient
      }
      try {
        result = await (await ensureDaemon()).callTool(name, args)
      } catch (err) {
        // Auto-recover if the local daemon restarted or exited while MCP remained open
        const msg = err instanceof Error ? err.message : String(err)
        if (/fetch failed|ECONNREFUSED|ECONNRESET|socket|Unauthorized/i.test(msg)) {
          daemonClient = null
          result = await (await ensureDaemon()).callTool(name, args)
        } else {
          throw err
        }
      }
    }

    return {
      isError: result.isError,
      content: result.content.map((item) => {
        if (item.type === 'image' && item.data && item.mimeType) {
          return { type: 'image' as const, data: item.data, mimeType: item.mimeType }
        }
        return { type: 'text' as const, text: item.text ?? '' }
      }),
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}
