import fs from 'node:fs/promises'
import path from 'node:path'
import type { DaemonClient } from '../client.js'
import { parseWorkflowPayload } from './replay.js'
import { parseRect, printToolOutput, type CliFlags } from './args.js'

export async function runDirectToolShortcutCommand(
  client: DaemonClient,
  cmd: string,
  positional: string[],
  flags: CliFlags,
  opts: { tabId?: number; sessionId?: string; clientId?: string },
): Promise<void> {
  const { tabId, sessionId, clientId } = opts

  switch (cmd) {
    case 'status':
      printToolOutput(await client.callTool('browser_status'))
      return
    case 'tabs': {
      const sub = (positional[1] || 'list').toLowerCase()
      if (sub === 'list') {
        printToolOutput(await client.callTool('browser_tabs', { clientId }))
        return
      }
      const parseIds = (raw: unknown): number[] | undefined =>
        typeof raw === 'string'
          ? raw
              .split(',')
              .map((s) => Number(s.trim()))
              .filter(Number.isFinite)
          : undefined
      if (sub === 'read-all' || sub === 'read_all' || sub === 'context') {
        printToolOutput(
          await client.callTool('browser_tabs_context', {
            action: 'read_all',
            tabIds: parseIds(flags.ids),
            tabGroup: typeof flags['tab-group'] === 'string' ? flags['tab-group'] : undefined,
            urlContains: typeof flags.filter === 'string' ? flags.filter : undefined,
            mode: typeof flags.mode === 'string' ? flags.mode : undefined,
            maxTabs: typeof flags['max-tabs'] === 'string' ? Number(flags['max-tabs']) : undefined,
            maxCharsPerTab: typeof flags['max-chars'] === 'string' ? Number(flags['max-chars']) : undefined,
            clientId,
          }),
        )
        return
      }
      if (sub === 'group' || sub === 'ungroup' || sub === 'organize') {
        printToolOutput(
          await client.callTool('browser_tabs_context', {
            action: sub,
            tabIds: parseIds(flags.ids ?? positional[2]),
            title: typeof flags.title === 'string' ? flags.title : undefined,
            color: typeof flags.color === 'string' ? flags.color : undefined,
            collapsed: Boolean(flags.collapsed),
            strategy: typeof flags.strategy === 'string' ? flags.strategy : undefined,
            minGroupSize: typeof flags['min-size'] === 'string' ? Number(flags['min-size']) : undefined,
            collapseOthers: Boolean(flags['collapse-others']),
            clientId,
          }),
        )
        return
      }
      throw new Error(`Unknown tabs subcommand "${sub}". Use: list, read-all, group, ungroup, organize.`)
    }
    case 'find': {
      const query = positional.slice(1).join(' ').trim()
      if (!query) throw new Error('Usage: browserpilot find "<query>" [--limit N] [--viewport]')
      printToolOutput(
        await client.callTool('browser_find', {
          query,
          limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
          viewportOnly: Boolean(flags.viewport || flags['viewport-only']),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'gif': {
      const action = (positional[1] || 'status').toLowerCase()
      printToolOutput(
        await client.callTool('browser_gif', {
          action,
          label: typeof flags.label === 'string' ? flags.label : action === 'frame' ? positional[2] : undefined,
          outputPath: action === 'export' ? positional[2] : undefined,
          width: typeof flags.width === 'string' ? Number(flags.width) : undefined,
          delayMs: typeof flags.delay === 'string' ? Number(flags.delay) : undefined,
          showClickIndicators: flags['no-click-indicators'] ? false : undefined,
          showActionLabels: flags['no-labels'] ? false : undefined,
          showProgressBar: flags['no-progress'] ? false : undefined,
          loop: typeof flags.loop === 'string' ? Number(flags.loop) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'shortcut':
    case 'shortcuts': {
      const action = (positional[1] || 'list').toLowerCase()
      if (action === 'save') {
        const name = positional[2]
        const flowFile = positional[3]
        if (!name) throw new Error('Usage: browserpilot shortcut save <name> <flow.json> | --code "<js>" [--desc "..."]')
        let steps: unknown[] | undefined
        if (flowFile) {
          const raw = await fs.readFile(path.resolve(flowFile), 'utf8')
          steps = parseWorkflowPayload(raw).steps
        }
        printToolOutput(
          await client.callTool('browser_shortcuts', {
            action: 'save',
            name,
            description: typeof flags.desc === 'string' ? flags.desc : undefined,
            steps,
            code: typeof flags.code === 'string' ? flags.code : undefined,
          }),
        )
        return
      }
      printToolOutput(
        await client.callTool('browser_shortcuts', {
          action,
          name: positional[2],
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'schedule':
    case 'schedules': {
      const rawAct = (positional[1] || 'list').toLowerCase()
      const action = rawAct === 'run-now' ? 'run_now' : rawAct
      printToolOutput(
        await client.callTool('browser_schedule', {
          action,
          name: positional[2],
          every: typeof flags.every === 'string' ? flags.every : undefined,
          flowPath: typeof flags.flow === 'string' ? path.resolve(flags.flow) : undefined,
          shortcut: typeof flags.shortcut === 'string' ? flags.shortcut : undefined,
          code: typeof flags.code === 'string' ? flags.code : undefined,
          headless: flags.headed ? false : true,
        }),
      )
      return
    }
    case 'memory': {
      const action = (positional[1] || 'list').toLowerCase()
      printToolOutput(
        await client.callTool('browser_memory', {
          action,
          domain: positional[2],
          key: positional[3],
          value: positional.slice(4).join(' ') || undefined,
          note: typeof flags.note === 'string' ? flags.note : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'frames':
      printToolOutput(await client.callTool('browser_frames', { tabId, sessionId, clientId }))
      return
    case 'open':
      printToolOutput(
        await client.callTool('browser_open_tab', {
          url: positional[1] || 'about:blank',
          tabGroup: typeof flags['tab-group'] === 'string' ? flags['tab-group'] : undefined,
          sessionId,
          clientId,
        }),
      )
      return
    case 'close':
      printToolOutput(await client.callTool('browser_close_tab', { tabId: Number(positional[1]) }))
      return
    case 'navigate':
    case 'goto':
      printToolOutput(await client.callTool('browser_navigate', { url: positional[1], tabId, sessionId }))
      return
    case 'back':
      printToolOutput(await client.callTool('browser_history', { action: 'back', tabId, sessionId }))
      return
    case 'forward':
      printToolOutput(await client.callTool('browser_history', { action: 'forward', tabId, sessionId }))
      return
    case 'reload':
      printToolOutput(
        await client.callTool('browser_history', {
          action: 'reload',
          ignoreCache: Boolean(flags['ignore-cache']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'snapshot':
      printToolOutput(
        await client.callTool('browser_snapshot', {
          tabId,
          sessionId,
          clientId,
          interactiveOnly: Boolean(flags.i || flags.interactive),
          viewportOnly: Boolean(flags.viewport || flags['viewport-only']),
          maxChars: typeof flags['max-chars'] === 'string' ? Number(flags['max-chars']) : undefined,
          wrapUntrusted: Boolean(flags['wrap-untrusted']),
          search: typeof flags.search === 'string' ? flags.search : undefined,
          scope: typeof flags.scope === 'string' ? flags.scope : undefined,
          frame: typeof flags.frame === 'string' ? flags.frame : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
        }),
      )
      return
    case 'markdown':
      printToolOutput(
        await client.callTool('browser_markdown', {
          tabId,
          sessionId,
          clientId,
          wrapUntrusted: Boolean(flags['wrap-untrusted']),
          search: typeof flags.search === 'string' ? flags.search : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
        }),
      )
      return
    case 'html':
      printToolOutput(
        await client.callTool('browser_clean_html', {
          tabId,
          sessionId,
          clientId,
          wrapUntrusted: Boolean(flags['wrap-untrusted']),
          selector: typeof flags.selector === 'string' ? flags.selector : undefined,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          showDiffSinceLastCall: flags.full ? false : undefined,
          includeStyles: Boolean(flags['include-styles']),
        }),
      )
      return
    case 'click': {
      const rawMods =
        typeof flags.modifiers === 'string'
          ? flags.modifiers.split(',').map((s) => {
              const l = s.trim().toLowerCase()
              if (l === 'cmd' || l === 'meta' || l === 'command') return 'Meta'
              if (l === 'ctrl' || l === 'control') return 'Control'
              if (l === 'alt' || l === 'option') return 'Alt'
              if (l === 'shift') return 'Shift'
              return s.trim()
            })
          : undefined
      printToolOutput(
        await client.callTool('browser_click', {
          target: positional[1],
          button: typeof flags.button === 'string' ? flags.button : undefined,
          clickCount: flags.double
            ? 2
            : typeof flags['click-count'] === 'string'
              ? Number(flags['click-count'])
              : undefined,
          modifiers: rawMods,
          force: Boolean(flags.force),
          strict: Boolean(flags.strict),
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'check':
    case 'uncheck':
      printToolOutput(
        await client.callTool('browser_check', {
          target: positional[1],
          checked: cmd === 'check',
          force: Boolean(flags.force),
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'select': {
      const values = positional.slice(2)
      if (!positional[1] || !values.length) throw new Error('Usage: browserpilot select <target> <value> [value2...]')
      printToolOutput(
        await client.callTool('browser_select_option', {
          target: positional[1],
          value: values.length === 1 ? values[0] : undefined,
          values: values.length > 1 ? values : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'upload': {
      const files = positional.slice(2)
      if (!positional[1] || !files.length) throw new Error('Usage: browserpilot upload <target> <file1> [file2...]')
      printToolOutput(
        await client.callTool('browser_upload_file', {
          target: positional[1],
          files,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'drag': {
      if (typeof flags.points === 'string') {
        const points = flags.points.split(';').map((pair) => {
          const [x, y] = pair.split(',').map((n) => Number(n.trim()))
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid point "${pair}" in --points`)
          return { x, y }
        })
        printToolOutput(
          await client.callTool('browser_drag', {
            points,
            steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
            tabId,
            sessionId,
            clientId,
          }),
        )
        return
      }
      printToolOutput(
        await client.callTool('browser_drag', {
          fromTarget: positional[1],
          toTarget: positional[2],
          mode: typeof flags.mode === 'string' ? flags.mode : undefined,
          steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'tap': {
      printToolOutput(
        await client.callTool('browser_touch', {
          action: 'tap',
          target: positional[1],
          x: typeof flags.x === 'string' ? Number(flags.x) : undefined,
          y: typeof flags.y === 'string' ? Number(flags.y) : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'swipe': {
      printToolOutput(
        await client.callTool('browser_touch', {
          action: 'swipe',
          fromTarget: positional[1],
          toTarget: positional[2],
          fromX: typeof flags['from-x'] === 'string' ? Number(flags['from-x']) : undefined,
          fromY: typeof flags['from-y'] === 'string' ? Number(flags['from-y']) : undefined,
          toX: typeof flags['to-x'] === 'string' ? Number(flags['to-x']) : undefined,
          toY: typeof flags['to-y'] === 'string' ? Number(flags['to-y']) : undefined,
          steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
          durationMs: typeof flags.duration === 'string' ? Number(flags.duration) : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'dialog': {
      const action = (positional[1] || 'accept').toLowerCase()
      printToolOutput(
        await client.callTool('browser_handle_dialog', {
          accept: action !== 'dismiss' && action !== 'cancel',
          promptText: typeof flags.prompt === 'string' ? flags.prompt : undefined,
          auto: Boolean(flags.auto),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'clipboard': {
      const action = (positional[1] || 'read').toLowerCase()
      printToolOutput(
        await client.callTool('browser_clipboard', {
          action,
          text: positional.slice(2).join(' ') || undefined,
          html: typeof flags.html === 'string' ? flags.html : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'pdf':
      printToolOutput(
        await client.callTool('browser_pdf', {
          path: positional[1] || `browserpilot-page-${Date.now()}.pdf`,
          landscape: Boolean(flags.landscape),
          printBackground: flags['no-background'] ? false : true,
          scale: typeof flags.scale === 'string' ? Number(flags.scale) : undefined,
          pageRanges: typeof flags.pages === 'string' ? flags.pages : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'init-script': {
      const action = (positional[1] || 'list').toLowerCase()
      printToolOutput(
        await client.callTool('browser_init_script', {
          action,
          script: action === 'add' ? positional[2] : undefined,
          id: action === 'remove' ? positional[2] : undefined,
          runNow: Boolean(flags['run-now']),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'permissions': {
      const action = (positional[1] || 'grant').toLowerCase()
      const perms = positional[2] ? positional[2].split(',').map((s) => s.trim()).filter(Boolean) : []
      printToolOutput(
        await client.callTool('browser_permissions', {
          action,
          permissions: perms,
          origin: typeof flags.origin === 'string' ? flags.origin : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'locator': {
      const res = await client.callTool('browser_inspect_element', {
        target: positional[1],
        tabId,
        sessionId,
        clientId,
      })
      const rec = (res.meta?.info as { recommendedLocator?: string } | undefined)?.recommendedLocator
      if (rec) console.log(rec)
      else printToolOutput(res)
      return
    }
    case 'fill-form': {
      const rawFields = positional[1]
      if (!rawFields) {
        throw new Error('Provide JSON array of fields: browserpilot fill-form \'[{"target":"#name","value":"Alice"}]\'')
      }
      const fields = JSON.parse(rawFields) as unknown[]
      printToolOutput(await client.callTool('browser_fill_form', { fields, tabId, sessionId, clientId }))
      return
    }
    case 'handoff':
      printToolOutput(
        await client.callTool('browser_handoff', {
          message: positional[1] || 'Please complete this step in Chrome, then click "Done, Continue AI".',
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'hover':
      printToolOutput(await client.callTool('browser_hover', { target: positional[1], tabId, sessionId }))
      return
    case 'scroll': {
      const dir = positional[1]
      const direction = dir === 'up' || dir === 'down' || dir === 'left' || dir === 'right' ? dir : 'down'
      printToolOutput(
        await client.callTool('browser_scroll', {
          direction,
          amount: typeof flags.amount === 'string' ? Number(flags.amount) : undefined,
          target: typeof flags.target === 'string' ? flags.target : undefined,
          untilTarget: typeof flags.until === 'string' ? flags.until : undefined,
          maxScrolls: typeof flags['max-scrolls'] === 'string' ? Number(flags['max-scrolls']) : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'wait':
      printToolOutput(
        await client.callTool('browser_wait', {
          selector: typeof flags.selector === 'string' ? flags.selector : undefined,
          state: typeof flags.state === 'string' ? flags.state : undefined,
          text: typeof flags.text === 'string' ? flags.text : undefined,
          gone: Boolean(flags.gone),
          url: typeof flags.url === 'string' ? flags.url : undefined,
          responseUrl: typeof flags.response === 'string' ? flags.response : undefined,
          responseStatus: typeof flags.status === 'string' ? Number(flags.status) : undefined,
          responseMethod: typeof flags.method === 'string' ? flags.method : undefined,
          fn: typeof flags.fn === 'string' ? flags.fn : undefined,
          popup: Boolean(flags.popup),
          frame: typeof flags.frame === 'string' ? flags.frame : undefined,
          ms: typeof flags.ms === 'string' ? Number(flags.ms) : undefined,
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'fill':
      printToolOutput(
        await client.callTool('browser_fill', {
          target: positional[1],
          value: positional[2] ?? '',
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'type':
      printToolOutput(
        await client.callTool('browser_type', {
          target: positional[2] ? positional[1] : undefined,
          text: positional[2] ?? positional[1],
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'key':
      printToolOutput(
        await client.callTool('browser_press_key', {
          key: positional[1],
          action: flags.down ? 'down' : flags.up ? 'up' : 'press',
          repeat: typeof flags.repeat === 'string' ? Number(flags.repeat) : undefined,
          returnDiff: Boolean(flags.diff),
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'screenshot': {
      const zoomRect = parseRect(flags.zoom)
      const clipRect = parseRect(flags.clip)
      printToolOutput(
        await client.callTool('browser_screenshot', {
          path: positional[1] || `browserpilot-shot-${Date.now()}.png`,
          fullPage: Boolean(flags['full-page']),
          grid: Boolean(flags.grid),
          gridStep: typeof flags['grid-step'] === 'string' ? Number(flags['grid-step']) : undefined,
          clip: clipRect,
          zoom: zoomRect
            ? { ...zoomRect, scale: typeof flags.scale === 'string' ? Number(flags.scale) : 2 }
            : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    }
    case 'labeled-screenshot':
      printToolOutput(
        await client.callTool('browser_labeled_screenshot', {
          path: positional[1] || `browserpilot-som-${Date.now()}.png`,
          tabId,
          sessionId,
        }),
      )
      return
    case 'console':
      printToolOutput(
        await client.callTool('browser_console', {
          level: typeof flags.level === 'string' ? flags.level : undefined,
          search: typeof flags.search === 'string' ? flags.search : undefined,
          sinceLastCall: Boolean(flags['since-last']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'network':
      printToolOutput(
        await client.callTool('browser_network', {
          failedOnly: Boolean(flags.failed),
          search: typeof flags.search === 'string' ? flags.search : undefined,
          requestId: typeof flags['request-id'] === 'string' ? flags['request-id'] : undefined,
          sinceLastCall: Boolean(flags['since-last']),
          tabId,
          sessionId,
        }),
      )
      return
    case 'styles':
      printToolOutput(await client.callTool('browser_styles', { target: positional[1], tabId, sessionId }))
      return
    case 'react':
      printToolOutput(await client.callTool('browser_react_info', { target: positional[1], tabId, sessionId }))
      return
    case 'eval':
      printToolOutput(
        await client.callTool('browser_evaluate', {
          expression: positional[1],
          frame: typeof flags.frame === 'string' ? flags.frame : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    case 'perf':
      printToolOutput(
        await client.callTool('browser_performance', { action: positional[1] || 'metrics', tabId, sessionId }),
      )
      return
    case 'downloads':
      printToolOutput(
        await client.callTool('browser_downloads', {
          action: positional[1] || 'list',
          downloadDir: typeof flags.dir === 'string' ? flags.dir : undefined,
          filenamePattern: typeof flags.pattern === 'string' ? flags.pattern : undefined,
          timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) : undefined,
          tabId,
          sessionId,
        }),
      )
      return
    case 'record-actions':
      printToolOutput(
        await client.callTool('browser_action_recorder', {
          action: positional[1] || 'status',
          format: typeof flags.format === 'string' ? flags.format : undefined,
          outputPath: typeof flags.o === 'string' ? flags.o : typeof flags.output === 'string' ? flags.output : undefined,
          tabId,
          sessionId,
          clientId,
        }),
      )
      return
    default:
      throw new Error(`Unknown command "${cmd}". Run "browserpilot --help" for usage.`)
  }
}
