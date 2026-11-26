import { createTwoFilesPatch } from 'diff'
import type { RefTarget, SnapshotOptions, SnapshotResult } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'

export interface RawAXValue {
  type?: string
  value?: unknown
}

export interface RawAXProperty {
  name: string
  value: RawAXValue
}

export interface RawAXNode {
  nodeId: string
  ignored?: boolean
  role?: RawAXValue
  name?: RawAXValue
  value?: RawAXValue
  description?: RawAXValue
  properties?: RawAXProperty[]
  childIds?: string[]
  backendDOMNodeId?: number
  frameId?: string
}

const INTERACTIVE_ROLES = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'treeitem',
  'gridcell',
  'summary',
])

const LANDMARK_AND_STRUCTURE_ROLES = new Set([
  'RootWebArea',
  'WebArea',
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'article',
  'heading',
  'list',
  'listitem',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'tablist',
  'tabpanel',
  'menu',
  'menubar',
  'toolbar',
  'tree',
  'img',
  'figure',
  'blockquote',
  'code',
  'Iframe',
  'iframe',
])

const CONTAINER_LANDMARK_ROLES = new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'region',
  'form',
  'search',
  'dialog',
  'alertdialog',
  'tablist',
  'tabpanel',
  'menu',
  'menubar',
  'toolbar',
  'Iframe',
  'iframe',
])

// Leaf-only text layout artifacts that never contain semantic descendants.
// LayoutTable / LayoutTableRow / LayoutTableCell are intentionally NOT skipped here —
// they flatten transparently via the non-meaningful wrapper branch so table-layout sites
// (e.g. Hacker News, legacy enterprise ERPs, email portals) still expose all child controls.
const SKIPPED_ROLES = new Set(['InlineTextBox', 'LineBreak'])

const LEAF_LABELED_ROLES = new Set([
  'link',
  'button',
  'heading',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'checkbox',
  'radio',
  'switch',
  'textbox',
  'searchbox',
  'combobox',
])

function getProp(node: RawAXNode, name: string): unknown {
  const prop = node.properties?.find((p) => p.name === name)
  return prop?.value?.value
}

function normalizeWs(raw: unknown): string {
  if (raw === undefined || raw === null) return ''
  return String(raw).replace(/\s+/g, ' ').trim()
}

function cleanText(raw: unknown, maxLen: number = 140): string {
  const s = normalizeWs(raw)
  if (!s) return ''
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen - 1)}…`
}

export interface FormatAXTreeOptions {
  sessionId?: string
  includeText?: boolean
  interactiveOnly?: boolean
  maxDepth?: number
  startingRefIndex?: number
  scopeBackendNodeId?: number
  scopeBackendNodeIds?: Set<number>
  visibleBackendNodeIds?: Set<number>
}

export interface FormattedAXTree {
  lines: string[]
  refs: Record<string, RefTarget>
  nextRefIndex: number
  skippedOffscreen?: number
}

/**
 * Pure function converting Chromium CDP Accessibility.getFullAXTree nodes into a compact,
 * LLM-friendly hierarchical snapshot with deterministic short refs (`e1`, `e2`, ...).
 */
export function formatAXTree(nodes: RawAXNode[], options: FormatAXTreeOptions = {}): FormattedAXTree {
  const interactiveOnly = options.interactiveOnly === true
  const includeText = interactiveOnly ? false : (options.includeText ?? true)
  const maxDepth = options.maxDepth ?? 40
  const visibleSet = options.visibleBackendNodeIds
  let refCounter = options.startingRefIndex ?? 1
  let skippedOffscreen = 0
  const refs: Record<string, RefTarget> = {}
  const lines: string[] = []

  if (!nodes.length) {
    return { lines, refs, nextRefIndex: refCounter, skippedOffscreen }
  }

  const nodeMap = new Map<string, RawAXNode>()
  for (const n of nodes) {
    nodeMap.set(n.nodeId, n)
  }

  let startNodes: RawAXNode[] = [nodes[0]]
  if (options.scopeBackendNodeId !== undefined) {
    const direct = nodes.find((n) => n.backendDOMNodeId === options.scopeBackendNodeId)
    if (direct) {
      startNodes = [direct]
    } else if (options.scopeBackendNodeIds && options.scopeBackendNodeIds.size > 0) {
      startNodes = nodes.filter(
        (n) => n.backendDOMNodeId !== undefined && options.scopeBackendNodeIds!.has(n.backendDOMNodeId),
      )
      if (!startNodes.length) {
        return { lines, refs, nextRefIndex: refCounter, skippedOffscreen }
      }
    } else {
      return { lines, refs, nextRefIndex: refCounter, skippedOffscreen }
    }
  }

  const visited = new Set<string>()

  function renderNode(
    node: RawAXNode,
    depth: number,
    parentName: string,
    parentLeafText: string,
    ancestorVisible: boolean,
  ): void {
    if (depth > maxDepth || visited.has(node.nodeId)) return
    visited.add(node.nodeId)

    const role = String(node.role?.value ?? '')
    if (SKIPPED_ROLES.has(role)) return

    const children = (node.childIds ?? [])
      .map((id) => nodeMap.get(id))
      .filter((c): c is RawAXNode => Boolean(c))

    const selfVisible = !visibleSet
      ? true
      : node.backendDOMNodeId !== undefined
        ? visibleSet.has(node.backendDOMNodeId)
        : ancestorVisible

    if (node.ignored) {
      for (const child of children) renderNode(child, depth, parentName, parentLeafText, selfVisible)
      return
    }

    const fullRawName = normalizeWs(node.name?.value)
    const name = cleanText(fullRawName)
    const value = cleanText(node.value?.value, 100)
    const isInteractive = INTERACTIVE_ROLES.has(role) || getProp(node, 'focusable') === true

    // Root container: recurse transparently
    if (role === 'RootWebArea' || role === 'WebArea') {
      for (const child of children) renderNode(child, depth, name, '', false)
      return
    }

    // Static text: skip when already represented inside a parent accessible name or split highlight fragment
    if (role === 'StaticText') {
      if (!includeText || !name || name === parentName) return
      if (parentLeafText && parentLeafText.includes(fullRawName)) return
      if (visibleSet && !selfVisible && !ancestorVisible) {
        skippedOffscreen++
        return
      }
      lines.push(`${'  '.repeat(depth)}- text: "${name}"`)
      return
    }

    // Transparent generic / structural wrappers (in interactiveOnly mode, non-container prose/list/table wrappers flatten transparently)
    const isMeaningful = interactiveOnly
      ? isInteractive || CONTAINER_LANDMARK_ROLES.has(role)
      : isInteractive || LANDMARK_AND_STRUCTURE_ROLES.has(role)
    if (!isMeaningful) {
      for (const child of children) renderNode(child, depth, parentName, parentLeafText, selfVisible)
      return
    }

    // In viewportOnly mode, leaf interactive/content nodes outside viewport are skipped (unless they have visible descendants)
    const isLeafLike = isInteractive || LEAF_LABELED_ROLES.has(role) || role === 'img' || role === 'cell' || role === 'row'
    if (visibleSet && isLeafLike && !selfVisible && children.length === 0) {
      skippedOffscreen++
      return
    }

    // Skip empty containers with no name and no rendered children
    const lineStartIndex = lines.length
    const refsStartIndex = refCounter
    const indent = '  '.repeat(depth)

    let assignedRef: string | null = null
    let refPrefix = ''
    if (isInteractive && node.backendDOMNodeId && (!visibleSet || selfVisible)) {
      const ref = `e${refCounter++}`
      assignedRef = ref
      refs[ref] = {
        ref,
        backendDOMNodeId: node.backendDOMNodeId,
        frameId: node.frameId,
        sessionId: options.sessionId,
        role,
        name,
      }
      refPrefix = `[${ref}] `
    }

    const attrs: string[] = []
    const level = getProp(node, 'level')
    if (role === 'heading' && typeof level === 'number') attrs.push(`level=${level}`)
    if (value && value !== name) attrs.push(`value="${value}"`)

    const checked = getProp(node, 'checked')
    if (checked === 'true' || checked === true) attrs.push('checked')
    else if (checked === 'mixed') attrs.push('checked=mixed')

    const selected = getProp(node, 'selected')
    if (selected === true) attrs.push('selected')

    const expanded = getProp(node, 'expanded')
    if (expanded === true) attrs.push('expanded=true')
    else if (expanded === false) attrs.push('expanded=false')

    const disabled = getProp(node, 'disabled')
    if (disabled === true) attrs.push('disabled')

    const required = getProp(node, 'required')
    if (required === true) attrs.push('required')

    const urlProp = getProp(node, 'url')
    if (typeof urlProp === 'string' && urlProp && role === 'link') {
      attrs.push(`url="${cleanText(urlProp, 80)}"`)
    }

    const namePart = name ? ` "${name}"` : ''
    const attrPart = attrs.length > 0 ? ` (${attrs.join(', ')})` : ''
    lines.push(`${indent}- ${refPrefix}${role}${namePart}${attrPart}`)

    // Recurse children (suppress duplicate/split StaticText fragments already covered by leaf-labeled ancestor)
    const nextLeafText = fullRawName && LEAF_LABELED_ROLES.has(role) ? fullRawName : parentLeafText
    for (const child of children) {
      renderNode(child, depth + 1, name || parentName, nextLeafText, selfVisible)
    }

    // In viewportOnly mode, drop offscreen nodes that ended up with no rendered visible descendants
    if (visibleSet && !selfVisible && lines.length === lineStartIndex + 1) {
      lines.pop()
      if (assignedRef) {
        delete refs[assignedRef]
        refCounter = refsStartIndex
      }
      skippedOffscreen++
      return
    }

    // In interactiveOnly mode, drop any container landmark that enclosed zero interactive elements
    if (interactiveOnly && !isInteractive && refCounter === refsStartIndex) {
      lines.length = lineStartIndex
      return
    }

    // Prune completely empty non-interactive landmark containers
    if (!isInteractive && !name && attrs.length === 0 && lines.length === lineStartIndex + 1) {
      lines.pop()
    }
  }

  for (const start of startNodes) {
    renderNode(start, 0, '', '', false)
  }
  return { lines, refs, nextRefIndex: refCounter, skippedOffscreen }
}

export function filterSnapshotLines(fullText: string, search: string | RegExp, maxMatches = 40): string {
  const allLines = fullText.split('\n')
  const header = allLines[0]?.startsWith('URL:') ? allLines[0] : ''
  const body = header ? allLines.slice(1) : allLines
  let regex: RegExp
  if (search instanceof RegExp) {
    regex = search
  } else {
    try {
      regex = new RegExp(search, 'i')
    } catch {
      regex = new RegExp(escapeRegex(search), 'i')
    }
  }

  const matchedIndices = new Set<number>()
  let count = 0
  for (let i = 0; i < body.length; i++) {
    if (regex.test(body[i])) {
      count++
      if (count > maxMatches) break
      for (let ctx = Math.max(0, i - 1); ctx <= Math.min(body.length - 1, i + 1); ctx++) {
        matchedIndices.add(ctx)
      }
    }
  }

  if (matchedIndices.size === 0) {
    return `${header ? `${header}\n` : ''}No matches found for ${String(search)}`
  }

  const sorted = Array.from(matchedIndices).sort((a, b) => a - b)
  const out: string[] = []
  if (header) out.push(header, '')
  let prev = -2
  for (const idx of sorted) {
    if (prev >= 0 && idx > prev + 1) out.push('...')
    out.push(body[idx])
    prev = idx
  }
  if (count > maxMatches) {
    out.push(`... (${count - maxMatches}+ more matches omitted)`)
  }
  return out.join('\n')
}

export function computeDiffIfShorter(prevText: string, nextText: string, headerLine: string): { text: string; isDiff: boolean } {
  if (prevText === nextText) {
    return {
      text: `${headerLine}\n\nNo changes since last snapshot.`,
      isDiff: true,
    }
  }

  const patch = createTwoFilesPatch('previous', 'current', prevText, nextText, '', '', { context: 2 })
  const diffBody = patch
    .split('\n')
    .filter((line) => !line.startsWith('===') && !line.startsWith('---') && !line.startsWith('+++'))
    .join('\n')
    .trim()

  const formattedDiff = `${headerLine}\n\n${diffBody}`
  if (formattedDiff.length < nextText.length) {
    return { text: formattedDiff, isDiff: true }
  }
  return { text: nextText, isDiff: false }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function applyCharBudget(
  headerLine: string,
  lines: string[],
  maxChars: number,
): { text: string; truncated: boolean; omittedLines: number } {
  const fullBody = lines.join('\n')
  const fullText = `${headerLine}\n\n${fullBody}`
  if (!maxChars || maxChars <= 0 || fullText.length <= maxChars) {
    return { text: fullText, truncated: false, omittedLines: 0 }
  }

  const reserveFooter = 180
  const budget = Math.max(200, maxChars - headerLine.length - reserveFooter)
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = line.length + 1
    if (used + cost > budget && kept.length > 0) break
    kept.push(line)
    used += cost
  }
  const omitted = Math.max(0, lines.length - kept.length)
  if (omitted === 0) {
    return { text: fullText, truncated: false, omittedLines: 0 }
  }
  const footer = `\n... [Truncated: showing ${kept.length}/${lines.length} lines (${used}/${fullBody.length} chars, ${omitted} omitted). Narrow with viewportOnly: true, interactiveOnly: true, scope: "#selector", or search: "keyword"]`
  return {
    text: `${headerLine}\n\n${kept.join('\n')}${footer}`,
    truncated: true,
    omittedLines: omitted,
  }
}

interface RawDOMSnapshot {
  documents?: Array<{
    nodes?: { backendNodeId?: number[] }
    layout?: { nodeIndex?: number[]; bounds?: number[][] }
  }>
}

function extractVisibleBackendIds(
  snap: RawDOMSnapshot | null,
  viewport: { vw: number; vh: number; scrollX: number; scrollY: number },
  marginPx = 120,
): Set<number> | undefined {
  const doc = snap?.documents?.[0]
  const backendIds = doc?.nodes?.backendNodeId
  const nodeIndices = doc?.layout?.nodeIndex
  const bounds = doc?.layout?.bounds
  if (!backendIds || !nodeIndices || !bounds) return undefined

  const minX = viewport.scrollX - marginPx
  const maxX = viewport.scrollX + viewport.vw + marginPx
  const minY = viewport.scrollY - marginPx
  const maxY = viewport.scrollY + viewport.vh + marginPx
  const visible = new Set<number>()

  for (let i = 0; i < nodeIndices.length; i++) {
    const idx = nodeIndices[i]
    const rect = bounds[i]
    if (!rect || rect.length < 4) continue
    const [x, y, w, h] = rect
    if (w <= 0 || h <= 0) continue
    const bid = backendIds[idx]
    if (!bid) continue
    if (x + w >= minX && x <= maxX && y + h >= minY && y <= maxY) {
      visible.add(bid)
    }
  }
  return visible.size > 0 ? visible : undefined
}

/**
 * Per-tab stateful Accessibility Snapshot engine with ref registry and diff history.
 */
export class SnapshotEngine {
  private lastFullSnapshot = new Map<string, string>()
  private refMaps = new Map<number, Record<string, RefTarget>>()

  async capture(session: TabCDPSession, options: SnapshotOptions = {}): Promise<SnapshotResult> {
    await Promise.all([session.ensureBaseDomains(), session.enableDomain('Accessibility').catch(() => {})])

    const metaPromise = session.send<{
      result?: {
        value?: {
          url: string
          title: string
          vw: number
          vh: number
          scrollX: number
          scrollY: number
          scrollHeight: number
        }
      }
    }>('Runtime.evaluate', {
      expression: `({
        url: location.href,
        title: document.title,
        vw: window.innerWidth,
        vh: window.innerHeight,
        scrollX: Math.round(window.scrollX || document.documentElement.scrollLeft || 0),
        scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
        scrollHeight: Math.round(document.documentElement.scrollHeight || document.body?.scrollHeight || 0),
      })`,
      returnByValue: true,
    })

    // Single-frame targeted snapshot (supports cross-origin OOPIF and same-origin iframes)
    if (options.frame) {
      const [meta, targetFrame] = await Promise.all([metaPromise, session.resolveFrame(options.frame)])
      const m = meta.result?.value
      const url = m?.url ?? ''
      const title = m?.title ?? ''
      if (!targetFrame) {
        throw new Error(`Snapshot frame not found: ${options.frame}`)
      }
      let formatted: FormattedAXTree
      if (targetFrame.sessionId) {
        await session.ensureChildAccessibility(targetFrame.sessionId)
        const childRes = await session.send<{ nodes: RawAXNode[] }>(
          'Accessibility.getFullAXTree',
          {},
          { sessionId: targetFrame.sessionId },
        )
        formatted = formatAXTree(childRes.nodes ?? [], {
          sessionId: targetFrame.sessionId,
          includeText: options.includeText,
          interactiveOnly: options.interactiveOnly,
          maxDepth: options.maxDepth,
          startingRefIndex: 1,
        })
      } else {
        const frameRes = await session
          .send<{ nodes: RawAXNode[] }>('Accessibility.getFullAXTree', { frameId: targetFrame.frameId })
          .catch(() => ({ nodes: [] as RawAXNode[] }))
        if (frameRes.nodes && frameRes.nodes.length > 0) {
          formatted = formatAXTree(frameRes.nodes, {
            includeText: options.includeText,
            interactiveOnly: options.interactiveOnly,
            maxDepth: options.maxDepth,
            startingRefIndex: 1,
          })
        } else {
          // Fallback via DOM.getFrameOwner subtree inside main AXTree
          const [owner, mainRes] = await Promise.all([
            targetFrame.frameId
              ? session.send<{ backendNodeId?: number }>('DOM.getFrameOwner', { frameId: targetFrame.frameId }).catch(() => null)
              : Promise.resolve(null),
            session.send<{ nodes: RawAXNode[] }>('Accessibility.getFullAXTree'),
          ])
          formatted = formatAXTree(mainRes.nodes ?? [], {
            includeText: options.includeText,
            interactiveOnly: options.interactiveOnly,
            maxDepth: options.maxDepth,
            scopeBackendNodeId: owner?.backendNodeId,
            startingRefIndex: 1,
          })
        }
      }

      this.refMaps.set(session.tabId, formatted.refs)
      const frameHeader = `URL: ${url}${title ? ` | Title: ${title}` : ''} | Frame: ${cleanText(targetFrame.url || options.frame, 120)}`
      const frameFullText = `${frameHeader}\n\n${formatted.lines.join('\n') || '(empty frame accessibility tree)'}`
      return {
        url: targetFrame.url || url,
        title,
        text: options.search !== undefined ? filterSnapshotLines(frameFullText, options.search) : frameFullText,
        isDiff: false,
        totalRefs: Object.keys(formatted.refs).length,
        refs: formatted.refs,
      }
    }

    // Kick off main AXTree + optional DOMSnapshot + optional OOPIF child AXTrees concurrently with meta & scope resolution!
    const domSnapPromise: Promise<RawDOMSnapshot | null> = options.viewportOnly
      ? session
          .send<RawDOMSnapshot>('DOMSnapshot.captureSnapshot', { computedStyles: [] })
          .catch(() => null)
      : Promise.resolve(null)
    const mainAxPromise = session.send<{ nodes: RawAXNode[] }>('Accessibility.getFullAXTree')

    const childSessions = options.includeIframes !== false && !options.scope ? session.getChildSessions() : []
    const childAxPromises = childSessions.map(async (child) => {
      try {
        await session.ensureChildAccessibility(child.sessionId)
        const childRes = await session.send<{ nodes: RawAXNode[] }>(
          'Accessibility.getFullAXTree',
          {},
          { sessionId: child.sessionId },
        )
        return { child, nodes: childRes.nodes ?? [] }
      } catch {
        return { child, nodes: [] as RawAXNode[] }
      }
    })

    // Resolve optional scope element in parallel with meta + AXTree
    const scopePromise: Promise<number | undefined> = (async () => {
      if (!options.scope) return undefined
      const existingRef = this.getRef(session.tabId, options.scope)
      if (existingRef) return existingRef.backendDOMNodeId
      const doc = await session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
      const found = await session
        .send<{ nodeId: number }>('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: options.scope,
        })
        .catch(() => ({ nodeId: 0 }))
      if (found.nodeId) {
        const desc = await session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', {
          nodeId: found.nodeId,
        })
        return desc.node.backendNodeId
      }
      // Deep Shadow DOM / role fallback
      const evalFound = await session
        .send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
          expression: `(() => {
            const raw = ${JSON.stringify(options.scope)};
            const roleMatch = /^role=([a-z0-9_-]+)$/i.exec(raw.trim());
            const queue = [document];
            while (queue.length) {
              const root = queue.shift();
              if (roleMatch) {
                const hit = root.querySelector('[role="' + roleMatch[1] + '"], ' + roleMatch[1]);
                if (hit) return hit;
              } else {
                try {
                  const hit = root.querySelector(raw);
                  if (hit) return hit;
                } catch {}
              }
              for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) queue.push(el.shadowRoot);
              }
            }
            return null;
          })()`,
        })
        .catch(() => null)
      if (evalFound?.result?.objectId) {
        const desc = await session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', {
          objectId: evalFound.result.objectId,
        })
        return desc.node.backendNodeId
      }
      throw new Error(`Snapshot scope selector not found: ${options.scope}`)
    })()

    const [meta, rawDomSnap, mainRes, scopeBackendNodeId, childResults] = await Promise.all([
      metaPromise,
      domSnapPromise,
      mainAxPromise,
      scopePromise,
      Promise.all(childAxPromises),
    ])

    const m = meta.result?.value
    const url = m?.url ?? ''
    const title = m?.title ?? ''
    const scrollInfo =
      m && m.scrollHeight > m.vh + 20
        ? ` | Viewport: ${m.vw}x${m.vh} | Scroll: ${m.scrollY}/${m.scrollHeight}px (${Math.min(100, Math.round(((m.scrollY + m.vh) / m.scrollHeight) * 100))}%)`
        : m?.vw
          ? ` | Viewport: ${m.vw}x${m.vh}`
          : ''

    const visibleBackendNodeIds =
      options.viewportOnly && m?.vw && m?.vh
        ? extractVisibleBackendIds(rawDomSnap, {
            vw: m.vw,
            vh: m.vh,
            scrollX: m.scrollX ?? 0,
            scrollY: m.scrollY ?? 0,
          })
        : undefined

    const mainNodes = mainRes.nodes ?? []

    // If scope targets a Web Component / Shadow host or generic wrapper omitted from AXTree,
    // pierce into its shadowRoots & DOM children to collect matching descendant AX backendNodeIds.
    let scopeBackendNodeIds: Set<number> | undefined
    if (scopeBackendNodeId !== undefined && !mainNodes.some((n) => n.backendDOMNodeId === scopeBackendNodeId)) {
      type DomDescNode = { backendNodeId?: number; children?: DomDescNode[]; shadowRoots?: DomDescNode[] }
      const desc = await session
        .send<{ node?: DomDescNode }>('DOM.describeNode', {
          backendNodeId: scopeBackendNodeId,
          depth: 4,
          pierce: true,
        })
        .catch(() => null)
      if (desc?.node) {
        const axBackendIds = new Set(
          mainNodes.map((n) => n.backendDOMNodeId).filter((id): id is number => id !== undefined),
        )
        const matched = new Set<number>()
        const walkDom = (node: DomDescNode): void => {
          if (node.backendNodeId && node.backendNodeId !== scopeBackendNodeId && axBackendIds.has(node.backendNodeId)) {
            matched.add(node.backendNodeId)
            return
          }
          for (const sr of node.shadowRoots ?? []) walkDom(sr)
          for (const ch of node.children ?? []) walkDom(ch)
        }
        walkDom(desc.node)
        if (matched.size > 0) scopeBackendNodeIds = matched
      }
    }

    const mainFormatted = formatAXTree(mainNodes, {
      includeText: options.includeText,
      interactiveOnly: options.interactiveOnly,
      maxDepth: options.maxDepth,
      scopeBackendNodeId,
      scopeBackendNodeIds,
      visibleBackendNodeIds,
      startingRefIndex: 1,
    })

    const allLines = [...mainFormatted.lines]
    const allRefs: Record<string, RefTarget> = { ...mainFormatted.refs }
    let nextRef = mainFormatted.nextRefIndex

    // Merge OOPIF child iframe results in deterministic order
    for (const { child, nodes } of childResults) {
      if (!nodes.length) continue
      const formatted = formatAXTree(nodes, {
        sessionId: child.sessionId,
        includeText: options.includeText,
        interactiveOnly: options.interactiveOnly,
        maxDepth: options.maxDepth,
        startingRefIndex: nextRef,
      })
      if (formatted.lines.length > 0) {
        allLines.push(`- iframe "${cleanText(child.url, 100)}":`)
        for (const line of formatted.lines) {
          allLines.push(`  ${line}`)
        }
        Object.assign(allRefs, formatted.refs)
        nextRef = formatted.nextRefIndex
      }
    }

    this.refMaps.set(session.tabId, allRefs)

    const modeFlags: string[] = []
    if (options.interactiveOnly) modeFlags.push('interactive')
    if (options.viewportOnly) modeFlags.push('viewport')
    if (options.scope) modeFlags.push(`scope=${cleanText(options.scope, 40)}`)
    const modeLabel = modeFlags.length ? ` | Mode: ${modeFlags.join(',')}` : ''
    const headerLine = `URL: ${url}${title ? ` | Title: ${title}` : ''}${scrollInfo}${modeLabel}`
    const emptyMsg = options.viewportOnly
      ? '(no visible elements in current viewport — try scrolling or disabling viewportOnly)'
      : options.interactiveOnly
        ? '(no interactive elements)'
        : '(empty accessibility tree)'

    const rawFullText = `${headerLine}\n\n${allLines.join('\n') || emptyMsg}`
    const snapshotCacheKey = `${session.tabId}:${options.interactiveOnly ? 'interactive' : 'full'}${options.viewportOnly ? ':vp' : ''}`
    const prevFull = this.lastFullSnapshot.get(snapshotCacheKey)
    if (!options.scope) {
      this.lastFullSnapshot.set(snapshotCacheKey, rawFullText)
    }

    if (options.search !== undefined) {
      const wantDiff = options.showDiffSinceLastCall === true && prevFull !== undefined
      const source = wantDiff ? computeDiffIfShorter(prevFull, rawFullText, headerLine).text : rawFullText
      return {
        url,
        title,
        text: filterSnapshotLines(source, options.search),
        isDiff: wantDiff,
        totalRefs: Object.keys(allRefs).length,
        refs: allRefs,
        truncated: false,
        omittedLines: 0,
      }
    }

    const showDiff = options.showDiffSinceLastCall ?? !options.scope
    if (showDiff && prevFull !== undefined) {
      const diffed = computeDiffIfShorter(prevFull, rawFullText, headerLine)
      const diffLines = diffed.text.split('\n').slice(2)
      const budgetedDiff =
        options.maxChars && options.maxChars > 0 && diffed.text.length > options.maxChars
          ? applyCharBudget(headerLine, diffLines, options.maxChars)
          : { text: diffed.text, truncated: false, omittedLines: 0 }
      return {
        url,
        title,
        text: budgetedDiff.text,
        isDiff: diffed.isDiff,
        totalRefs: Object.keys(allRefs).length,
        refs: allRefs,
        truncated: budgetedDiff.truncated,
        omittedLines: budgetedDiff.omittedLines,
      }
    }

    const budgeted =
      options.maxChars && options.maxChars > 0 && allLines.length > 0
        ? applyCharBudget(headerLine, allLines, options.maxChars)
        : { text: rawFullText, truncated: false, omittedLines: 0 }

    return {
      url,
      title,
      text: budgeted.text,
      isDiff: false,
      totalRefs: Object.keys(allRefs).length,
      refs: allRefs,
      truncated: budgeted.truncated,
      omittedLines: budgeted.omittedLines,
    }
  }

  getRef(tabId: number, ref: string): RefTarget | undefined {
    const clean = ref.replace(/^@/, '').replace(/^aria-ref=/, '')
    return this.refMaps.get(tabId)?.[clean]
  }

  getAllRefs(tabId: number): Record<string, RefTarget> {
    return this.refMaps.get(tabId) ?? {}
  }

  /**
   * Registers a resolved element into the tab's ref map (reusing an existing `[eN]` ref if
   * the same `backendDOMNodeId` + `sessionId` is already tracked) without clobbering existing refs.
   */
  registerRef(tabId: number, entry: Omit<RefTarget, 'ref'>): string {
    let map = this.refMaps.get(tabId)
    if (!map) {
      map = {}
      this.refMaps.set(tabId, map)
    }
    for (const [ref, existing] of Object.entries(map)) {
      if (existing.backendDOMNodeId === entry.backendDOMNodeId && existing.sessionId === entry.sessionId) {
        return ref
      }
    }
    let maxIdx = 0
    for (const ref of Object.keys(map)) {
      const m = /^e(\d+)$/.exec(ref)
      if (m) {
        const n = Number(m[1])
        if (n > maxIdx) maxIdx = n
      }
    }
    const newRef = `e${maxIdx + 1}`
    map[newRef] = { ref: newRef, ...entry }
    return newRef
  }

  clearTab(tabId: number): void {
    this.lastFullSnapshot.delete(`${tabId}:full`)
    this.lastFullSnapshot.delete(`${tabId}:interactive`)
    this.lastFullSnapshot.delete(`${tabId}:full:vp`)
    this.lastFullSnapshot.delete(`${tabId}:interactive:vp`)
    this.refMaps.delete(tabId)
  }
}
