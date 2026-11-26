/**
 * Desugars Playwright-style pseudo-selectors (`:has-text(...)` and `:visible`) inside a single stage
 * into equivalent BrowserPilot pipeline stages so selectors like `button:has-text("Save"):visible`
 * work natively alongside `button >> has-text="Save" >> visible=true`.
 */
function expandPlaywrightPseudos(stage: string): string[] {
  if (/^(text|role|label|placeholder|alt|title|testid|xpath|has-text|has|visible|nth|first|last|pinned)\b/i.test(stage)) {
    return [stage]
  }
  const extraStages: string[] = []
  let base = stage

  base = base.replace(/:has-text\((?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]+))\)/gi, (_m, dq, sq, raw) => {
    const val = dq !== undefined ? `"${dq}"` : sq !== undefined ? `'${sq}'` : String(raw).trim()
    extraStages.push(`has-text=${val}`)
    return ''
  })

  if (/:visible\b/i.test(base)) {
    base = base.replace(/:visible\b/gi, '')
    extraStages.push('visible=true')
  }

  const cleaned = base.trim()
  if (!extraStages.length) return [stage]
  return [cleaned || '*', ...extraStages]
}

/**
 * Splits a chained locator string by `>>` while respecting quotes, brackets, and regex literals,
 * and expands Playwright-style `:has-text(...)` and `:visible` shorthands.
 */
export function splitLocatorChain(raw: string): string[] {
  const rawStages: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let bracketDepth = 0
  let inRegex = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    const prev = i > 0 ? raw[i - 1] : ''

    if (quote) {
      current += ch
      if (ch === quote && prev !== '\\') quote = null
      continue
    }
    if (inRegex) {
      current += ch
      if (ch === '/' && prev !== '\\') inRegex = false
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '[') {
      bracketDepth++
      current += ch
      continue
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth--
      current += ch
      continue
    }
    if (ch === '/' && (prev === '=' || prev === ' ' || prev === '')) {
      const rest = raw.slice(i + 1)
      if (/^[^/\n]+\/[gimsuy]*(\s*>>|\s*$)/.test(rest)) {
        inRegex = true
        current += ch
        continue
      }
    }
    if (bracketDepth === 0 && ch === '>' && raw[i + 1] === '>') {
      const trimmed = current.trim()
      if (trimmed) rawStages.push(trimmed)
      current = ''
      i++ // skip second '>'
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) rawStages.push(tail)

  const expanded: string[] = []
  for (const s of rawStages) {
    expanded.push(...expandPlaywrightPseudos(s))
  }
  return expanded
}
