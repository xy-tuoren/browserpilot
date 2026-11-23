import type { ElementStylesResult, StyleDeclaration, StyleRuleInfo } from '@devpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import type { SnapshotEngine } from './snapshot.js'

interface StyleSheetHeader {
  styleSheetId: string
  sourceURL?: string
  startLine?: number
}

interface RawCSSProperty {
  name: string
  value: string
  important?: boolean
  disabled?: boolean
}

interface RawCSSRule {
  styleSheetId?: string
  origin?: string
  selectorList?: { text?: string }
  style?: {
    cssProperties?: RawCSSProperty[]
    range?: { startLine?: number; startColumn?: number }
  }
}

export class StylesInspector {
  private readonly session: TabCDPSession
  private sheets = new Map<string, StyleSheetHeader>()
  private cssEnabled = false
  private cachedRootNodeId: number | null = null
  private unsubs: Array<() => void> = []

  constructor(session: TabCDPSession) {
    this.session = session
    this.unsubs.push(
      session.on('CSS.styleSheetAdded', (params) => {
        const h = params.header as StyleSheetHeader | undefined
        if (h?.styleSheetId) {
          this.sheets.set(h.styleSheetId, h)
        }
      }),
      session.on('DOM.documentUpdated', () => {
        this.cachedRootNodeId = null
      }),
    )
  }

  private async ensureEnabled(): Promise<void> {
    if (this.cssEnabled) return
    await this.session.enableDomain('DOM')
    await this.session.enableDomain('CSS')
    this.cssEnabled = true
  }

  private async getRootNodeId(): Promise<number> {
    if (this.cachedRootNodeId !== null) return this.cachedRootNodeId
    const doc = await this.session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
    this.cachedRootNodeId = doc.root.nodeId
    return this.cachedRootNodeId
  }

  private async resolveNodeId(target: string, snapshots: SnapshotEngine): Promise<{ nodeId: number; label: string }> {
    await this.ensureEnabled()
    await this.getRootNodeId()
    const refTarget = snapshots.getRef(this.session.tabId, target)
    if (refTarget) {
      const pushed = await this.session.send<{ nodeIds: number[] }>('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [refTarget.backendDOMNodeId],
      })
      const nodeId = pushed.nodeIds?.[0]
      if (!nodeId) throw new Error(`Could not resolve DOM node for ref ${target}`)
      return { nodeId, label: `${refTarget.role} "${refTarget.name}" (${target})` }
    }

    const rootNodeId = await this.getRootNodeId()
    const found = await this.session.send<{ nodeId: number }>('DOM.querySelector', {
      nodeId: rootNodeId,
      selector: target,
    })
    if (!found.nodeId) throw new Error(`Element not found for styles inspection: ${target}`)
    return { nodeId: found.nodeId, label: target }
  }

  async getStyles(
    target: string,
    snapshots: SnapshotEngine,
    options: { includeInherited?: boolean; includeUserAgent?: boolean; computedProperties?: string[] } = {},
  ): Promise<ElementStylesResult> {
    const { nodeId, label } = await this.resolveNodeId(target, snapshots)

    const matched = await this.session.send<{
      inlineStyle?: { cssProperties?: RawCSSProperty[] }
      matchedCSSRules?: Array<{ rule: RawCSSRule }>
      inherited?: Array<{ inlineStyle?: { cssProperties?: RawCSSProperty[] }; matchedCSSRules?: Array<{ rule: RawCSSRule }> }>
    }>('CSS.getMatchedStylesForNode', { nodeId })

    const seenProps = new Set<string>()

    const extractDecls = (props?: RawCSSProperty[]): StyleDeclaration[] => {
      if (!props) return []
      const out: StyleDeclaration[] = []
      for (const p of props) {
        if (p.disabled || !p.name || p.name.startsWith('-webkit-') || !p.value) continue
        const overridden = seenProps.has(p.name)
        seenProps.add(p.name)
        out.push({
          name: p.name,
          value: p.value,
          important: p.important || undefined,
          overridden: overridden || undefined,
        })
      }
      return out
    }

    const toRuleInfo = (raw: RawCSSRule, inherited = false): StyleRuleInfo | null => {
      const origin = raw.origin ?? 'regular'
      if (!options.includeUserAgent && origin === 'user-agent') return null
      const declarations = extractDecls(raw.style?.cssProperties)
      if (!declarations.length) return null
      const header = raw.styleSheetId ? this.sheets.get(raw.styleSheetId) : undefined
      return {
        selector: raw.selectorList?.text ?? '(anonymous)',
        origin,
        sourceUrl: header?.sourceURL || (origin === 'regular' ? '<inline style>' : origin),
        lineNumber: raw.style?.range?.startLine !== undefined ? raw.style.range.startLine + 1 : undefined,
        columnNumber: raw.style?.range?.startColumn !== undefined ? raw.style.range.startColumn + 1 : undefined,
        inherited: inherited || undefined,
        declarations,
      }
    }

    const inlineStyles = extractDecls(matched.inlineStyle?.cssProperties)

    // Matched rules in reverse cascade order (highest specificity last in CDP -> process reversed)
    const matchedRules: StyleRuleInfo[] = []
    for (const item of [...(matched.matchedCSSRules ?? [])].reverse()) {
      const info = toRuleInfo(item.rule, false)
      if (info) matchedRules.push(info)
    }

    const inheritedRules: StyleRuleInfo[] = []
    if (options.includeInherited !== false && matched.inherited) {
      for (const ancestor of matched.inherited) {
        for (const item of [...(ancestor.matchedCSSRules ?? [])].reverse()) {
          const info = toRuleInfo(item.rule, true)
          if (info) inheritedRules.push(info)
        }
      }
    }

    let computedSubset: Record<string, string> | undefined
    if (options.computedProperties?.length) {
      const comp = await this.session.send<{ computedStyle: Array<{ name: string; value: string }> }>(
        'CSS.getComputedStyleForNode',
        { nodeId },
      )
      const wanted = new Set(options.computedProperties)
      computedSubset = {}
      for (const item of comp.computedStyle ?? []) {
        if (wanted.has(item.name)) computedSubset[item.name] = item.value
      }
    }

    return {
      element: label,
      inlineStyles,
      matchedRules,
      inheritedRules,
      computedSubset,
    }
  }

  async forcePseudoState(
    target: string,
    snapshots: SnapshotEngine,
    pseudoClasses: Array<'active' | 'focus' | 'hover' | 'visited' | 'focus-within' | 'focus-visible'>,
  ): Promise<void> {
    const { nodeId } = await this.resolveNodeId(target, snapshots)
    await this.session.send('CSS.forcePseudoState', {
      nodeId,
      forcedPseudoClasses: pseudoClasses,
    })
  }

  getStyleSheets(): StyleSheetHeader[] {
    return Array.from(this.sheets.values())
  }

  dispose(): void {
    for (const off of this.unsubs) off()
    this.unsubs = []
  }
}

export function formatStylesAsText(styles: ElementStylesResult): string {
  const lines: string[] = [`Styles for ${styles.element}:`]

  if (styles.inlineStyles.length) {
    lines.push('  element.style {')
    for (const d of styles.inlineStyles) {
      lines.push(`    ${d.name}: ${d.value}${d.important ? ' !important' : ''};`)
    }
    lines.push('  }')
  }

  for (const r of styles.matchedRules) {
    const loc = r.sourceUrl ? ` /* ${r.sourceUrl}${r.lineNumber ? `:${r.lineNumber}` : ''} */` : ''
    lines.push(`  ${r.selector} {${loc}`)
    for (const d of r.declarations) {
      const strike = d.overridden ? ' /* overridden */' : ''
      lines.push(`    ${d.name}: ${d.value}${d.important ? ' !important' : ''};${strike}`)
    }
    lines.push('  }')
  }

  if (styles.inheritedRules.length) {
    lines.push('  /* Inherited */')
    for (const r of styles.inheritedRules.slice(0, 6)) {
      const loc = r.sourceUrl ? ` (${r.sourceUrl}${r.lineNumber ? `:${r.lineNumber}` : ''})` : ''
      const props = r.declarations.map((d) => `${d.name}: ${d.value}`).join('; ')
      lines.push(`  ${r.selector}${loc}: ${props}`)
    }
  }

  if (styles.computedSubset) {
    lines.push('  /* Computed */')
    for (const [k, v] of Object.entries(styles.computedSubset)) {
      lines.push(`    ${k}: ${v};`)
    }
  }

  return lines.join('\n')
}
