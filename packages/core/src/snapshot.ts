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

const SKIPPED_ROLES = new Set(['InlineTextBox', 'LineBreak', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell'])

function getProp(node: RawAXNode, name: string): unknown {
  const prop = node.properties?.find((p) => p.name === name)
  return prop?.value?.value
}

function cleanText(raw: unknown, maxLen: number = 140): string {
  if (raw === undefined || raw === null) return ''
  const s = String(raw).replace(/\s+/g, ' ').trim()
  if (s.length <= maxLen) return s
  return `${s.slice(0, maxLen - 1)}…`
}

export interface FormatAXTreeOptions {
  sessionId?: string
  includeText?: boolean
  maxDepth?: number
  startingRefIndex?: number
  scopeBackendNodeId?: number
}

export interface FormattedAXTree {
  lines: string[]
  refs: Record<string, RefTarget>
  nextRefIndex: number
}

/**
 * Pure function converting Chromium CDP Accessibility.getFullAXTree nodes into a compact,
 * LLM-friendly hierarchical snapshot with deterministic short refs (`e1`, `e2`, ...).
 */
export function formatAXTree(nodes: RawAXNode[], options: FormatAXTreeOptions = {}): FormattedAXTree {
  const includeText = options.includeText ?? true
  const maxDepth = options.maxDepth ?? 40
  let refCounter = options.startingRefIndex ?? 1
  const refs: Record<string, RefTarget> = {}
  const lines: string[] = []

  if (!nodes.length) {
    return { lines, refs, nextRefIndex: refCounter }
  }

  const nodeMap = new Map<string, RawAXNode>()
  for (const n of nodes) {
    nodeMap.set(n.nodeId, n)
  }

  let rootNode: RawAXNode | undefined = nodes[0]
  if (options.scopeBackendNodeId !== undefined) {
    rootNode = nodes.find((n) => n.backendDOMNodeId === options.scopeBackendNodeId)
    if (!rootNode) {
      return { lines, refs, nextRefIndex: refCounter }
    }
  }

  const visited = new Set<string>()

  function renderNode(node: RawAXNode, depth: number, parentName: string): void {
    if (depth > maxDepth || visited.has(node.nodeId)) return
    visited.add(node.nodeId)

    const role = String(node.role?.value ?? '')
    if (SKIPPED_ROLES.has(role)) return

    const children = (node.childIds ?? [])
      .map((id) => nodeMap.get(id))
      .filter((c): c is RawAXNode => Boolean(c))

    if (node.ignored) {
      for (const child of children) renderNode(child, depth, parentName)
      return
    }

    const name = cleanText(node.name?.value)
    const value = cleanText(node.value?.value, 100)
    const isInteractive = INTERACTIVE_ROLES.has(role) || getProp(node, 'focusable') === true

    // Root container: recurse transparently
    if (role === 'RootWebArea' || role === 'WebArea') {
      for (const child of children) renderNode(child, depth, name)
      return
    }

    // Static text: emit only when meaningful and not duplicating parent accessible name
    if (role === 'StaticText') {
      if (includeText && name && name !== parentName) {
        lines.push(`${'  '.repeat(depth)}- text: "${name}"`)
      }
      return
    }

    // Transparent generic / structural wrappers
    const isMeaningful = isInteractive || LANDMARK_AND_STRUCTURE_ROLES.has(role)
    if (!isMeaningful) {
      for (const child of children) renderNode(child, depth, parentName)
      return
    }

    // Skip empty containers with no name and no rendered children
    const lineStartIndex = lines.length
    const indent = '  '.repeat(depth)

    let refPrefix = ''
    if (isInteractive && node.backendDOMNodeId) {
      const ref = `e${refCounter++}`
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

    // Recurse children (skip redundant static text child when interactive node already has its name)
    for (const child of children) {
      renderNode(child, depth + 1, name || parentName)
    }

    // Prune completely empty non-interactive landmark containers
    if (!isInteractive && !name && attrs.length === 0 && lines.length === lineStartIndex + 1) {
      lines.pop()
    }
  }

  renderNode(rootNode, 0, '')
  return { lines, refs, nextRefIndex: refCounter }
}

export function filterSnapshotLines(fullText: string, search: string | RegExp, maxMatches = 25): string {
  const allLines = fullText.split('\n')
  const header = allLines[0]?.startsWith('URL:') ? allLines[0] : ''
  const body = header ? allLines.slice(1) : allLines
  const regex = search instanceof RegExp ? search : new RegExp(escapeRegex(search), 'i')

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

/**
 * Per-tab stateful Accessibility Snapshot engine with ref registry and diff history.
 */
export class SnapshotEngine {
  private lastFullSnapshot = new Map<number, string>()
  private refMaps = new Map<number, Record<string, RefTarget>>()

  async capture(session: TabCDPSession, options: SnapshotOptions = {}): Promise<SnapshotResult> {
    await session.ensureBaseDomains()
    await session.enableDomain('Accessibility').catch(() => {})

    const meta = await session.send<{
      result?: {
        value?: {
          url: string
          title: string
          vw: number
          vh: number
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
        scrollY: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
        scrollHeight: Math.round(document.documentElement.scrollHeight || document.body?.scrollHeight || 0),
      })`,
      returnByValue: true,
    })
    const m = meta.result?.value
    const url = m?.url ?? ''
    const title = m?.title ?? ''
    const scrollInfo =
      m && m.scrollHeight > m.vh + 20
        ? ` | Viewport: ${m.vw}x${m.vh} | Scroll: ${m.scrollY}/${m.scrollHeight}px (${Math.min(100, Math.round(((m.scrollY + m.vh) / m.scrollHeight) * 100))}%)`
        : m?.vw
          ? ` | Viewport: ${m.vw}x${m.vh}`
          : ''

    // Resolve optional scope element
    let scopeBackendNodeId: number | undefined
    if (options.scope) {
      const existingRef = this.getRef(session.tabId, options.scope)
      if (existingRef) {
        scopeBackendNodeId = existingRef.backendDOMNodeId
      } else {
        const doc = await session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
        const found = await session.send<{ nodeId: number }>('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: options.scope,
        })
        if (!found.nodeId) {
          throw new Error(`Snapshot scope selector not found: ${options.scope}`)
        }
        const desc = await session.send<{ node: { backendNodeId: number } }>('DOM.describeNode', {
          nodeId: found.nodeId,
        })
        scopeBackendNodeId = desc.node.backendNodeId
      }
    }

    // Main frame AXTree
    const mainRes = await session.send<{ nodes: RawAXNode[] }>('Accessibility.getFullAXTree')
    const mainFormatted = formatAXTree(mainRes.nodes ?? [], {
      includeText: options.includeText,
      maxDepth: options.maxDepth,
      scopeBackendNodeId,
      startingRefIndex: 1,
    })

    const allLines = [...mainFormatted.lines]
    const allRefs: Record<string, RefTarget> = { ...mainFormatted.refs }
    let nextRef = mainFormatted.nextRefIndex

    // Include attached OOPIF child iframe sessions
    if (options.includeIframes !== false && !scopeBackendNodeId) {
      for (const child of session.getChildSessions()) {
        try {
          await session.send('Accessibility.enable', {}, { sessionId: child.sessionId }).catch(() => {})
          const childRes = await session.send<{ nodes: RawAXNode[] }>(
            'Accessibility.getFullAXTree',
            {},
            { sessionId: child.sessionId },
          )
          const formatted = formatAXTree(childRes.nodes ?? [], {
            sessionId: child.sessionId,
            includeText: options.includeText,
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
        } catch {
          // Ignore detached or inaccessible child frames
        }
      }
    }

    this.refMaps.set(session.tabId, allRefs)

    const headerLine = `URL: ${url}${title ? ` | Title: ${title}` : ''}${scrollInfo}`
    const fullText = `${headerLine}\n\n${allLines.join('\n') || '(empty accessibility tree)'}`

    const prevFull = this.lastFullSnapshot.get(session.tabId)
    if (!options.scope) {
      this.lastFullSnapshot.set(session.tabId, fullText)
    }

    if (options.search !== undefined) {
      const wantDiff = options.showDiffSinceLastCall === true && prevFull !== undefined
      const source = wantDiff ? computeDiffIfShorter(prevFull, fullText, headerLine).text : fullText
      return {
        url,
        title,
        text: filterSnapshotLines(source, options.search),
        isDiff: wantDiff,
        totalRefs: Object.keys(allRefs).length,
        refs: allRefs,
      }
    }

    const showDiff = options.showDiffSinceLastCall ?? !options.scope
    if (showDiff && prevFull !== undefined) {
      const diffed = computeDiffIfShorter(prevFull, fullText, headerLine)
      return {
        url,
        title,
        text: diffed.text,
        isDiff: diffed.isDiff,
        totalRefs: Object.keys(allRefs).length,
        refs: allRefs,
      }
    }

    return {
      url,
      title,
      text: fullText,
      isDiff: false,
      totalRefs: Object.keys(allRefs).length,
      refs: allRefs,
    }
  }

  getRef(tabId: number, ref: string): RefTarget | undefined {
    const clean = ref.replace(/^@/, '').replace(/^aria-ref=/, '')
    return this.refMaps.get(tabId)?.[clean]
  }

  getAllRefs(tabId: number): Record<string, RefTarget> {
    return this.refMaps.get(tabId) ?? {}
  }

  clearTab(tabId: number): void {
    this.lastFullSnapshot.delete(tabId)
    this.refMaps.delete(tabId)
  }
}
