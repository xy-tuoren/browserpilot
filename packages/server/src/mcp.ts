import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DirectCDPTransport, SessionManager } from '@browserpilot/core'
import { BROWSERPILOT_VERSION, type BrowserClientInfo } from '@browserpilot/protocol'
import { DaemonClient } from './client.js'
import { executeTool, TOOL_DEFINITIONS, type ToolExecutionResult, type ToolRuntimeContext } from './tools.js'

export interface StartMcpOptions {
  cdpEndpoint?: string
  daemonHost?: string
  daemonPort?: number
  daemonToken?: string
}

/**
 * Starts the BrowserPilot Model Context Protocol (MCP) server on stdio.
 * Exposes all 39 pure-CDP browser automation & DevTools debugging tools to
 * Claude Code, Cursor, Codex, Antigravity, or any MCP-compatible agent.
 */
export async function startMcpServer(options: StartMcpOptions = {}): Promise<void> {
  let directManager: SessionManager | null = null
  let directClientInfo: BrowserClientInfo | null = null
  let daemonClient: DaemonClient | null = null

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
    tools: TOOL_DEFINITIONS.map((t) => ({
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
      if (!daemonClient) {
        daemonClient = await DaemonClient.connectOrStart({
          host: options.daemonHost,
          port: options.daemonPort,
          token: options.daemonToken,
        })
      }
      result = await daemonClient.callTool(name, args)
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
