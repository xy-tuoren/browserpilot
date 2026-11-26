import {
  waitForFunction,
  waitForPageLoad,
  waitForSelector,
  waitForText,
  waitForUrl,
  type DragOptions,
  type FormFieldInput,
  type KeyModifier,
  type MouseButton,
  type WaitSelectorState,
} from '@browserpilot/core'
import { appendPostActionDiff, enforceActionApproval } from './guardrails.js'
import {
  formatFeedbackSuffix,
  textResult,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolExecutionResult,
} from './types.js'

export const INTERACTION_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser_click',
    description:
      'Perform a browser-trusted CDP mouse click on a snapshot ref, CSS selector, rich locator, or (x,y) coordinates. Auto-waits and retries across transient DOM re-renders, animations, overlays, and disabled states unless force=true.',
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
        strict: { type: 'boolean', description: 'Fail with strict-mode error if locator matches multiple visible elements' },
        timeoutMs: { type: 'number', description: 'Actionability wait/retry timeout in ms' },
        returnDiff: { type: 'boolean', description: 'Append compact interactive AXTree diff immediately after the action' },
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
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_fill',
    description:
      'Focus an input/textarea/contenteditable, clear it safely, and insert text via trusted CDP input with auto-waiting retry for dynamic SPAs.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        value: { type: 'string' },
        clear: { type: 'boolean' },
        force: { type: 'boolean' },
        strict: { type: 'boolean' },
        timeoutMs: { type: 'number' },
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target', 'value'],
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
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['fields'],
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
        returnDiff: { type: 'boolean' },
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
    description:
      'Scroll a container or dispatch mouse wheel scrolling; set untilTarget to incrementally scroll virtualized feeds/tables until a locator appears.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        untilTarget: { type: 'string', description: 'Scroll step-by-step until this locator/text appears in the DOM' },
        maxScrolls: { type: 'number', description: 'Max scroll attempts when untilTarget is set (default 20)' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number' },
        deltaX: { type: 'number' },
        deltaY: { type: 'number' },
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_drag',
    description:
      'Perform a smooth pointer or HTML5 DataTransfer drag-and-drop between two targets/coordinates, or a multi-point freehand canvas stroke via points[].',
    inputSchema: {
      type: 'object',
      properties: {
        fromTarget: { type: 'string' },
        toTarget: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        mode: {
          type: 'string',
          enum: ['auto', 'pointer', 'html5'],
          description: 'Drag mode (default auto: detects draggable="true" for HTML5 DragEvents)',
        },
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
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_touch',
    description: 'Dispatch mobile Touch Events (tap or swipe) via CDP Input.dispatchTouchEvent for touch-only H5 pages and carousels.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['tap', 'swipe'] },
        target: { type: 'string', description: 'Element target for tap' },
        x: { type: 'number' },
        y: { type: 'number' },
        fromTarget: { type: 'string' },
        toTarget: { type: 'string' },
        fromX: { type: 'number' },
        fromY: { type: 'number' },
        toX: { type: 'number' },
        toY: { type: 'number' },
        steps: { type: 'number' },
        durationMs: { type: 'number' },
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
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
        returnDiff: { type: 'boolean' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['target'],
    },
  },
  {
    name: 'browser_upload_file',
    description:
      'Attach one or more local files to either an <input type="file"> (including hidden inputs) OR any custom Upload button/dropzone that dynamically opens a file chooser on click.',
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
]

export async function executeInteractionTool(
  ctx: ToolDispatchContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const { manager, sessionId, resolveTab } = ctx

  switch (name) {
    case 'browser_click': {
      const tab = await resolveTab()
      const target =
        typeof args.target === 'string'
          ? args.target
          : typeof args.x === 'number' && typeof args.y === 'number'
            ? { x: args.x, y: args.y }
            : null
      if (!target) throw new Error('Provide either target or (x, y) coordinates')
      await enforceActionApproval(tab, {
        action: 'click',
        target: typeof target === 'string' ? target : `(${target.x}, ${target.y})`,
      })
      const { feedback } = await tab.runWithFeedback(() =>
        tab.page.click(target, {
          button: args.button as MouseButton | undefined,
          clickCount: args.clickCount as number | undefined,
          modifiers: args.modifiers as KeyModifier[] | undefined,
          force: Boolean(args.force),
          strict: Boolean(args.strict),
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        }),
      )
      const msg = await appendPostActionDiff(
        tab,
        `Clicked ${typeof target === 'string' ? target : `(${target.x}, ${target.y})`}\n${formatFeedbackSuffix(feedback)}`,
        args.returnDiff,
      )
      return textResult(msg)
    }

    case 'browser_check': {
      const tab = await resolveTab()
      const desired = args.checked !== false
      const { result: changed, feedback } = await tab.runWithFeedback(() =>
        desired
          ? tab.page.check(String(args.target), { force: Boolean(args.force) })
          : tab.page.uncheck(String(args.target), { force: Boolean(args.force) }),
      )
      const msg = await appendPostActionDiff(
        tab,
        `${desired ? 'Checked' : 'Unchecked'} ${args.target} (${changed ? 'toggled' : 'already in desired state'})\n${formatFeedbackSuffix(feedback)}`,
        args.returnDiff,
      )
      return textResult(msg, { changed, checked: desired })
    }

    case 'browser_fill': {
      const tab = await resolveTab()
      await enforceActionApproval(tab, { action: 'fill', target: String(args.target) })
      const { feedback } = await tab.runWithFeedback(() =>
        tab.page.fill(String(args.target), String(args.value), {
          clear: args.clear as boolean | undefined,
          force: Boolean(args.force),
          strict: Boolean(args.strict),
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        }),
      )
      const msg = await appendPostActionDiff(
        tab,
        `Filled ${args.target}\n${formatFeedbackSuffix(feedback)}`,
        args.returnDiff,
      )
      return textResult(msg)
    }

    case 'browser_fill_form': {
      const tab = await resolveTab()
      const fields = (args.fields as FormFieldInput[]) ?? []
      if (!fields.length) throw new Error('Provide non-empty fields array')
      await enforceActionApproval(tab, {
        action: 'fill',
        target: fields.map((f) => f.target).join(', '),
      })
      const { result, feedback } = await tab.runWithFeedback(() => tab.page.fillForm(fields))
      const summary = result.filled.map((f, i) => `${i + 1}. [${f.type}] ${f.target} = ${JSON.stringify(f.value)}`).join('\n')
      const msg = await appendPostActionDiff(
        tab,
        `Filled ${result.filled.length} form field(s):\n${summary}\n${formatFeedbackSuffix(feedback)}`,
        args.returnDiff,
      )
      return textResult(msg, { filled: result.filled })
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
      const msg = await appendPostActionDiff(
        tab,
        `${action === 'down' ? 'Key down' : action === 'up' ? 'Key up' : 'Pressed'} ${args.key}${repeat && repeat > 1 ? ` x${repeat}` : ''}\n${formatFeedbackSuffix(feedback)}`,
        args.returnDiff,
      )
      return textResult(msg)
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
      if (typeof args.untilTarget === 'string' && args.untilTarget.trim()) {
        const untilRes = await tab.page.scrollUntil(args.untilTarget, {
          container: args.target as string | undefined,
          direction: args.direction as 'up' | 'down' | 'left' | 'right' | undefined,
          amount: args.amount as number | undefined,
          maxScrolls: typeof args.maxScrolls === 'number' ? args.maxScrolls : undefined,
        })
        const base = untilRes.found
          ? `Found "${args.untilTarget}" after ${untilRes.attempts} scroll step(s)`
          : `Target "${args.untilTarget}" not found after ${untilRes.attempts} scroll step(s)`
        const msg = await appendPostActionDiff(tab, base, args.returnDiff)
        return textResult(msg, { ...untilRes })
      }
      const res = await tab.page.scroll({
        target: args.target as string | undefined,
        direction: args.direction as 'up' | 'down' | 'left' | 'right' | undefined,
        amount: args.amount as number | undefined,
        deltaX: args.deltaX as number | undefined,
        deltaY: args.deltaY as number | undefined,
      })
      const base = `Scrolled ${res.container} (moved=${res.scrolled}): scrollY=${res.scrollY}/${res.maxScrollY}px (${res.percentY}%)${res.atTop ? ' [at top]' : ''}${res.atBottom ? ' [at bottom]' : ''}`
      const msg = await appendPostActionDiff(tab, base, args.returnDiff)
      return textResult(msg, { ...res })
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
      await tab.page.drag(from, to, {
        steps: args.steps as number | undefined,
        mode: args.mode as DragOptions['mode'],
      })
      const msg = await appendPostActionDiff(tab, 'Drag completed', args.returnDiff)
      return textResult(msg)
    }

    case 'browser_touch': {
      const tab = await resolveTab()
      const action = String(args.action)
      if (action === 'tap') {
        const target =
          typeof args.target === 'string'
            ? args.target
            : typeof args.x === 'number' && typeof args.y === 'number'
              ? { x: args.x, y: args.y }
              : null
        if (!target) throw new Error('Provide either target or (x, y) for touch tap')
        const { feedback } = await tab.runWithFeedback(() => tab.page.tap(target))
        const msg = await appendPostActionDiff(
          tab,
          `Tapped ${typeof target === 'string' ? target : `(${target.x}, ${target.y})`}\n${formatFeedbackSuffix(feedback)}`,
          args.returnDiff,
        )
        return textResult(msg)
      }
      if (action === 'swipe') {
        const from =
          typeof args.fromTarget === 'string'
            ? args.fromTarget
            : { x: Number(args.fromX ?? 0), y: Number(args.fromY ?? 0) }
        const to =
          typeof args.toTarget === 'string'
            ? args.toTarget
            : { x: Number(args.toX ?? 0), y: Number(args.toY ?? 0) }
        await tab.page.swipe(from, to, {
          steps: typeof args.steps === 'number' ? args.steps : undefined,
          durationMs: typeof args.durationMs === 'number' ? args.durationMs : undefined,
        })
        const msg = await appendPostActionDiff(tab, 'Touch swipe completed', args.returnDiff)
        return textResult(msg)
      }
      throw new Error(`Unsupported touch action: ${action}`)
    }

    case 'browser_select_option': {
      const tab = await resolveTab()
      const vals = Array.isArray(args.values)
        ? (args.values as unknown[]).map(String)
        : Array.isArray(args.value)
          ? (args.value as unknown[]).map(String)
          : String(args.value ?? '')
      const selected = await tab.page.selectOption(String(args.target), vals)
      const msg = await appendPostActionDiff(
        tab,
        `Selected option(s) ${JSON.stringify(selected)} in ${args.target}`,
        args.returnDiff,
      )
      return textResult(msg, { selected })
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

    default:
      return null
  }
}
