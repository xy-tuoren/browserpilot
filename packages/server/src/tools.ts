import {
  createDemoVideo,
  formatConsoleLogs,
  formatNetworkEntries,
  formatStylesAsText,
  waitForPageLoad,
  waitForSelector,
  waitForText,
  type KeyModifier,
  type MouseButton,
  type SessionManager,
} from '@browserpilot/core'
import type { ActionFeedback, BrowserClientInfo, ConsoleLevel, TabGroupColor } from '@browserpilot/protocol'

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

function textResult(text: string, meta?: Record<string, unknown>): ToolExecutionResult {
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

function formatFeedbackSuffix(fb: ActionFeedback): string {
  const parts: string[] = [`URL: ${fb.url}`]
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

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser_status',
    description: 'Check connected Chrome extensions/browsers, active transports, and stateful sessions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_tabs',
    description: 'List all open Chrome tabs with tabId, URL, title, active state, and CDP attach status.',
    inputSchema: { type: 'object', properties: { clientId: { type: 'string' } } },
  },
  {
    name: 'browser_open_tab',
    description: 'Open a new Chrome tab (auto-attached with zero clicks) and optionally navigate to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (default about:blank)' },
        active: { type: 'boolean', description: 'Focus the new tab (default true)' },
        tabGroup: { type: 'string', description: 'Optional Chrome Tab Group name' },
        tabGroupColor: { type: 'string', description: 'Optional Tab Group color' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab by tabId.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_select_tab',
    description: 'Focus and auto-attach an existing Chrome tab by tabId or URL/title substring.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        urlContains: { type: 'string' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab to a URL and wait for load, returning URL, title, and any console/network errors.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        waitUntil: { type: 'string', enum: ['none', 'domcontentloaded', 'load', 'networkidle'] },
        timeoutMs: { type: 'number' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_history',
    description: 'Reload the page or navigate browser history back/forward.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['reload', 'back', 'forward'] },
        ignoreCache: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'Capture a compact semantic Accessibility Tree snapshot with short element refs (e1, e2...). Supports incremental diffing, regex search, and subtree scoping.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        search: { type: 'string', description: 'Filter lines matching substring/regex' },
        scope: { type: 'string', description: 'CSS selector or ref to scope snapshot to a subtree' },
        showDiffSinceLastCall: { type: 'boolean', description: 'Return concise diff since last snapshot (default true)' },
        includeText: { type: 'boolean' },
        includeIframes: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture a CSS-scaled screenshot (viewport, fullPage, or clip region) returned directly as an image.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        fullPage: { type: 'boolean' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
        quality: { type: 'number' },
        maxDimension: { type: 'number', description: 'Downscale longest edge to save vision tokens (default 1440)' },
        path: { type: 'string', description: 'Optional local file path to save the screenshot' },
        clip: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        },
      },
    },
  },
  {
    name: 'browser_labeled_screenshot',
    description:
      'Capture a Vimium-style Set-of-Mark screenshot overlaid with color-coded ref labels (e1, e2...) synchronized with the AXTree snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        maxLabels: { type: 'number' },
        maxDimension: { type: 'number' },
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_clean_html',
    description: 'Extract stripped semantic HTML (removes scripts/styles/empty wrappers) with optional search and diffing.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        search: { type: 'string' },
        showDiffSinceLastCall: { type: 'boolean' },
        includeStyles: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_markdown',
    description: 'Extract main article/page content as clean Readability-style Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        search: { type: 'string' },
        showDiffSinceLastCall: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_inspect_element',
    description: 'Inspect an element box, scroll overflow, visibility, input state, ARIA attributes, and computed styles.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Snapshot ref (e.g. e5) or CSS selector' },
        properties: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_click',
    description:
      'Perform a browser-trusted CDP mouse click on a snapshot ref, CSS selector, text=..., or (x,y) coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ref (e5), CSS selector, or text=...' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'number' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_fill',
    description: 'Focus an input/textarea/contenteditable, clear it, and insert text via trusted CDP input.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        value: { type: 'string' },
        clear: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target', 'value'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text character-by-character into the focused element or target element.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        target: { type: 'string' },
        delayMs: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key or shortcut combo (e.g. Enter, Escape, Tab, Meta+a, Control+Shift+r).',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_hover',
    description: 'Move mouse cursor over a target element or (x,y) coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll an element into view or dispatch mouse wheel scrolling.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_drag',
    description: 'Perform a smooth mouse drag or canvas stroke between two targets or coordinate pairs.',
    inputSchema: {
      type: 'object',
      properties: {
        fromTarget: { type: 'string' },
        toTarget: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        steps: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select an option in a <select> dropdown by option value or label text.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        value: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target', 'value'],
    },
  },
  {
    name: 'browser_upload_file',
    description: 'Attach one or more local files to an <input type="file"> element.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target', 'files'],
    },
  },
  {
    name: 'browser_handle_dialog',
    description: 'Accept/dismiss an active JS alert/confirm/prompt dialog or set automatic dialog handling.',
    inputSchema: {
      type: 'object',
      properties: {
        accept: { type: 'boolean' },
        promptText: { type: 'string' },
        auto: { type: 'boolean', description: 'Apply automatically to future dialogs until cleared' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['accept'],
    },
  },
  {
    name: 'browser_wait',
    description: 'Wait for page load (ignoring analytics), a CSS selector, visible text, or fixed milliseconds.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        pageLoad: { type: 'boolean' },
        ms: { type: 'number' },
        timeoutMs: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the page context (supports async/Promises) and return JSON result.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string' },
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
    name: 'browser_emulate',
    description: 'Emulate viewport size, mobile, color scheme (dark/light), CPU throttling, network preset, user-agent, timezone, locale, or geolocation.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        deviceScaleFactor: { type: 'number' },
        mobile: { type: 'boolean' },
        colorScheme: { type: 'string', enum: ['light', 'dark', 'no-preference'] },
        cpuThrottlingRate: { type: 'number' },
        networkPreset: { type: 'string', enum: ['online', 'offline', 'slow-3g', 'fast-3g', '4g'] },
        userAgent: { type: 'string' },
        timezone: { type: 'string' },
        locale: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_cookies',
    description: 'Safe page-scoped cookie operations (get, set, delete). Never clears profile-wide browser cookies.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'delete'] },
        name: { type: 'string' },
        value: { type: 'string' },
        domain: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_storage',
    description: 'Read, write, or clear localStorage or sessionStorage on the current origin.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['local', 'session'] },
        action: { type: 'string', enum: ['get', 'set', 'clear'] },
        key: { type: 'string' },
        value: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['kind', 'action'],
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
  {
    name: 'browser_record',
    description:
      'Record the active tab as an MP4/WebM video via CDP screencast + ffmpeg (optional page audio capture), or create a smart idle-sped-up demo video.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'cancel', 'create_demo'] },
        outputPath: { type: 'string' },
        recordingPath: { type: 'string' },
        frameRate: { type: 'number' },
        audio: { type: 'boolean', description: 'Tap page <audio>/<video>/AudioContext into the recording (default false)' },
        speed: { type: 'number', description: 'Speed multiplier for idle gaps (default 6 when actionTimestamps given, else 2)' },
        durationMs: { type: 'number' },
        actionTimestamps: { type: 'array', items: { type: 'number' }, description: 'Timestamps from stop() so only idle gaps are sped up while interactions stay 1x' },
        paddingMs: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_downloads',
    description: 'Configure download directory, list downloads, or wait for a file download to finish and return its local file path.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['configure', 'list', 'wait', 'clear'] },
        downloadDir: { type: 'string', description: 'Target folder for Direct CDP downloads' },
        filenamePattern: { type: 'string', description: 'Optional substring/regex to match downloaded filename' },
        timeoutMs: { type: 'number' },
        sinceTimestamp: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_action_recorder',
    description:
      'Record live user interactions (clicks, fills, selects, keys, scrolls, navigations) across page loads and generate reusable browser_batch steps, exec JS script, and Agent Skill Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status'] },
        maskPasswords: { type: 'boolean', description: 'Mask password inputs as <REDACTED_PASSWORD> (default true)' },
        format: { type: 'string', enum: ['all', 'batch', 'script', 'skill'] },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_exec',
    description:
      'Execute a multi-step async JavaScript snippet inside an isolated stateful session sandbox with helpers (state, tabs, snapshot, screenshot, cleanHTML, markdown, inspect, getLatestLogs, getNetwork, getStyles, getReactInfo, cdp).',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        sessionId: { type: 'string', description: 'Session ID (default "default")' },
        tabId: { type: 'number' },
        timeoutMs: { type: 'number' },
      },
      required: ['code'],
    },
  },
  {
    name: 'browser_batch',
    description:
      'Execute a sequence of browser actions (navigate, click, fill, type, press_key, select_option, hover, scroll, wait) in a single round-trip and optionally return the post-batch snapshot and error feedback.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['navigate', 'click', 'fill', 'type', 'press_key', 'select_option', 'hover', 'scroll', 'wait'],
              },
              target: { type: 'string' },
              value: { type: 'string' },
              url: { type: 'string' },
              key: { type: 'string' },
              text: { type: 'string' },
              selector: { type: 'string' },
              direction: { type: 'string' },
              amount: { type: 'number' },
              ms: { type: 'number' },
            },
            required: ['action'],
          },
        },
        returnSnapshot: { type: 'boolean', description: 'Include post-batch AXTree snapshot (default true)' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'browser_pinned',
    description:
      'Inspect the element last pinned by the user via right-click -> "Pin Element for BrowserPilot" (returns outerHTML, inspect box/styles, and React Fiber info).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
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

    const resolveTab = () => manager.resolveActiveTab({ tabId: explicitTabId, sessionId })

    switch (name) {
      case 'browser_tabs': {
        const tabs = await manager.listTabs()
        const formatted = tabs
          .map(
            (t) =>
              `[${t.tabId}]${t.active ? ' *' : ''}${t.attached ? ' [CDP]' : ''} ${t.title || '(untitled)'} — ${t.url}`,
          )
          .join('\n')
        return textResult(formatted || '(no tabs open)', { tabs })
      }

      case 'browser_open_tab': {
        const targetUrl = normalizeNavigationUrl(args.url as string | undefined)
        const tab = await manager.openTab({
          url: targetUrl,
          active: args.active as boolean | undefined,
          tabGroup: args.tabGroup as string | undefined,
          tabGroupColor: args.tabGroupColor as TabGroupColor | undefined,
        })
        if (sessionId) manager.getOrCreateSession(sessionId).activeTabId = tab.tabId
        if (/^https?:\/\//i.test(targetUrl)) {
          await waitForPageLoad(tab.session, { timeoutMs: 10_000, idleMs: 250, ignoreAboutBlank: true }).catch(() => {})
        }
        const meta = await tab.page.getUrlAndTitle().catch(() => ({ url: targetUrl, title: '' }))
        return textResult(`Opened and attached tab [${tab.tabId}]: ${meta.url}${meta.title ? ` ("${meta.title}")` : ''}`, {
          tabId: tab.tabId,
          ...meta,
        })
      }

      case 'browser_close_tab': {
        await manager.closeTab(Number(args.tabId))
        return textResult(`Closed tab [${args.tabId}]`)
      }

      case 'browser_select_tab': {
        let targetId = explicitTabId
        if (targetId === undefined && typeof args.urlContains === 'string') {
          const all = await manager.listTabs()
          const hit = [...all]
            .reverse()
            .find((t) => t.url.includes(args.urlContains as string) || t.title.includes(args.urlContains as string))
          if (!hit) throw new Error(`No tab matching "${args.urlContains}"`)
          targetId = hit.tabId
        }
        if (targetId === undefined) throw new Error('Provide tabId or urlContains')
        await manager.getTransport().activateTab(targetId)
        const tab = await manager.getOrAttachTab(targetId)
        if (sessionId) manager.getOrCreateSession(sessionId).activeTabId = tab.tabId
        const meta = await tab.page.getUrlAndTitle()
        return textResult(`Selected and attached tab [${tab.tabId}]: ${meta.title} (${meta.url})`, { tabId: tab.tabId })
      }

      case 'browser_navigate': {
        const tab = await resolveTab()
        const targetUrl = normalizeNavigationUrl(String(args.url))
        const { result, feedback } = await tab.runWithFeedback(() =>
          tab.page.navigate(targetUrl, {
            waitUntil: (args.waitUntil as 'none' | 'domcontentloaded' | 'load' | 'networkidle') ?? 'domcontentloaded',
            timeoutMs: args.timeoutMs as number | undefined,
          }),
        )
        return textResult(`Navigated tab [${tab.tabId}] to ${result.url} ("${result.title}")\n${formatFeedbackSuffix(feedback)}`)
      }

      case 'browser_history': {
        const tab = await resolveTab()
        const action = String(args.action)
        const res =
          action === 'reload'
            ? await tab.page.reload(Boolean(args.ignoreCache))
            : action === 'back'
              ? await tab.page.goBack()
              : await tab.page.goForward()
        return textResult(`History ${action} complete: ${res.url} ("${res.title}")`)
      }

      case 'browser_snapshot': {
        const tab = await resolveTab()
        const snap = await tab.snapshots.capture(tab.session, {
          search: args.search as string | undefined,
          scope: args.scope as string | undefined,
          showDiffSinceLastCall: args.showDiffSinceLastCall as boolean | undefined,
          includeText: args.includeText as boolean | undefined,
          includeIframes: args.includeIframes as boolean | undefined,
        })
        return textResult(snap.text, { totalRefs: snap.totalRefs, isDiff: snap.isDiff, tabId: tab.tabId })
      }

      case 'browser_screenshot': {
        const tab = await resolveTab()
        const shot = await tab.page.screenshot({
          fullPage: args.fullPage as boolean | undefined,
          format: args.format as 'png' | 'jpeg' | 'webp' | undefined,
          quality: args.quality as number | undefined,
          maxDimension: (args.maxDimension as number | undefined) ?? 1440,
          path: args.path as string | undefined,
          clip: args.clip as { x: number; y: number; width: number; height: number } | undefined,
        })
        return {
          content: [
            { type: 'text', text: shot.path ? `Screenshot saved to ${shot.path}` : `Captured screenshot of tab [${tab.tabId}]` },
            { type: 'image', data: shot.base64, mimeType: shot.mimeType },
          ],
          meta: { path: shot.path, tabId: tab.tabId },
        }
      }

      case 'browser_labeled_screenshot': {
        const tab = await resolveTab()
        const som = await tab.captureLabeledScreenshot({
          maxLabels: args.maxLabels as number | undefined,
          maxDimension: (args.maxDimension as number | undefined) ?? 1440,
          path: args.path as string | undefined,
        })
        return {
          content: [
            { type: 'text', text: `Labeled ${som.labelsCount} interactive elements:\n\n${som.snapshot.text}` },
            { type: 'image', data: som.base64, mimeType: som.mimeType },
          ],
          meta: { labelsCount: som.labelsCount, path: som.path },
        }
      }

      case 'browser_clean_html': {
        const tab = await resolveTab()
        const html = await tab.extractor.getCleanHTML(tab.session, {
          selector: args.selector as string | undefined,
          search: args.search as string | undefined,
          showDiffSinceLastCall: args.showDiffSinceLastCall as boolean | undefined,
          includeStyles: args.includeStyles as boolean | undefined,
        })
        return textResult(html)
      }

      case 'browser_markdown': {
        const tab = await resolveTab()
        const md = await tab.extractor.getPageMarkdown(tab.session, {
          search: args.search as string | undefined,
          showDiffSinceLastCall: args.showDiffSinceLastCall as boolean | undefined,
        })
        return textResult(md)
      }

      case 'browser_inspect_element': {
        const tab = await resolveTab()
        const info = await tab.extractor.inspectElement(
          tab.session,
          tab.snapshots,
          String(args.target),
          args.properties as string[] | undefined,
        )
        return textResult(info.formatted, { info })
      }

      case 'browser_click': {
        const tab = await resolveTab()
        const target =
          typeof args.target === 'string'
            ? args.target
            : typeof args.x === 'number' && typeof args.y === 'number'
              ? { x: args.x, y: args.y }
              : null
        if (!target) throw new Error('Provide either target or (x, y) coordinates')
        const { feedback } = await tab.runWithFeedback(() =>
          tab.page.click(target, {
            button: args.button as MouseButton | undefined,
            clickCount: args.clickCount as number | undefined,
            modifiers: args.modifiers as KeyModifier[] | undefined,
          }),
        )
        return textResult(`Clicked ${typeof target === 'string' ? target : `(${target.x}, ${target.y})`}\n${formatFeedbackSuffix(feedback)}`)
      }

      case 'browser_fill': {
        const tab = await resolveTab()
        const { feedback } = await tab.runWithFeedback(() =>
          tab.page.fill(String(args.target), String(args.value), { clear: args.clear as boolean | undefined }),
        )
        return textResult(`Filled ${args.target}\n${formatFeedbackSuffix(feedback)}`)
      }

      case 'browser_type': {
        const tab = await resolveTab()
        const { feedback } = await tab.runWithFeedback(() =>
          tab.page.type((args.target as string | undefined) ?? null, String(args.text), {
            delayMs: args.delayMs as number | undefined,
          }),
        )
        return textResult(`Typed text\n${formatFeedbackSuffix(feedback)}`)
      }

      case 'browser_press_key': {
        const tab = await resolveTab()
        const { feedback } = await tab.runWithFeedback(() => tab.page.pressKey(String(args.key)))
        return textResult(`Pressed ${args.key}\n${formatFeedbackSuffix(feedback)}`)
      }

      case 'browser_hover': {
        const tab = await resolveTab()
        const target =
          typeof args.target === 'string'
            ? args.target
            : typeof args.x === 'number' && typeof args.y === 'number'
              ? { x: args.x, y: args.y }
              : null
        if (!target) throw new Error('Provide either target or (x, y)')
        await tab.page.hover(target)
        return textResult(`Hovered ${typeof target === 'string' ? target : `(${target.x}, ${target.y})`}`)
      }

      case 'browser_scroll': {
        const tab = await resolveTab()
        await tab.page.scroll({
          target: args.target as string | undefined,
          direction: args.direction as 'up' | 'down' | 'left' | 'right' | undefined,
          amount: args.amount as number | undefined,
          deltaX: args.deltaX as number | undefined,
          deltaY: args.deltaY as number | undefined,
        })
        return textResult('Scrolled successfully')
      }

      case 'browser_drag': {
        const tab = await resolveTab()
        const from =
          typeof args.fromTarget === 'string'
            ? args.fromTarget
            : { x: Number(args.fromX ?? 0), y: Number(args.fromY ?? 0) }
        const to =
          typeof args.toTarget === 'string'
            ? args.toTarget
            : { x: Number(args.toX ?? 0), y: Number(args.toY ?? 0) }
        await tab.page.drag(from, to, { steps: args.steps as number | undefined })
        return textResult('Drag completed')
      }

      case 'browser_select_option': {
        const tab = await resolveTab()
        const selected = await tab.page.selectOption(String(args.target), String(args.value))
        return textResult(`Selected option "${selected}" in ${args.target}`)
      }

      case 'browser_upload_file': {
        const tab = await resolveTab()
        const files = (args.files as string[]) ?? []
        await tab.page.uploadFiles(String(args.target), files)
        return textResult(`Uploaded ${files.length} file(s) to ${args.target}`)
      }

      case 'browser_handle_dialog': {
        const tab = await resolveTab()
        const accept = Boolean(args.accept)
        const promptText = args.promptText as string | undefined
        if (args.auto) {
          tab.session.setAutoDialog({ accept, promptText })
          return textResult(`Set auto-dialog policy: accept=${accept}`)
        }
        await tab.session.handleDialog(accept, promptText)
        return textResult(`Handled JS dialog: accept=${accept}`)
      }

      case 'browser_wait': {
        const tab = await resolveTab()
        const timeoutMs = (args.timeoutMs as number | undefined) ?? 10_000
        if (typeof args.ms === 'number') {
          await new Promise((r) => setTimeout(r, args.ms as number))
          return textResult(`Waited ${args.ms}ms`)
        }
        if (typeof args.selector === 'string') {
          await waitForSelector(tab.session, args.selector, { timeoutMs })
          return textResult(`Selector visible: ${args.selector}`)
        }
        if (typeof args.text === 'string') {
          await waitForText(tab.session, args.text, { timeoutMs })
          return textResult(`Text appeared: ${args.text}`)
        }
        const res = await waitForPageLoad(tab.session, { timeoutMs })
        return textResult(JSON.stringify(res))
      }

      case 'browser_evaluate': {
        const tab = await resolveTab()
        const val = await tab.page.evaluate(String(args.expression))
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

      case 'browser_emulate': {
        const tab = await resolveTab()
        await tab.page.emulate({
          width: args.width as number | undefined,
          height: args.height as number | undefined,
          deviceScaleFactor: args.deviceScaleFactor as number | undefined,
          mobile: args.mobile as boolean | undefined,
          colorScheme: args.colorScheme as 'light' | 'dark' | 'no-preference' | undefined,
          cpuThrottlingRate: args.cpuThrottlingRate as number | undefined,
          networkPreset: args.networkPreset as 'online' | 'offline' | 'slow-3g' | 'fast-3g' | '4g' | undefined,
          userAgent: args.userAgent as string | undefined,
          timezone: args.timezone as string | undefined,
          locale: args.locale as string | undefined,
          geolocation:
            typeof args.latitude === 'number' && typeof args.longitude === 'number'
              ? { latitude: args.latitude, longitude: args.longitude }
              : undefined,
        })
        return textResult('Emulation settings applied')
      }

      case 'browser_cookies': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'get') {
          const cookies = await tab.page.getCookies(args.url ? [String(args.url)] : undefined)
          return textResult(JSON.stringify(cookies, null, 2))
        }
        if (action === 'set') {
          await tab.page.setCookie({
            name: String(args.name),
            value: String(args.value ?? ''),
            url: args.url as string | undefined,
            domain: args.domain as string | undefined,
            path: args.path as string | undefined,
          })
          return textResult(`Set cookie "${args.name}"`)
        }
        if (action === 'delete') {
          await tab.page.deleteCookies(String(args.name), {
            url: args.url as string | undefined,
            domain: args.domain as string | undefined,
            path: args.path as string | undefined,
          })
          return textResult(`Deleted cookie "${args.name}"`)
        }
        throw new Error(`Unknown cookies action: ${action}`)
      }

      case 'browser_storage': {
        const tab = await resolveTab()
        const kind = args.kind === 'session' ? 'session' : 'local'
        const action = String(args.action)
        if (action === 'get') return textResult(JSON.stringify(await tab.page.getStorage(kind), null, 2))
        if (action === 'set') {
          await tab.page.setStorage(kind, String(args.key), String(args.value ?? ''))
          return textResult(`Set ${kind}Storage["${args.key}"]`)
        }
        if (action === 'clear') {
          await tab.page.clearStorage(kind)
          return textResult(`Cleared ${kind}Storage`)
        }
        throw new Error(`Unknown storage action: ${action}`)
      }

      case 'browser_cdp': {
        const tab = await resolveTab()
        const res = await tab.session.send(
          String(args.method),
          args.params as Record<string, unknown> | undefined,
        )
        return textResult(JSON.stringify(res, null, 2))
      }

      case 'browser_record': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'start') {
          const out = await tab.recorder.start({
            outputPath: String(args.outputPath ?? `./browserpilot-recording-${Date.now()}.mp4`),
            frameRate: args.frameRate as number | undefined,
            audio: args.audio as boolean | undefined,
          })
          return textResult(`Recording started -> ${out.outputPath}${out.audio ? ' (audio tap enabled)' : ''}`)
        }
        if (action === 'stop') {
          const res = await tab.recorder.stop()
          return textResult(JSON.stringify(res, null, 2))
        }
        if (action === 'cancel') {
          await tab.recorder.cancel()
          return textResult('Recording cancelled')
        }
        if (action === 'create_demo') {
          const out = await createDemoVideo({
            recordingPath: String(args.recordingPath),
            outputPath: args.outputPath as string | undefined,
            speed: args.speed as number | undefined,
            durationMs: args.durationMs as number | undefined,
            actionTimestamps: args.actionTimestamps as number[] | undefined,
            paddingMs: args.paddingMs as number | undefined,
          })
          return textResult(`Created demo video -> ${out}`)
        }
        throw new Error(`Unknown record action: ${action}`)
      }

      case 'browser_downloads': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'configure') {
          const res = await tab.downloads.configure(args.downloadDir as string | undefined)
          return textResult(JSON.stringify(res, null, 2))
        }
        if (action === 'list') {
          const list = await tab.downloads.list()
          return textResult(JSON.stringify(list, null, 2))
        }
        if (action === 'wait') {
          const entry = await tab.downloads.waitForDownload({
            timeoutMs: args.timeoutMs as number | undefined,
            filenamePattern: args.filenamePattern as string | undefined,
            sinceTimestamp: args.sinceTimestamp as number | undefined,
          })
          return textResult(JSON.stringify(entry, null, 2))
        }
        if (action === 'clear') {
          tab.downloads.clear()
          return textResult('Cleared tracked downloads')
        }
        throw new Error(`Unknown downloads action: ${action}`)
      }

      case 'browser_action_recorder': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'start') {
          const res = await tab.actionRecorder.start({
            maskPasswords: args.maskPasswords as boolean | undefined,
          })
          return textResult(`Action recording started on ${res.url || `tab [${tab.tabId}]`}`)
        }
        if (action === 'status') {
          return textResult(
            JSON.stringify(
              {
                recording: tab.actionRecorder.isRecording(),
                recordedSteps: tab.actionRecorder.getSteps().length,
              },
              null,
              2,
            ),
          )
        }
        if (action === 'stop') {
          const res = await tab.actionRecorder.stop()
          const fmt = String(args.format ?? 'all')
          if (fmt === 'skill') return textResult(res.skillMarkdown)
          if (fmt === 'script') return textResult(res.execScript)
          if (fmt === 'batch') return textResult(JSON.stringify(res.batchSteps, null, 2))
          return textResult(JSON.stringify(res, null, 2))
        }
        throw new Error(`Unknown action_recorder action: ${action}`)
      }

      case 'browser_exec': {
        const res = await manager.exec(sessionId ?? 'default', String(args.code), {
          timeoutMs: args.timeoutMs as number | undefined,
          tabId: explicitTabId,
        })
        const chunks: string[] = []
        if (res.stdout) chunks.push(res.stdout)
        if (res.returnValue !== undefined) {
          chunks.push(`=> ${typeof res.returnValue === 'string' ? res.returnValue : JSON.stringify(res.returnValue, null, 2)}`)
        }
        if (res.uncaughtBrowserErrors.length > 0) {
          chunks.push(`Uncaught browser errors:\n${res.uncaughtBrowserErrors.join('\n')}`)
        }
        if (res.error) {
          return { content: [{ type: 'text', text: `${chunks.join('\n')}\nERROR: ${res.error}`.trim() }], isError: true }
        }
        return textResult(chunks.join('\n') || '(ok)')
      }

      case 'browser_batch': {
        const tab = await resolveTab()
        const steps = (args.steps as Array<Record<string, unknown>>) ?? []
        const completed: string[] = []
        const { feedback } = await tab.runWithFeedback(async () => {
          for (let i = 0; i < steps.length; i++) {
            const s = steps[i]
            const act = String(s.action)
            switch (act) {
              case 'navigate':
                await tab.page.navigate(String(s.url))
                completed.push(`${i + 1}. navigate(${s.url})`)
                break
              case 'click':
                await tab.page.click(String(s.target))
                completed.push(`${i + 1}. click(${s.target})`)
                break
              case 'fill':
                await tab.page.fill(String(s.target), String(s.value ?? ''))
                completed.push(`${i + 1}. fill(${s.target})`)
                break
              case 'type':
                await tab.page.type((s.target as string | undefined) ?? null, String(s.text ?? s.value ?? ''))
                completed.push(`${i + 1}. type(${s.target ?? 'focused'})`)
                break
              case 'press_key':
                await tab.page.pressKey(String(s.key))
                completed.push(`${i + 1}. press_key(${s.key})`)
                break
              case 'select_option':
                await tab.page.selectOption(String(s.target), String(s.value))
                completed.push(`${i + 1}. select_option(${s.target}, ${s.value})`)
                break
              case 'hover':
                await tab.page.hover(String(s.target))
                completed.push(`${i + 1}. hover(${s.target})`)
                break
              case 'scroll':
                await tab.page.scroll({
                  target: s.target as string | undefined,
                  direction: s.direction as 'up' | 'down' | 'left' | 'right' | undefined,
                  amount: s.amount as number | undefined,
                })
                completed.push(`${i + 1}. scroll`)
                break
              case 'wait':
                if (typeof s.ms === 'number') await new Promise((r) => setTimeout(r, s.ms as number))
                else if (typeof s.selector === 'string') await waitForSelector(tab.session, s.selector)
                else if (typeof s.text === 'string') await waitForText(tab.session, s.text)
                else await waitForPageLoad(tab.session)
                completed.push(`${i + 1}. wait`)
                break
              default:
                throw new Error(`Unsupported batch step action: ${act}`)
            }
          }
        })

        const outParts = [`Completed ${completed.length} batch steps:\n${completed.join('\n')}`, formatFeedbackSuffix(feedback)]
        if (args.returnSnapshot !== false) {
          const snap = await tab.snapshots.capture(tab.session)
          outParts.push(`\n${snap.text}`)
        }
        return textResult(outParts.join('\n'))
      }

      case 'browser_pinned': {
        const tab = await resolveTab()
        const pinnedMeta = await tab.session.transport.getPinnedElement?.(tab.tabId).catch(() => null)
        const target = pinnedMeta?.globalVar || 'pinned'
        const html = await tab.page.evaluate<string | null>(`(() => {
          const el = ${target === 'pinned' ? '(() => { const ks = Object.keys(globalThis).filter(k => k.startsWith("__browserpilotPinned")); return ks.length ? globalThis[ks[ks.length - 1]] : null; })()' : target};
          return el ? el.outerHTML.slice(0, 2000) : null;
        })()`)
        if (!html) {
          return textResult('No pinned element found on this tab. Right-click an element and choose "Pin Element for BrowserPilot".')
        }
        const inspected = await tab.extractor.inspectElement(tab.session, tab.snapshots, target).catch(() => null)
        const reactInfo = await tab.getReactInfo(target).catch(() => null)
        return textResult(
          [
            `Pinned Element (${target}):`,
            html,
            inspected ? `\n${inspected.formatted}` : '',
            reactInfo ? `\nReact: ${JSON.stringify(reactInfo, null, 2)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        )
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    }
  }
}
