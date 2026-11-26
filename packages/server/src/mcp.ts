import crypto from 'node:crypto'
import http from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DirectCDPTransport, SessionManager } from '@browserpilot/core'
import { BROWSERPILOT_VERSION, DEFAULT_DAEMON_HOST, type BrowserClientInfo } from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import { loadOrCreateDaemonConfig } from './config.js'
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
  /** Expose all 53 tools instead of the lean low-token core profile */
  full?: boolean
  /** Comma-separated or array of capability groups: core, interaction, extraction, devtools, context, media, all */
  capabilities?: string | string[]
  /** Serve MCP over Streamable HTTP instead of stdio */
  http?: boolean
  /** Bind host for Streamable HTTP mode (default 127.0.0.1) */
  httpHost?: string
  /** Bind port for Streamable HTTP mode (default 19889; pass 0 for ephemeral test port) */
  httpPort?: number
  /** Optional Bearer token for Streamable HTTP mode (defaults to ~/.browserpilot/daemon.json token) */
  httpToken?: string
}

export interface RunningMcpHttpServer {
  host: string
  port: number
  url: string
  token: string
  toolCount: number
  close: () => Promise<void>
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
    'browser_touch',
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

async function createMcpToolExecutor(options: StartMcpOptions): Promise<{
  advertisedTools: ToolDefinition[]
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>
  dispose: () => Promise<void>
}> {
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

  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    if (directManager && directClientInfo) {
      const ctx: ToolRuntimeContext = {
        getManager: () => directManager!,
        listClients: () => [directClientInfo!],
      }
      return await executeTool(ctx, name, args)
    }

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
      return await (await ensureDaemon()).callTool(name, args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/fetch failed|ECONNREFUSED|ECONNRESET|socket|Unauthorized/i.test(msg)) {
        daemonClient = null
        return await (await ensureDaemon()).callTool(name, args)
      }
      throw err
    }
  }

  return {
    advertisedTools,
    callTool,
    dispose: async () => {
      directManager?.dispose()
    },
  }
}

function buildMcpServerInstance(
  advertisedTools: ToolDefinition[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>,
): Server {
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
    const result = await callTool(name, args)
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

  return server
}

/**
 * Starts the BrowserPilot Model Context Protocol (MCP) server on Streamable HTTP (`/mcp`)
 * authenticated via Bearer token, supporting multi-client remote or local agent connections.
 */
export async function startMcpHttpServer(options: StartMcpOptions = {}): Promise<RunningMcpHttpServer> {
  const executor = await createMcpToolExecutor(options)
  const cfg = await loadOrCreateDaemonConfig().catch(() => null)
  const host = options.httpHost ?? DEFAULT_DAEMON_HOST
  const port = options.httpPort ?? 19889
  const token = options.httpToken ?? options.daemonToken ?? cfg?.token ?? crypto.randomBytes(24).toString('hex')

  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>()

  const readJsonBody = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    return raw ? JSON.parse(raw) : undefined
  }

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port || 19889}`)
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          ok: true,
          transport: 'streamable-http',
          version: BROWSERPILOT_VERSION,
          tools: executor.advertisedTools.length,
          activeSessions: sessions.size,
        }),
      )
      return
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Not Found. Use /mcp for Streamable HTTP MCP.' }))
      return
    }

    const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const queryToken = url.searchParams.get('token')?.trim() || ''
    if (token && auth !== token && queryToken !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Unauthorized: provide Authorization: Bearer <token>' }))
      return
    }

    try {
      const sessionIdHeader = req.headers['mcp-session-id']
      const sid = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader

      if (sid && sessions.has(sid)) {
        const entry = sessions.get(sid)!
        const body = req.method === 'POST' ? await readJsonBody(req) : undefined
        await entry.transport.handleRequest(req, res, body)
        return
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req)
        const isInit =
          body &&
          typeof body === 'object' &&
          ((body as { method?: string }).method === 'initialize' ||
            (Array.isArray(body) && body.some((m) => m && typeof m === 'object' && (m as { method?: string }).method === 'initialize')))

        if (isInit) {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newSid) => {
              sessions.set(newSid, { transport, server })
            },
          })
          const server = buildMcpServerInstance(executor.advertisedTools, executor.callTool)
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId)
          }
          await server.connect(transport)
          await transport.handleRequest(req, res, body)
          return
        }

        // Stateless single-shot POST request fallback (clients that omit initialize/session header)
        const statelessTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
        const statelessServer = buildMcpServerInstance(executor.advertisedTools, executor.callTool)
        res.on('close', () => {
          void statelessTransport.close().catch(() => {})
          void statelessServer.close().catch(() => {})
        })
        await statelessServer.connect(statelessTransport)
        await statelessTransport.handleRequest(req, res, body)
        return
      }

      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'Invalid or missing mcp-session-id header' }))
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })

  const addr = httpServer.address()
  const actualPort = addr && typeof addr === 'object' ? addr.port : port
  const endpointUrl = `http://${host}:${actualPort}/mcp`

  return {
    host,
    port: actualPort,
    url: endpointUrl,
    token,
    toolCount: executor.advertisedTools.length,
    close: async () => {
      for (const { transport, server } of sessions.values()) {
        await transport.close().catch(() => {})
        await server.close().catch(() => {})
      }
      sessions.clear()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      await executor.dispose()
    },
  }
}

/**
 * Starts the BrowserPilot Model Context Protocol (MCP) server on stdio (default) or Streamable HTTP (`--http`).
 * Advertises the lean `core` toolset by default (or optional capability groups / `--full` 53 tools),
 * while `tools/call` still supports invoking any registered BrowserPilot tool.
 */
export async function startMcpServer(options: StartMcpOptions = {}): Promise<void> {
  if (options.http) {
    const running = await startMcpHttpServer(options)
    console.error(
      `BrowserPilot MCP Streamable HTTP server v${BROWSERPILOT_VERSION} listening on ${running.url} (${running.toolCount} tools)`,
    )
    console.error(`Authorization: Bearer ${running.token}`)
    const shutdown = () => {
      void running.close().then(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    return
  }

  const executor = await createMcpToolExecutor(options)
  const server = buildMcpServerInstance(executor.advertisedTools, executor.callTool)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
