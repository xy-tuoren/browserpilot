import type { DaemonClient } from '../client.js'
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
    case 'tabs':
      printToolOutput(await client.callTool('browser_tabs', { clientId }))
      return
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
          steps: typeof flags.steps === 'string' ? Number(flags.steps) : undefined,
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
          tabId,
          sessionId,
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
        await client.callTool('browser_fill', { target: positional[1], value: positional[2] ?? '', tabId, sessionId, clientId }),
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
