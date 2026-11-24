import type { ElementInspectResult } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import { computeDiffIfShorter, filterSnapshotLines, type SnapshotEngine } from './snapshot.js'

const DEFAULT_INSPECT_PROPERTIES = [
  'overflow-y',
  'overflow-x',
  'position',
  'max-height',
  'display',
  'flex-direction',
  'flex-shrink',
]

export interface CleanHTMLOptions {
  selector?: string
  search?: string | RegExp
  showDiffSinceLastCall?: boolean
  includeStyles?: boolean
  maxLength?: number
}

export interface PageMarkdownOptions {
  search?: string | RegExp
  showDiffSinceLastCall?: boolean
  maxLength?: number
}

export class DOMExtractor {
  private lastCleanHtml = new Map<number, string>()
  private lastMarkdown = new Map<number, string>()

  async getCleanHTML(session: TabCDPSession, options: CleanHTMLOptions = {}): Promise<string> {
    const selector = options.selector ?? 'body'
    const includeStyles = options.includeStyles ?? false
    const maxLen = options.maxLength ?? 40_000

    const res = await session.send<{ result?: { value?: { url: string; html: string } } }>('Runtime.evaluate', {
      expression: `(() => {
        const root = document.querySelector(${JSON.stringify(selector)});
        if (!root) return { url: location.href, html: '' };
        const KEEP_ATTRS = new Set(['id', 'name', 'href', 'src', 'type', 'role', 'placeholder', 'value', 'alt', 'title', 'for', 'checked', 'disabled', 'selected', 'aria-label', 'aria-expanded', 'aria-selected', 'aria-hidden', 'aria-controls', 'aria-current']);
        const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
        const INCLUDE_STYLES = ${includeStyles};
        function serialize(node, depth) {
          if (depth > 35) return '';
          if (node.nodeType === 3) {
            const t = (node.textContent || '').replace(/\\s+/g, ' ').trim();
            return t ? t.slice(0, 300) : '';
          }
          if (node.nodeType !== 1) return '';
          const tag = node.tagName;
          if (SKIP_TAGS.has(tag)) return '';
          if (tag === 'SVG') return '<svg/>';
          const attrs = [];
          for (const attr of Array.from(node.attributes || [])) {
            const n = attr.name.toLowerCase();
            const keep = KEEP_ATTRS.has(n) || n.startsWith('data-') || n.startsWith('aria-') || (INCLUDE_STYLES && (n === 'class' || n === 'style'));
            if (!keep) continue;
            const v = (attr.value || '').replace(/\\s+/g, ' ').trim();
            attrs.push(v ? n + '="' + v.slice(0, 120) + '"' : n);
          }
          const children = [];
          for (const child of Array.from(node.childNodes || [])) {
            const s = serialize(child, depth + 1);
            if (s) children.push(s);
          }
          const tagLower = tag.toLowerCase();
          if ((tagLower === 'div' || tagLower === 'span') && attrs.length === 0) {
            if (children.length === 0) return '';
            if (children.length === 1) return children[0];
          }
          if (children.length === 0 && attrs.length === 0 && !['input','img','br','hr','textarea'].includes(tagLower)) {
            return '';
          }
          const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
          if (children.length === 0) return '<' + tagLower + attrStr + '/>';
          const pad = '  '.repeat(depth);
          const inner = children.join('\\n' + pad + '  ');
          if (children.length === 1 && !inner.includes('\\n') && inner.length < 100) {
            return '<' + tagLower + attrStr + '>' + inner + '</' + tagLower + '>';
          }
          return '<' + tagLower + attrStr + '>\\n' + pad + '  ' + inner + '\\n' + pad + '</' + tagLower + '>';
        }
        return { url: location.href, html: serialize(root, 0).slice(0, ${maxLen}) };
      })()`,
      returnByValue: true,
    })

    const url = res.result?.value?.url ?? ''
    const html = res.result?.value?.html ?? ''
    const header = `URL: ${url}`
    const full = `${header}\n\n${html || '(empty)'}`

    const prev = this.lastCleanHtml.get(session.tabId)
    if (!options.selector) this.lastCleanHtml.set(session.tabId, full)

    if (options.search !== undefined) {
      const wantDiff = options.showDiffSinceLastCall === true && prev !== undefined
      const base = wantDiff ? computeDiffIfShorter(prev, full, header).text : full
      return filterSnapshotLines(base, options.search)
    }

    const wantDiff = options.showDiffSinceLastCall ?? !options.selector
    if (wantDiff && prev !== undefined) {
      return computeDiffIfShorter(prev, full, header).text
    }
    return full
  }

  async getPageMarkdown(session: TabCDPSession, options: PageMarkdownOptions = {}): Promise<string> {
    const maxLen = options.maxLength ?? 40_000
    const res = await session.send<{ result?: { value?: { url: string; markdown: string } } }>('Runtime.evaluate', {
      expression: `(() => {
        const title = document.title || '';
        const meta = (name) => document.querySelector('meta[name="' + name + '"], meta[property="' + name + '"]')?.getAttribute('content') || '';
        const author = meta('author') || meta('article:author');
        const desc = meta('description') || meta('og:description');

        // Pick best main content container
        const candidates = [
          document.querySelector('article'),
          document.querySelector('main'),
          document.querySelector('[role="main"]'),
          document.body,
        ].filter(Boolean);
        let root = candidates[0] || document.body;
        if (root !== document.body && (root.innerText || '').trim().length < 150) {
          root = document.body;
        }

        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'ASIDE', 'SVG', 'IFRAME', 'BUTTON']);
        function toMd(node) {
          if (!node) return '';
          if (node.nodeType === 3) {
            return (node.textContent || '').replace(/\\s+/g, ' ');
          }
          if (node.nodeType !== 1) return '';
          const tag = node.tagName;
          if (SKIP.has(tag)) return '';
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') return '';

          const inner = () => Array.from(node.childNodes).map(toMd).join('').trim();
          switch (tag) {
            case 'H1': return '\\n# ' + inner() + '\\n\\n';
            case 'H2': return '\\n## ' + inner() + '\\n\\n';
            case 'H3': return '\\n### ' + inner() + '\\n\\n';
            case 'H4': return '\\n#### ' + inner() + '\\n\\n';
            case 'P': { const t = inner(); return t ? t + '\\n\\n' : ''; }
            case 'BR': return '\\n';
            case 'LI': { const t = inner(); return t ? '- ' + t + '\\n' : ''; }
            case 'UL':
            case 'OL': return '\\n' + inner() + '\\n';
            case 'PRE': return '\\n\`\`\`\\n' + (node.textContent || '').trim() + '\\n\`\`\`\\n\\n';
            case 'CODE': return '\`' + (node.textContent || '').trim() + '\`';
            case 'BLOCKQUOTE': return '\\n> ' + inner().replace(/\\n/g, '\\n> ') + '\\n\\n';
            case 'A': {
              const t = inner();
              const href = node.getAttribute('href') || '';
              if (!t) return '';
              return href && !href.startsWith('javascript:') ? '[' + t + '](' + href + ')' : t;
            }
            case 'STRONG':
            case 'B': { const t = inner(); return t ? '**' + t + '**' : ''; }
            case 'EM':
            case 'I': { const t = inner(); return t ? '*' + t + '*' : ''; }
            case 'TR': {
              const cells = Array.from(node.children).map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim());
              return '| ' + cells.join(' | ') + ' |\\n';
            }
            default:
              return Array.from(node.childNodes).map(toMd).join('');
          }
        }

        const headerLines = [];
        if (title) headerLines.push('# ' + title);
        const metaParts = [];
        if (author) metaParts.push('Author: ' + author);
        if (metaParts.length) headerLines.push(metaParts.join(' | '));
        if (desc) headerLines.push('> ' + desc.trim());

        const bodyMd = toMd(root).replace(/\\n{3,}/g, '\\n\\n').trim();
        const combined = (headerLines.length ? headerLines.join('\\n\\n') + '\\n\\n' : '') + bodyMd;
        return { url: location.href, markdown: combined.slice(0, ${maxLen}) };
      })()`,
      returnByValue: true,
    })

    const url = res.result?.value?.url ?? ''
    const md = res.result?.value?.markdown ?? ''
    const header = `URL: ${url}`
    const full = `${header}\n\n${md || '(empty)'}`

    const prev = this.lastMarkdown.get(session.tabId)
    this.lastMarkdown.set(session.tabId, full)

    if (options.search !== undefined) {
      const wantDiff = options.showDiffSinceLastCall === true && prev !== undefined
      const base = wantDiff ? computeDiffIfShorter(prev, full, header).text : full
      return filterSnapshotLines(base, options.search)
    }

    const wantDiff = options.showDiffSinceLastCall ?? true
    if (wantDiff && prev !== undefined) {
      return computeDiffIfShorter(prev, full, header).text
    }
    return full
  }

  async inspectElement(
    session: TabCDPSession,
    snapshotEngine: SnapshotEngine,
    target: string,
    properties: string[] = DEFAULT_INSPECT_PROPERTIES,
  ): Promise<ElementInspectResult> {
    const refTarget = snapshotEngine.getRef(session.tabId, target)
    let objectId: string | undefined
    let sessionId: string | undefined

    if (refTarget) {
      sessionId = refTarget.sessionId
      const resolved = await session.send<{ object?: { objectId?: string } }>(
        'DOM.resolveNode',
        { backendNodeId: refTarget.backendDOMNodeId },
        { sessionId },
      )
      objectId = resolved.object?.objectId
    } else {
      const evalRes = await session.send<{ result?: { objectId?: string } }>('Runtime.evaluate', {
        expression: `document.querySelector(${JSON.stringify(target)})`,
        returnByValue: false,
      })
      objectId = evalRes.result?.objectId
    }

    if (!objectId) {
      throw new Error(`Element not found for inspect: ${target}`)
    }

    const callRes = await session.send<{ result?: { value?: Omit<ElementInspectResult, 'formatted'> } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        arguments: [{ value: properties }],
        returnByValue: true,
        functionDeclaration: `function(props) {
          const el = this;
          const rect = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const styles = {};
          for (const p of props) styles[p] = cs.getPropertyValue(p);

          const visibility = {};
          if (cs.display === 'none') visibility.display = 'none';
          if (cs.visibility !== 'visible') visibility.visibility = cs.visibility;
          if (cs.opacity !== '1') visibility.opacity = cs.opacity;
          if (cs.pointerEvents === 'none') visibility['pointer-events'] = 'none';

          const aria = {};
          for (const attr of Array.from(el.attributes || [])) {
            if (attr.name.startsWith('aria-') || attr.name === 'role') {
              aria[attr.name] = attr.value;
            }
          }

          let input;
          const tag = el.tagName.toLowerCase();
          if (tag === 'input' || tag === 'textarea' || tag === 'select') {
            input = {
              value: el.value,
              checked: typeof el.checked === 'boolean' ? el.checked : undefined,
              disabled: el.disabled || undefined,
              readOnly: el.readOnly || undefined,
              placeholder: el.placeholder || undefined,
              type: el.type || undefined,
            };
          }

          return {
            tag,
            id: el.id || undefined,
            classes: Array.from(el.classList || []),
            box: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
            childrenCount: el.children?.length ?? 0,
            textLength: (el.innerText || el.textContent || '').length,
            scroll: {
              scrollHeight: el.scrollHeight,
              clientHeight: el.clientHeight,
              scrollTop: Math.round(el.scrollTop),
              overflowingY: el.scrollHeight > el.clientHeight + 1,
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              scrollLeft: Math.round(el.scrollLeft),
              overflowingX: el.scrollWidth > el.clientWidth + 1,
            },
            styles,
            visibility: Object.keys(visibility).length ? visibility : undefined,
            input,
            aria: Object.keys(aria).length ? aria : undefined,
          };
        }`,
      },
      { sessionId },
    )

    const data = callRes.result?.value
    if (!data) {
      throw new Error(`Failed to inspect element: ${target}`)
    }

    const selectorName = `${data.tag}${data.id ? `#${data.id}` : ''}${data.classes.length ? `.${data.classes.join('.')}` : ''}`
    const lines: string[] = [
      `Element: ${selectorName}`,
      data.box
        ? `Box: x=${data.box.x} y=${data.box.y} w=${data.box.width} h=${data.box.height}`
        : 'Box: none',
      `Children: ${data.childrenCount}  Text length: ${data.textLength}`,
      `Scroll Y: size=${data.scroll.scrollHeight} client=${data.scroll.clientHeight} overflowing=${data.scroll.overflowingY} top=${data.scroll.scrollTop}`,
      `Scroll X: size=${data.scroll.scrollWidth} client=${data.scroll.clientWidth} overflowing=${data.scroll.overflowingX} left=${data.scroll.scrollLeft}`,
      `Styles: ${Object.entries(data.styles)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`,
    ]
    if (data.visibility) {
      lines.push(
        `Visibility: ${Object.entries(data.visibility)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
      )
    }
    if (data.input) {
      const parts: string[] = []
      if (data.input.type) parts.push(`type=${data.input.type}`)
      if (data.input.value !== undefined) parts.push(`value=${JSON.stringify(data.input.value)}`)
      if (data.input.checked !== undefined) parts.push(`checked=${data.input.checked}`)
      if (data.input.disabled) parts.push('disabled')
      if (data.input.readOnly) parts.push('readOnly')
      lines.push(`Input: ${parts.join(' ')}`)
    }
    if (data.aria) {
      lines.push(
        `Aria: ${Object.entries(data.aria)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
      )
    }

    return { ...data, formatted: lines.join('\n') }
  }

  clearTab(tabId: number): void {
    this.lastCleanHtml.delete(tabId)
    this.lastMarkdown.delete(tabId)
  }
}
