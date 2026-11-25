import {
  createDemoVideo,
  formatConsoleLogs,
  formatNetworkEntries,
  formatStylesAsText,
  waitForFunction,
  waitForPageLoad,
  waitForSelector,
  waitForText,
  waitForUrl,
  type FormFieldInput,
  type KeyModifier,
  type MouseButton,
  type PdfOptions,
  type SessionManager,
  type WaitSelectorState,
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
      'Capture a compact semantic Accessibility Tree snapshot with short element refs (e1, e2...). Supports incremental diffing, regex search, subtree scoping, and single-frame targeting.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        search: { type: 'string', description: 'Filter lines matching substring/regex' },
        scope: { type: 'string', description: 'CSS selector or ref to scope snapshot to a subtree' },
        frame: { type: 'string', description: 'Iframe CSS selector, frameId, name, or URL substring/regex to snapshot a single frame' },
        showDiffSinceLastCall: { type: 'boolean', description: 'Return concise diff since last snapshot (default true)' },
        includeText: { type: 'boolean' },
        includeIframes: { type: 'boolean' },
      },
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture a clean CSS-scaled screenshot (viewport, fullPage, clip, or 2x zoomed region) with optional coordinate grid overlay for Canvas/Figma/PDF targeting.',
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
        grid: { type: 'boolean', description: 'Overlay a translucent pixel coordinate grid with axis labels (useful for Canvas/PDF)' },
        gridStep: { type: 'number', description: 'Grid spacing in CSS pixels (default 200, or 50 when zoomed)' },
        clip: {
          type: 'object',
          properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        },
        zoom: {
          type: 'object',
          description: 'Crop & upscale a viewport region (e.g. 2x zoom into tiny icons/charts)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            scale: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
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
      'Perform a browser-trusted CDP mouse click on a snapshot ref, CSS selector, rich locator, or (x,y) coordinates. Checks pre-click stability & occlusion automatically unless force=true.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ref (e5), CSS selector, role=..., label=..., or text=...' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        clickCount: { type: 'number' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
        force: { type: 'boolean', description: 'Bypass pre-click occlusion & stability checks' },
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
    description:
      'Press, hold (down), or release (up) a keyboard key or shortcut combo (e.g. Enter, Escape, Tab, Cmd+a, Control+Shift+r) with optional repeat count and native editor commands.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        action: { type: 'string', enum: ['press', 'down', 'up'], description: 'Key action (default press)' },
        repeat: { type: 'number', description: 'Repeat count for press (1-50, default 1)' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } },
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
    description: 'Perform a smooth mouse drag between two targets/coordinates, or a multi-point freehand canvas stroke via points[].',
    inputSchema: {
      type: 'object',
      properties: {
        fromTarget: { type: 'string' },
        toTarget: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        points: {
          type: 'array',
          description: 'Optional multi-point waypoint path [{x,y}, ...] for continuous held-mouse stroke drawing',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
        },
        steps: { type: 'number' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select one or more options in a <select> dropdown by option value or visible label text.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        value: { type: 'string', description: 'Single option value or label' },
        values: { type: 'array', items: { type: 'string' }, description: 'Multiple option values/labels for <select multiple>' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
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
    description:
      'Wait for a locator state (visible/hidden/attached/detached), text appearance/disappearance, URL pattern, matching network response, JS condition (fn), new popup tab, page load, or fixed ms.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS, rich, or chained locator (e.g. .spinner, role=dialog, iframe#pay >> button)' },
        state: { type: 'string', enum: ['visible', 'hidden', 'attached', 'detached'], description: 'Desired selector state (default visible)' },
        text: { type: 'string' },
        gone: { type: 'boolean', description: 'When waiting for text, wait until text disappears' },
        url: { type: 'string', description: 'Wait until location.href matches substring, glob (*), or regex' },
        responseUrl: { type: 'string', description: 'Wait for a completed network response whose URL matches substring/glob/regex' },
        responseStatus: { type: 'number', description: 'Optional HTTP status filter for responseUrl' },
        responseMethod: { type: 'string', description: 'Optional HTTP method filter for responseUrl' },
        fn: { type: 'string', description: 'JavaScript expression or arrow function polled until truthy' },
        popup: { type: 'boolean', description: 'Wait for a newly opened tab/popup and return its tabId' },
        frame: { type: 'string', description: 'Optional iframe selector/URL/frameId for selector, text, or fn wait' },
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
  {
    name: 'browser_fill_form',
    description:
      'Fill multiple form fields (text inputs, textareas, selects/multi-selects, checkboxes, radios, range sliders, file inputs) in a single round-trip with automatic field-type detection.',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              target: { type: 'string', description: 'Ref (e4), CSS selector, chained locator, label=..., or placeholder=...' },
              value: { description: 'Text value, select option(s), number for range, file path(s), or boolean for checkboxes' },
              type: { type: 'string', enum: ['auto', 'text', 'select', 'checkbox', 'radio', 'range', 'file'] },
            },
            required: ['target', 'value'],
          },
        },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['fields'],
    },
  },
  {
    name: 'browser_handoff',
    description:
      'Display an interactive in-page Human Handoff card ("BrowserPilot · Your Turn") asking the user to perform a manual step (login, 2FA, CAPTCHA, review) and wait until they click "Done, Continue AI" or "Cancel".',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Clear instruction shown to the user inside Chrome' },
        timeoutMs: { type: 'number', description: 'Max wait time in ms (default 300000 = 5 min)' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['message'],
    },
  },
  {
    name: 'browser_frames',
    description: 'List all frames and iframes (both same-origin and cross-origin OOPIF) in the active tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_check',
    description: 'Idempotently check or uncheck a checkbox, radio button, or ARIA switch (only clicks if state differs).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Ref, CSS, or rich/chained locator' },
        checked: { type: 'boolean', description: 'Desired checked state (default true)' },
        force: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_clipboard',
    description: 'Read from or write plain text / rich HTML to the browser clipboard (great for pasting formatted content into Notion/Feishu/Docs via Cmd+V).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'write'] },
        text: { type: 'string', description: 'Plain text to copy when action=write' },
        html: { type: 'string', description: 'Optional rich HTML alongside plain text when action=write' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_pdf',
    description: 'Export the current page to a PDF file via CDP Page.printToPDF.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .pdf file path' },
        landscape: { type: 'boolean' },
        printBackground: { type: 'boolean' },
        displayHeaderFooter: { type: 'boolean' },
        scale: { type: 'number' },
        paperWidth: { type: 'number' },
        paperHeight: { type: 'number' },
        pageRanges: { type: 'string', description: 'e.g. "1-3, 5"' },
        preferCSSPageSize: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_init_script',
    description: 'Add, remove, or list persistent initialization scripts that run before any page JavaScript on future navigations.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'remove', 'list'] },
        script: { type: 'string', description: 'JavaScript source to inject when action=add' },
        runNow: { type: 'boolean', description: 'Also execute immediately on the current page when action=add' },
        id: { type: 'string', description: 'Script identifier returned by add, required when action=remove' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_permissions',
    description: 'Grant or reset browser permissions (clipboard-read, clipboard-write, geolocation, notifications, camera, microphone) for the current or explicit origin.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['grant', 'reset'] },
        permissions: { type: 'array', items: { type: 'string' } },
        origin: { type: 'string' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
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
          frame: args.frame as string | undefined,
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
          grid: args.grid as boolean | undefined,
          gridStep: args.gridStep as number | undefined,
          clip: args.clip as { x: number; y: number; width: number; height: number } | undefined,
          zoom: args.zoom as { x: number; y: number; width: number; height: number; scale?: number } | undefined,
        })
        const regionNote = shot.region
          ? ` [region: x=${shot.region.x}, y=${shot.region.y}, ${shot.region.width}x${shot.region.height}, scale=${shot.region.scale}x]`
          : ''
        return {
          content: [
            {
              type: 'text',
              text: `${shot.path ? `Screenshot saved to ${shot.path}` : `Captured screenshot of tab [${tab.tabId}]`}${regionNote}`,
            },
            { type: 'image', data: shot.base64, mimeType: shot.mimeType },
          ],
          meta: { path: shot.path, tabId: tab.tabId, region: shot.region },
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
            force: Boolean(args.force),
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
        const action = (args.action as 'press' | 'down' | 'up' | undefined) ?? 'press'
        const repeat = typeof args.repeat === 'number' ? args.repeat : undefined
        const modifiers = args.modifiers as KeyModifier[] | undefined
        const { feedback } = await tab.runWithFeedback(() =>
          tab.page.pressKey(String(args.key), { action, repeat, modifiers }),
        )
        return textResult(
          `${action === 'down' ? 'Key down' : action === 'up' ? 'Key up' : 'Pressed'} ${args.key}${repeat && repeat > 1 ? ` x${repeat}` : ''}\n${formatFeedbackSuffix(feedback)}`,
        )
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
        const res = await tab.page.scroll({
          target: args.target as string | undefined,
          direction: args.direction as 'up' | 'down' | 'left' | 'right' | undefined,
          amount: args.amount as number | undefined,
          deltaX: args.deltaX as number | undefined,
          deltaY: args.deltaY as number | undefined,
        })
        return textResult(
          `Scrolled ${res.container} (moved=${res.scrolled}): scrollY=${res.scrollY}/${res.maxScrollY}px (${res.percentY}%)${res.atTop ? ' [at top]' : ''}${res.atBottom ? ' [at bottom]' : ''}`,
          { ...res },
        )
      }

      case 'browser_drag': {
        const tab = await resolveTab()
        const points = args.points as Array<{ x: number; y: number }> | undefined
        if (Array.isArray(points) && points.length >= 2) {
          await tab.page.mouseStroke(points, { stepsPerSegment: args.steps as number | undefined })
          return textResult(`Completed stroke across ${points.length} waypoints`)
        }
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
        const vals = Array.isArray(args.values)
          ? (args.values as unknown[]).map(String)
          : Array.isArray(args.value)
            ? (args.value as unknown[]).map(String)
            : String(args.value ?? '')
        const selected = await tab.page.selectOption(String(args.target), vals)
        return textResult(`Selected option(s) ${JSON.stringify(selected)} in ${args.target}`, { selected })
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
        const frame = args.frame as string | undefined
        if (typeof args.ms === 'number') {
          await new Promise((r) => setTimeout(r, args.ms as number))
          return textResult(`Waited ${args.ms}ms`)
        }
        if (args.popup === true) {
          const popupTab = await manager.waitForPopup({ timeoutMs, sessionId })
          const meta = await popupTab.page.getUrlAndTitle().catch(() => ({ url: '', title: '' }))
          return textResult(`Popup tab opened [${popupTab.tabId}]: ${meta.url}${meta.title ? ` ("${meta.title}")` : ''}`, {
            tabId: popupTab.tabId,
            ...meta,
          })
        }
        if (typeof args.url === 'string') {
          const matchedUrl = await waitForUrl(tab.session, args.url, { timeoutMs })
          return textResult(`URL matched: ${matchedUrl}`, { url: matchedUrl })
        }
        if (typeof args.responseUrl === 'string') {
          const res = await tab.network.waitForResponse({
            url: args.responseUrl,
            status: typeof args.responseStatus === 'number' ? args.responseStatus : undefined,
            method: typeof args.responseMethod === 'string' ? args.responseMethod : undefined,
            timeoutMs,
          })
          return textResult(
            JSON.stringify(
              {
                requestId: res.requestId,
                method: res.method,
                status: res.status,
                url: res.url,
                body: res.body?.slice(0, 8_000),
              },
              null,
              2,
            ),
            { response: res },
          )
        }
        if (typeof args.fn === 'string') {
          const val = await waitForFunction(tab.session, args.fn, { timeoutMs, frame })
          return textResult(`Condition truthy: ${typeof val === 'string' ? val : JSON.stringify(val)}`, { value: val })
        }
        if (typeof args.selector === 'string') {
          const state = (args.state as WaitSelectorState | undefined) ?? 'visible'
          await waitForSelector(tab.session, args.selector, { state, timeoutMs, frame })
          return textResult(`Selector ${state}: ${args.selector}`)
        }
        if (typeof args.text === 'string') {
          const gone = Boolean(args.gone)
          await waitForText(tab.session, args.text, { timeoutMs, frame, gone })
          return textResult(`Text ${gone ? 'disappeared' : 'appeared'}: ${args.text}`)
        }
        const res = await waitForPageLoad(tab.session, { timeoutMs })
        return textResult(JSON.stringify(res))
      }

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
              case 'check':
                await tab.page.check(String(s.target))
                completed.push(`${i + 1}. check(${s.target})`)
                break
              case 'uncheck':
                await tab.page.uncheck(String(s.target))
                completed.push(`${i + 1}. uncheck(${s.target})`)
                break
              case 'select_option':
                await tab.page.selectOption(
                  String(s.target),
                  Array.isArray(s.value) ? (s.value as unknown[]).map(String) : String(s.value),
                )
                completed.push(`${i + 1}. select_option(${s.target}, ${JSON.stringify(s.value)})`)
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
                else if (typeof s.url === 'string') await waitForUrl(tab.session, s.url)
                else if (typeof s.fn === 'string') await waitForFunction(tab.session, s.fn)
                else if (typeof s.selector === 'string')
                  await waitForSelector(tab.session, s.selector, { state: s.state as WaitSelectorState | undefined })
                else if (typeof s.text === 'string') await waitForText(tab.session, s.text, { gone: Boolean(s.gone) })
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

      case 'browser_fill_form': {
        const tab = await resolveTab()
        const fields = (args.fields as FormFieldInput[]) ?? []
        if (!fields.length) throw new Error('Provide non-empty fields array')
        const { result, feedback } = await tab.runWithFeedback(() => tab.page.fillForm(fields))
        const summary = result.filled.map((f, i) => `${i + 1}. [${f.type}] ${f.target} = ${JSON.stringify(f.value)}`).join('\n')
        return textResult(`Filled ${result.filled.length} form field(s):\n${summary}\n${formatFeedbackSuffix(feedback)}`, {
          filled: result.filled,
        })
      }

      case 'browser_handoff': {
        const tab = await resolveTab()
        const msg = String(args.message ?? 'Please complete the manual step in Chrome, then click "Done, Continue AI".')
        const res = await tab.page.requestHumanHandoff(msg, {
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        })
        const status = res.resumed ? 'Resumed by user' : res.cancelled ? 'Cancelled by user' : 'Timed out'
        return textResult(
          `${status} after ${Math.round(res.elapsedMs / 1000)}s — URL: ${res.url}${res.title ? ` ("${res.title}")` : ''}`,
          { ...res },
        )
      }

      case 'browser_frames': {
        const tab = await resolveTab()
        const frames = await tab.page.listFrames()
        const formatted = frames
          .map(
            (f, idx) =>
              `${idx + 1}. [${f.frameId}]${f.parentId ? ' (child)' : ' (main)'}${f.crossOrigin ? ' [OOPIF]' : ''}${f.name ? ` name="${f.name}"` : ''} — ${f.url}`,
          )
          .join('\n')
        return textResult(formatted || '(no frames)', { frames })
      }

      case 'browser_check': {
        const tab = await resolveTab()
        const desired = args.checked !== false
        const { result: changed, feedback } = await tab.runWithFeedback(() =>
          desired
            ? tab.page.check(String(args.target), { force: Boolean(args.force) })
            : tab.page.uncheck(String(args.target), { force: Boolean(args.force) }),
        )
        return textResult(
          `${desired ? 'Checked' : 'Unchecked'} ${args.target} (${changed ? 'toggled' : 'already in desired state'})\n${formatFeedbackSuffix(feedback)}`,
          { changed, checked: desired },
        )
      }

      case 'browser_clipboard': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'read') {
          const data = await tab.page.readClipboard()
          return textResult(data.html ? `Text:\n${data.text}\n\nHTML:\n${data.html}` : data.text, { ...data })
        }
        if (action === 'write') {
          await tab.page.writeClipboard(String(args.text ?? ''), args.html as string | undefined)
          return textResult(`Copied ${String(args.text ?? '').length} char(s)${args.html ? ' (+ HTML)' : ''} to clipboard`)
        }
        throw new Error(`Unsupported clipboard action: ${action}`)
      }

      case 'browser_pdf': {
        const tab = await resolveTab()
        const pdf = await tab.page.printToPDF({
          path: args.path as string | undefined,
          landscape: args.landscape as boolean | undefined,
          printBackground: args.printBackground as boolean | undefined,
          displayHeaderFooter: args.displayHeaderFooter as boolean | undefined,
          scale: args.scale as number | undefined,
          paperWidth: args.paperWidth as number | undefined,
          paperHeight: args.paperHeight as number | undefined,
          pageRanges: args.pageRanges as string | undefined,
          preferCSSPageSize: args.preferCSSPageSize as boolean | undefined,
        } as PdfOptions)
        return textResult(
          pdf.path
            ? `Saved PDF to ${pdf.path} (${(pdf.sizeBytes / 1024).toFixed(1)} KB)`
            : `Generated PDF (${(pdf.sizeBytes / 1024).toFixed(1)} KB, base64 length ${pdf.base64.length})`,
          { path: pdf.path, sizeBytes: pdf.sizeBytes },
        )
      }

      case 'browser_init_script': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'add') {
          const entry = await tab.page.addInitScript(String(args.script ?? ''), { runNow: Boolean(args.runNow) })
          return textResult(`Added init script [${entry.id}]: ${entry.preview}`, { entry })
        }
        if (action === 'remove') {
          const removed = await tab.page.removeInitScript(String(args.id ?? ''))
          return textResult(removed ? `Removed init script [${args.id}]` : `Init script [${args.id}] removed from CDP`)
        }
        if (action === 'list') {
          const list = tab.page.listInitScripts()
          return textResult(
            list.length ? list.map((s) => `[${s.id}] ${s.preview}`).join('\n') : '(no active init scripts)',
            { scripts: list },
          )
        }
        throw new Error(`Unsupported init_script action: ${action}`)
      }

      case 'browser_permissions': {
        const tab = await resolveTab()
        const action = String(args.action)
        if (action === 'grant') {
          const perms = (args.permissions as string[]) ?? []
          await tab.page.grantPermissions(perms, args.origin as string | undefined)
          return textResult(`Granted permissions: ${perms.join(', ')}`)
        }
        if (action === 'reset') {
          await tab.page.resetPermissions()
          return textResult('Reset browser permissions')
        }
        throw new Error(`Unsupported permissions action: ${action}`)
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
