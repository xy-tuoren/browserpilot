/**
 * Canonical, self-contained, cross-realm-safe DOM stable locator generator.
 *
 * IMPORTANT: This function is BOTH called directly in browser contexts (e.g. Chrome Extension
 * content scripts) AND serialized via `computeStableDomSelector.toString()` for injection into
 * CDP `Runtime.callFunctionOn` / `Runtime.evaluate`.
 *
 * Therefore, ALL helper functions MUST live inside `computeStableDomSelector` with ZERO external
 * module-scope references.
 */
export function computeStableDomSelector(this: unknown, targetEl?: unknown): string {
  type DomLikeElement = {
    nodeType?: number
    tagName: string
    id?: string
    classList?: Iterable<string>
    innerText?: string
    textContent?: string | null
    ownerDocument?: DomLikeRoot | null
    getAttribute(name: string): string | null
    closest?(selector: string): DomLikeElement | null
    getRootNode?(): DomLikeRoot
  }

  type DomLikeRoot = {
    host?: unknown
    defaultView?: DomLikeWindow | null
    querySelector?(selector: string): DomLikeElement | null
    querySelectorAll?(selector: string): ArrayLike<DomLikeElement>
  }

  type DomLikeWindow = {
    parent?: DomLikeWindow | null
    frameElement?: unknown
  }

  function isElem(node: unknown): node is DomLikeElement {
    return Boolean(node && typeof node === 'object' && (node as { nodeType?: number }).nodeType === 1)
  }

  function cssEsc(raw: string): string {
    const g = globalThis as { CSS?: { escape?: (s: string) => string } }
    if (g.CSS && typeof g.CSS.escape === 'function') {
      return g.CSS.escape(raw)
    }
    return String(raw).replace(/([^a-zA-Z0-9_-])/g, '\\$1')
  }

  function isDynamicId(id: string): boolean {
    if (!id) return true
    return (
      /^(:r|«r|radix-|headlessui-|mui-|ember\d+|el-id-|rc_select_|react-aria|react-select-)/i.test(id) ||
      /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)
    )
  }

  function findAssociatedLabelText(el: DomLikeElement, root: DomLikeRoot): string {
    try {
      const wrap = el.closest ? el.closest('label') : null
      if (wrap) {
        const txt = (wrap.innerText || wrap.textContent || '').replace(/\s+/g, ' ').trim()
        if (txt && txt.length <= 60) return txt
      }
      if (el.id && root.querySelector) {
        const lbl = root.querySelector('label[for="' + cssEsc(el.id) + '"]')
        if (lbl) {
          const txt = (lbl.innerText || lbl.textContent || '').replace(/\s+/g, ' ').trim()
          if (txt && txt.length <= 60) return txt
        }
      }
    } catch {
      // ignore invalid selector edge cases
    }
    return ''
  }

  function disambiguateCss(el: DomLikeElement, css: string, root: DomLikeRoot): string {
    try {
      if (!root.querySelectorAll) return css
      const matches = Array.from(root.querySelectorAll(css))
      if (matches.length <= 1) return css
      const idx = matches.indexOf(el)
      return idx >= 0 ? css + ' >> nth=' + idx : css
    } catch {
      return css
    }
  }

  function localSelector(el: DomLikeElement, root: DomLikeRoot): string {
    if (!isElem(el)) return ''
    const tag = el.tagName.toLowerCase()
    const prefixTag = tag === 'iframe' ? 'iframe' : ''

    // 1. Dedicated test ID attributes
    for (const attr of ['data-testid', 'data-test-id', 'data-test']) {
      const val = el.getAttribute(attr)
      if (!val) continue
      if (tag === 'iframe') {
        return disambiguateCss(el, 'iframe[' + attr + '="' + val.replace(/"/g, '\\"') + '"]', root)
      }
      try {
        const allTestIds = root.querySelectorAll
          ? Array.from(root.querySelectorAll('[data-testid], [data-test-id], [data-test]')).filter((n) => {
              const nv =
                n.getAttribute('data-testid') || n.getAttribute('data-test-id') || n.getAttribute('data-test') || ''
              return nv === val
            })
          : [el]
        if (allTestIds.length <= 1) return 'testid=' + val
        const idx = allTestIds.indexOf(el)
        return idx >= 0 ? 'testid=' + val + ' >> nth=' + idx : 'testid=' + val
      } catch {
        return 'testid=' + val
      }
    }

    const cyVal = el.getAttribute('data-cy')
    if (cyVal) {
      return disambiguateCss(el, prefixTag + '[data-cy="' + cyVal.replace(/"/g, '\\"') + '"]', root)
    }

    // 2. Stable human-authored #id (filtering React/Radix/MUI/UUID auto-generated IDs)
    if (el.id && !isDynamicId(el.id)) {
      return disambiguateCss(el, prefixTag + '#' + cssEsc(el.id), root)
    }

    // 3. Form control attributes (name, placeholder, aria-label, associated <label>)
    const nameAttr = el.getAttribute('name')
    if (nameAttr) {
      return disambiguateCss(el, tag + '[name="' + nameAttr.replace(/"/g, '\\"') + '"]', root)
    }

    const ph = (el.getAttribute('placeholder') || '').trim()
    if (ph && ph.length <= 60) {
      let count = 1
      try {
        count = root.querySelectorAll ? root.querySelectorAll('[placeholder="' + cssEsc(ph) + '"]').length : 1
      } catch {
        count = 1
      }
      return count <= 1
        ? 'placeholder=' + ph
        : disambiguateCss(el, tag + '[placeholder="' + ph.replace(/"/g, '\\"') + '"]', root)
    }

    const aria = (el.getAttribute('aria-label') || '').trim()
    if (aria && aria.length <= 60) {
      return disambiguateCss(el, tag + '[aria-label="' + aria.replace(/"/g, '\\"') + '"]', root)
    }

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const lblText = findAssociatedLabelText(el, root)
      if (lblText) return 'label=' + lblText
    }

    // 4. Semantic role + accessible name
    const explicitRole = el.getAttribute('role')
    const role =
      explicitRole ||
      (tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag === 'textarea' ? 'textbox' : tag === 'select' ? 'combobox' : '')
    const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    if (role && text && text.length <= 60) {
      const base = 'role=' + role + '[name="' + text.replace(/"/g, '\\"') + '"]'
      try {
        const candidates = root.querySelectorAll
          ? Array.from(root.querySelectorAll(explicitRole ? '[role="' + cssEsc(explicitRole) + '"]' : tag)).filter(
              (n) => (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim() === text,
            )
          : [el]
        if (candidates.length <= 1) return base
        const rIdx = candidates.indexOf(el)
        return rIdx >= 0 ? base + ' >> nth=' + rIdx : base
      } catch {
        return base
      }
    }

    // 5. Fallback clean CSS class path + nth disambiguation
    const cleanClasses = Array.from(el.classList || [])
      .filter(
        (c) =>
          Boolean(c) &&
          c.length < 32 &&
          !/^\d/.test(c) &&
          !/^(hover|focus|active|open|selected|checked|disabled)$/i.test(c) &&
          !c.includes(':'),
      )
      .slice(0, 2)
      .map((c) => '.' + cssEsc(c))
      .join('')
    return disambiguateCss(el, tag + cleanClasses, root)
  }

  const candidate = targetEl !== undefined ? targetEl : this
  if (!isElem(candidate)) return ''

  const fallbackDoc = (globalThis as { document?: DomLikeRoot }).document || {}
  const chain: string[] = []
  let cur: DomLikeElement | null = candidate

  while (cur) {
    const root: DomLikeRoot = cur.getRootNode ? cur.getRootNode() : fallbackDoc
    if (root && isElem(root.host)) {
      chain.unshift(localSelector(cur, root))
      cur = root.host
      continue
    }
    const doc: DomLikeRoot = cur.ownerDocument || fallbackDoc
    chain.unshift(localSelector(cur, doc))
    const win: DomLikeWindow | null | undefined = doc.defaultView
    if (win && win.parent && win !== win.parent) {
      try {
        if (isElem(win.frameElement)) {
          cur = win.frameElement
          continue
        }
      } catch {
        // Cross-origin parent boundary
      }
    }
    break
  }

  return chain.filter(Boolean).join(' >> ')
}
