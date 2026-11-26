import { waitForPageLoad } from '@browserpilot/core'
import { wrapUntrustedPageContent, type TabGroupColor } from '@browserpilot/protocol'
import {
  formatFeedbackSuffix,
  normalizeNavigationUrl,
  textResult,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolExecutionResult,
} from './types.js'

export const NAVIGATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser_tabs',
    description: 'List all open Chrome tabs with tabId, URL, title, active state, and CDP attach status.',
    inputSchema: { type: 'object', properties: { clientId: { type: 'string' } } },
  },
  {
    name: 'browser_frames',
    description: 'List all frames and iframes (both same-origin and cross-origin OOPIF) in the active tab.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } },
    },
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
      'Capture semantic AXTree snapshot with short refs (e1, e2...). Supports diff, search, scope, viewportOnly, maxChars & frame.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        sessionId: { type: 'string' },
        search: { type: 'string', description: 'Filter lines by substring/regex' },
        scope: { type: 'string', description: 'Selector or ref to scope subtree' },
        frame: { type: 'string', description: 'Iframe selector, frameId, name, or URL' },
        interactiveOnly: {
          type: 'boolean',
          description: 'Interactive elements & landmarks only (~70% fewer tokens)',
        },
        viewportOnly: {
          type: 'boolean',
          description: 'Viewport-intersecting elements only (best for huge tables/feeds)',
        },
        maxChars: {
          type: 'number',
          description: 'Soft char budget (default 32000; 0 disables)',
        },
        showDiffSinceLastCall: { type: 'boolean', description: 'Diff since last snapshot (default true)' },
        includeText: { type: 'boolean' },
        includeIframes: { type: 'boolean' },
        wrapUntrusted: {
          type: 'boolean',
          description: 'Wrap output in <untrusted_page_content> boundary',
        },
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
        wrapUntrusted: { type: 'boolean' },
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
        wrapUntrusted: { type: 'boolean' },
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
    name: 'browser_pinned',
    description:
      'Inspect the element last pinned by the user via right-click -> "Pin Element for BrowserPilot" (returns outerHTML, inspect box/styles, and React Fiber info).',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, sessionId: { type: 'string' } },
    },
  },
]

export async function executeNavigationTool(
  ctx: ToolDispatchContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult | null> {
  const { manager, sessionId, explicitTabId, resolveTab } = ctx

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
      const maxChars =
        typeof args.maxChars === 'number'
          ? args.maxChars
          : args.search !== undefined
            ? 0
            : 32_000
      const snap = await tab.snapshots.capture(tab.session, {
        search: args.search as string | undefined,
        scope: args.scope as string | undefined,
        frame: args.frame as string | undefined,
        interactiveOnly: args.interactiveOnly as boolean | undefined,
        viewportOnly: args.viewportOnly as boolean | undefined,
        maxChars,
        showDiffSinceLastCall: args.showDiffSinceLastCall as boolean | undefined,
        includeText: args.includeText as boolean | undefined,
        includeIframes: args.includeIframes as boolean | undefined,
      })
      const shouldWrap = args.wrapUntrusted === true || process.env.BROWSERPILOT_UNTRUSTED_BOUNDARY === '1'
      const body = shouldWrap ? wrapUntrustedPageContent(snap.text, { url: snap.url, kind: 'snapshot' }) : snap.text
      return textResult(body, {
        totalRefs: snap.totalRefs,
        isDiff: snap.isDiff,
        truncated: snap.truncated,
        omittedLines: snap.omittedLines,
        tabId: tab.tabId,
      })
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
      const shouldWrap = args.wrapUntrusted === true || process.env.BROWSERPILOT_UNTRUSTED_BOUNDARY === '1'
      if (shouldWrap) {
        const meta = await tab.page.getUrlAndTitle().catch(() => ({ url: '' }))
        return textResult(wrapUntrustedPageContent(html, { url: meta.url, kind: 'html' }))
      }
      return textResult(html)
    }

    case 'browser_markdown': {
      const tab = await resolveTab()
      const md = await tab.extractor.getPageMarkdown(tab.session, {
        search: args.search as string | undefined,
        showDiffSinceLastCall: args.showDiffSinceLastCall as boolean | undefined,
      })
      const shouldWrap = args.wrapUntrusted === true || process.env.BROWSERPILOT_UNTRUSTED_BOUNDARY === '1'
      if (shouldWrap) {
        const meta = await tab.page.getUrlAndTitle().catch(() => ({ url: '' }))
        return textResult(wrapUntrustedPageContent(md, { url: meta.url, kind: 'markdown' }))
      }
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
      return null
  }
}
