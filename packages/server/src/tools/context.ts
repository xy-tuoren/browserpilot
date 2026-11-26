import fs from 'node:fs/promises'
import path from 'node:path'
import { createDemoVideo, renderTraceViewerHtml, type ExecSandboxMode, type PdfOptions } from '@browserpilot/core'
import type { TraceData } from '@browserpilot/protocol'
import { enforceActionApproval } from './guardrails.js'
import { textResult, type ToolDefinition, type ToolDispatchContext, type ToolExecutionResult } from './types.js'

export const CONTEXT_TOOL_DEFINITIONS: ToolDefinition[] = [
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
      'Record live user interactions (clicks, dblclicks, checks, fills, selects, keys, scrolls, navigations, and Alt+Shift+Click assertions) across Shadow DOM & iframes, and generate Playwright TS, BrowserPilot JS, browser_batch JSON, or Agent Skill Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'clear', 'assert_next'] },
        maskPasswords: { type: 'boolean', description: 'Mask password inputs as <REDACTED_PASSWORD> (default true)' },
        format: {
          type: 'string',
          enum: ['all', 'playwright', 'browserpilot', 'script', 'batch', 'skill'],
          description: 'Output format on stop (default "all")',
        },
        outputPath: { type: 'string', description: 'Optional file path to save generated code on stop' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_trace',
    description:
      'Start, stop, check status of, or open an interactive Playwright-style HTML Trace Viewer capturing Before/After screenshots, click reticle & bounding boxes, DOM snapshots, Console logs, and Network requests (+ API response previews) for every browser action.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'status', 'open'] },
        title: { type: 'string', description: 'Optional trace report title when action=start' },
        path: { type: 'string', description: 'Output .html / .json file path on stop, or input file path on open' },
        format: { type: 'string', enum: ['html', 'json'] },
        screenshots: { type: 'boolean', description: 'Capture Before/After screenshots per step (default true)' },
        snapshots: { type: 'boolean', description: 'Capture compact AX/DOM summary per step (default true)' },
        networkBodies: { type: 'boolean', description: 'Capture XHR/Fetch response body previews (default true)' },
        openViewer: { type: 'boolean', description: 'Automatically open the interactive Trace Viewer in Chrome on stop' },
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_exec',
    description:
      'Execute a multi-step async JavaScript snippet inside an isolated stateful session sandbox with helpers (state, tabs, locator, route, waitForFileChooser, trace, actionRecorder, snapshot, screenshot, cleanHTML, markdown, inspect, getLatestLogs, getNetwork, getStyles, getReactInfo, cdp).',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        sessionId: { type: 'string', description: 'Session ID (default "default")' },
        tabId: { type: 'number' },
        timeoutMs: { type: 'number' },
        tracePath: {
          type: 'string',
          description: 'Optional .html or .json file path to automatically record a visual Trace Viewer report for this execution (saved even on error)',
        },
        sandboxMode: {
          type: 'string',
          enum: ['standard', 'restricted'],
          description: 'Optional sandbox policy ("restricted" blocks fs/child_process/net require() calls)',
        },
      },
      required: ['code'],
    },
  },
]

export async function executeContextTool(
  ctx: ToolDispatchContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const { manager, sessionId, explicitTabId, resolveTab } = ctx

  switch (name) {
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
      await enforceActionApproval(tab, { action: 'cookies', detail: `cookies.${action}(${String(args.name ?? args.url ?? 'page')})` })
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
      await enforceActionApproval(tab, { action: 'storage', detail: `${kind}Storage.${action}(${String(args.key ?? '')})` })
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
        return textResult(`Action recording started on ${res.url || `tab [${tab.tabId}]`}`, res)
      }
      if (action === 'clear') {
        tab.actionRecorder.clearSteps()
        return textResult('Cleared recorded steps')
      }
      if (action === 'assert_next') {
        await tab.actionRecorder.setAssertMode(true)
        return textResult('Assertion mode armed: click any element in Chrome (or Alt+Shift+Click) to record an assertion')
      }
      if (action === 'status') {
        const steps = tab.actionRecorder.getSteps()
        return textResult(
          JSON.stringify(
            {
              recording: tab.actionRecorder.isRecording(),
              recordedSteps: steps.length,
              steps,
            },
            null,
            2,
          ),
          { recording: tab.actionRecorder.isRecording(), steps },
        )
      }
      if (action === 'stop') {
        const res = await tab.actionRecorder.stop()
        const fmt = String(args.format ?? 'all')
        const rendered =
          fmt === 'playwright'
            ? res.playwrightScript
            : fmt === 'skill'
              ? res.skillMarkdown
              : fmt === 'script' || fmt === 'browserpilot'
                ? res.execScript
                : fmt === 'batch'
                  ? JSON.stringify(res.batchSteps, null, 2)
                  : JSON.stringify(res, null, 2)

        if (typeof args.outputPath === 'string' && args.outputPath.trim()) {
          const outPath = path.resolve(args.outputPath)
          await fs.mkdir(path.dirname(outPath), { recursive: true })
          await fs.writeFile(outPath, rendered, 'utf8')
          return textResult(`${rendered}\n\n// Saved to ${outPath}`, { outputPath: outPath, stepCount: res.steps.length })
        }
        return textResult(rendered, { stepCount: res.steps.length })
      }
      throw new Error(`Unknown action_recorder action: ${action}`)
    }

    case 'browser_trace': {
      const action = String(args.action)
      if (action === 'open') {
        const rawPath = String(args.path ?? '').trim()
        if (!rawPath) throw new Error('Provide path to a .html or .json trace file')
        const resolved = path.resolve(rawPath)
        const rawContent = await fs.readFile(resolved, 'utf8')
        const html = resolved.endsWith('.json')
          ? renderTraceViewerHtml(JSON.parse(rawContent) as TraceData)
          : rawContent
        const viewerUrl = ctx.registerTraceHtml?.(html)
        if (viewerUrl) {
          await manager.openTab({ url: viewerUrl, tabGroup: 'trace', tabGroupColor: 'cyan' })
          return textResult(`Opened Trace Viewer in Chrome -> ${viewerUrl}`, { viewerUrl, path: resolved })
        }
        return textResult(`Loaded trace report (${resolved}, ${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KB)`, {
          path: resolved,
        })
      }

      const tab = await resolveTab()
      if (action === 'start') {
        const started = await tab.trace.start({
          title: args.title as string | undefined,
          screenshots: args.screenshots as boolean | undefined,
          snapshots: args.snapshots as boolean | undefined,
          networkBodies: args.networkBodies as boolean | undefined,
        })
        return textResult(`Trace recording started on ${started.url || `tab [${tab.tabId}]`} ("${started.title}")`, started)
      }
      if (action === 'status') {
        const st = tab.trace.getStatus()
        return textResult(JSON.stringify(st, null, 2), st)
      }
      if (action === 'stop') {
        const fmt = args.format === 'json' ? 'json' : 'html'
        const outPath =
          typeof args.path === 'string' && args.path.trim()
            ? args.path
            : `./browserpilot-trace-${Date.now()}.${fmt}`
        const stopped = await tab.trace.stop({ path: outPath, format: fmt })
        const viewerUrl = ctx.registerTraceHtml?.(stopped.html)
        if (viewerUrl) {
          stopped.summary.viewerUrl = viewerUrl
          if (args.openViewer) {
            await manager.openTab({ url: viewerUrl, tabGroup: 'trace', tabGroupColor: 'cyan' }).catch(() => {})
          }
        }
        const lines = [
          `Saved Trace report -> ${stopped.summary.path} (${(stopped.summary.sizeBytes / 1024).toFixed(1)} KB)`,
          `Steps: ${stopped.summary.stepCount} | Network: ${stopped.summary.networkCount} | Errors: ${stopped.summary.errorCount} | Duration: ${(stopped.summary.durationMs / 1000).toFixed(2)}s`,
        ]
        if (viewerUrl) {
          lines.push(`Viewer URL: ${viewerUrl}${args.openViewer ? ' (opened in Chrome)' : ''}`)
        }
        return textResult(lines.join('\n'), { ...stopped.summary })
      }
      throw new Error(`Unknown browser_trace action: ${action}`)
    }

    case 'browser_exec': {
      const res = await manager.exec(sessionId ?? 'default', String(args.code), {
        timeoutMs: args.timeoutMs as number | undefined,
        tabId: explicitTabId,
        tracePath: typeof args.tracePath === 'string' && args.tracePath.trim() ? args.tracePath : undefined,
        sandboxMode: args.sandboxMode as ExecSandboxMode | undefined,
      })
      const chunks: string[] = []
      if (res.stdout) chunks.push(res.stdout)
      if (res.returnValue !== undefined) {
        chunks.push(`=> ${typeof res.returnValue === 'string' ? res.returnValue : JSON.stringify(res.returnValue, null, 2)}`)
      }
      if (res.uncaughtBrowserErrors.length > 0) {
        chunks.push(`Uncaught browser errors:\n${res.uncaughtBrowserErrors.join('\n')}`)
      }
      if (res.tracePath) {
        chunks.push(`Saved Trace report -> ${res.tracePath}`)
      }
      if (res.error) {
        return { content: [{ type: 'text', text: `${chunks.join('\n')}\nERROR: ${res.error}`.trim() }], isError: true }
      }
      return textResult(chunks.join('\n') || '(ok)', res.tracePath ? { tracePath: res.tracePath } : undefined)
    }

    default:
      return null
  }
}
