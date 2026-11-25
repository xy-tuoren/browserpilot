import type { BrowserPilotTab, SessionManager } from '@browserpilot/core'
import type { ActionFeedback, BrowserClientInfo } from '@browserpilot/protocol'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolResultContent {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}

export interface ToolExecutionResult {
  content: ToolResultContent[]
  isError?: boolean
  meta?: Record<string, unknown>
}

export interface ToolRuntimeContext {
  getManager(clientId?: string): SessionManager
  listClients(): BrowserClientInfo[]
}

export interface ToolDispatchContext {
  manager: SessionManager
  sessionId?: string
  explicitTabId?: number
  resolveTab: () => Promise<BrowserPilotTab>
}

export function textResult(text: string, meta?: Record<string, unknown>): ToolExecutionResult {
  return { content: [{ type: 'text', text }], meta }
}

export function normalizeNavigationUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'about:blank'
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed
  if (/^(about|data|file|javascript|mailto|blob|view-source):/i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

export function formatFeedbackSuffix(fb: ActionFeedback): string {
  const parts: string[] = [`URL: ${fb.url}`]
  if (fb.openedTabs && fb.openedTabs.length > 0) {
    parts.push(
      `Opened new tab(s) (${fb.openedTabs.length}):\n${fb.openedTabs
        .map((t) => `  - [${t.tabId}] ${t.url}${t.title ? ` ("${t.title}")` : ''}`)
        .join('\n')}`,
    )
  }
  if (fb.dialogs && fb.dialogs.length > 0) {
    parts.push(
      `JS dialog(s) (${fb.dialogs.length}):\n${fb.dialogs
        .map((d) => `  - [${d.type}${d.handled ? ', handled' : ''}] ${d.message.slice(0, 200)}`)
        .join('\n')}`,
    )
  }
  if (fb.newConsoleErrors.length > 0) {
    parts.push(
      `New console errors (${fb.newConsoleErrors.length}):\n${fb.newConsoleErrors
        .slice(0, 5)
        .map((e) => `  - [${e.level}] ${e.text.slice(0, 200)}`)
        .join('\n')}`,
    )
  }
  if (fb.newFailedRequests.length > 0) {
    parts.push(
      `New failed requests (${fb.newFailedRequests.length}):\n${fb.newFailedRequests
        .slice(0, 5)
        .map((r) => `  - ${r.method} ${r.status ?? r.errorText} ${r.url}`)
        .join('\n')}`,
    )
  }
  return parts.join('\n')
}
