import type { BoundingBox } from '@browserpilot/protocol'
import { STABLE_LOCATOR_FUNCTION } from '../locator.js'
import { getIframeOffset, type ActionabilityDeps } from './actionability.js'

export interface FindElementMatch {
  ref: string
  role: string
  tag: string
  name: string
  text: string
  placeholder?: string
  score: number
  inViewport: boolean
  box: BoundingBox
  recommendedLocator: string
  frameUrl?: string
}

export interface FindElementsOptions {
  /** Maximum number of ranked matches to return (default 8, max 25) */
  limit?: number
  /** Restrict search to elements currently intersecting the visible viewport (default false) */
  viewportOnly?: boolean
  /** Include cross-origin OOPIF child frames (default true) */
  includeIframes?: boolean
}

interface RawCandidate {
  role: string
  tag: string
  name: string
  text: string
  placeholder: string
  score: number
  inViewport: boolean
  box: BoundingBox
  offsetX: number
  offsetY: number
  recommendedLocator: string
}

// Bilingual (EN + ZH) semantic intent synonyms for natural-language UI queries
const SYNONYM_GROUPS: string[][] = [
  ['search', 'find', 'query', 'lookup', 'filter', '搜索', '查找', '查询', '检索', '筛选'],
  ['input', 'box', 'field', 'bar', 'textbox', 'searchbox', '输入框', '文本框', '搜索框', '栏'],
  ['button', 'btn', 'cta', 'click', 'action', '按钮', '按键', '点击'],
  ['link', 'anchor', 'href', '链接', '跳转'],
  ['login', 'signin', 'log', 'auth', '登录', '登入', '登陆'],
  ['logout', 'signout', 'exit', '退出', '登出', '注销'],
  ['signup', 'register', 'join', 'create', '注册', '新建', '创建'],
  ['submit', 'send', 'confirm', 'apply', 'ok', 'save', 'done', '提交', '发送', '确认', '确定', '保存', '应用', '完成'],
  ['cancel', 'abort', 'back', '取消', '返回'],
  ['close', 'dismiss', 'hide', '关闭', '关掉', '收起'],
  ['delete', 'remove', 'trash', 'clear', '删除', '移除', '清空', '清除'],
  ['edit', 'modify', 'update', 'change', '编辑', '修改', '更新'],
  ['add', 'new', 'plus', 'create', '添加', '新增', '新建'],
  ['cart', 'bag', 'basket', '购物车', '购物袋'],
  ['checkout', 'pay', 'buy', 'purchase', 'order', '结算', '结账', '支付', '购买', '下单'],
  ['email', 'mail', '邮箱', '邮件', '电子邮箱'],
  ['password', 'passwd', 'pwd', 'passcode', '密码', '口令'],
  ['username', 'account', 'user', '用户名', '账号', '账户'],
  ['phone', 'mobile', 'tel', '手机', '手机号', '电话'],
  ['settings', 'preferences', 'config', 'options', 'gear', '设置', '偏好', '配置', '选项'],
  ['menu', 'nav', 'navigation', 'hamburger', 'drawer', '菜单', '导航'],
  ['profile', 'avatar', 'me', '个人', '个人资料', '头像', '我的'],
  ['next', 'continue', 'forward', '下一步', '继续', '下一页'],
  ['prev', 'previous', 'back', '上一步', '上一页'],
  ['upload', 'attach', 'file', '上传', '附件', '文件'],
  ['download', 'export', '下载', '导出'],
  ['checkbox', 'check', 'toggle', 'switch', '复选框', '勾选', '开关'],
  ['select', 'dropdown', 'combobox', 'picker', '下拉', '选择框', '选择器'],
  ['tab', '选项卡', '标签页'],
  ['dialog', 'modal', 'popup', '弹窗', '对话框'],
  ['price', 'cost', 'amount', 'total', '价格', '金额', '总计'],
]

const ROLE_INTENT_HINTS: Array<{ tokens: string[]; roles: string[]; tags: string[] }> = [
  { tokens: ['button', 'btn', '按钮', '按键', 'submit', '提交', '发送', '确认', '登录', 'login', 'save', '保存'], roles: ['button'], tags: ['button'] },
  { tokens: ['input', 'box', 'field', 'bar', 'textbox', 'searchbox', '输入框', '文本框', '搜索框', '邮箱', 'email', 'password', '密码'], roles: ['textbox', 'searchbox', 'combobox'], tags: ['input', 'textarea'] },
  { tokens: ['link', '链接', '跳转'], roles: ['link'], tags: ['a'] },
  { tokens: ['checkbox', 'toggle', 'switch', '复选框', '勾选', '开关'], roles: ['checkbox', 'switch'], tags: ['input'] },
  { tokens: ['radio', '单选'], roles: ['radio'], tags: ['input'] },
  { tokens: ['select', 'dropdown', 'combobox', '下拉', '选择框', '选择器'], roles: ['combobox', 'listbox'], tags: ['select'] },
  { tokens: ['tab', '选项卡', '标签页'], roles: ['tab'], tags: [] },
  { tokens: ['heading', 'title', '标题'], roles: ['heading'], tags: ['h1', 'h2', 'h3', 'h4'] },
]

export function expandQueryTokens(query: string): {
  normalized: string
  tokens: string[]
  expandedTokens: string[]
  preferredRoles: string[]
  preferredTags: string[]
} {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ')
  // Split ASCII words + CJK runs (keep 2-char CJK phrases and full CJK segments)
  const rawParts = normalized.match(/[a-z0-9_-]+|[\u4e00-\u9fff]+/g) ?? []
  const tokens: string[] = []
  for (const part of rawParts) {
    tokens.push(part)
    if (/^[\u4e00-\u9fff]{3,}$/.test(part)) {
      // Also split compound Chinese queries like "搜索框" -> "搜索", "框", "登录按钮" -> "登录", "按钮"
      for (const group of SYNONYM_GROUPS) {
        for (const word of group) {
          if (/^[\u4e00-\u9fff]{2,}$/.test(word) && part.includes(word) && word !== part) {
            tokens.push(word)
          }
        }
      }
    }
  }
  const uniqueTokens = Array.from(new Set(tokens))
  const expanded = new Set<string>(uniqueTokens)

  for (const tok of uniqueTokens) {
    for (const group of SYNONYM_GROUPS) {
      if (group.includes(tok)) {
        for (const syn of group) expanded.add(syn)
      }
    }
  }

  const preferredRoles = new Set<string>()
  const preferredTags = new Set<string>()
  for (const hint of ROLE_INTENT_HINTS) {
    if (hint.tokens.some((t) => expanded.has(t))) {
      for (const r of hint.roles) preferredRoles.add(r)
      for (const tag of hint.tags) preferredTags.add(tag)
    }
  }

  return {
    normalized,
    tokens: uniqueTokens,
    expandedTokens: Array.from(expanded),
    preferredRoles: Array.from(preferredRoles),
    preferredTags: Array.from(preferredTags),
  }
}

function buildInPageFindScript(
  queryInfo: ReturnType<typeof expandQueryTokens>,
  limit: number,
  viewportOnly: boolean,
): string {
  return `(() => {
    const qNorm = ${JSON.stringify(queryInfo.normalized)};
    const tokens = ${JSON.stringify(queryInfo.tokens)};
    const expanded = ${JSON.stringify(queryInfo.expandedTokens)};
    const prefRoles = new Set(${JSON.stringify(queryInfo.preferredRoles)});
    const prefTags = new Set(${JSON.stringify(queryInfo.preferredTags)});
    const viewportOnly = ${JSON.stringify(viewportOnly)};
    const limit = ${limit};
    const stableLocatorFn = ${STABLE_LOCATOR_FUNCTION};

    const INTERACTIVE_SEL = [
      'a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary',
      '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="searchbox"]',
      '[role="combobox"]', '[role="listbox"]', '[role="option"]', '[role="checkbox"]',
      '[role="radio"]', '[role="switch"]', '[role="tab"]', '[role="menuitem"]',
      '[role="slider"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
      'h1', 'h2', 'h3', 'img[alt]', 'label'
    ].join(',');

    function getAccessibleRole(el) {
      const explicit = (el.getAttribute && el.getAttribute('role') || '').trim().toLowerCase();
      if (explicit) return explicit;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'a' && el.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'summary') return 'button';
      if (tag === 'img') return 'img';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase();
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'search') return 'searchbox';
        if (t === 'range') return 'slider';
        return 'textbox';
      }
      if (el.isContentEditable) return 'textbox';
      return tag;
    }

    function getLabelText(el, doc) {
      const parts = [];
      const ariaLabel = el.getAttribute?.('aria-label');
      if (ariaLabel) parts.push(ariaLabel);
      const labelledBy = el.getAttribute?.('aria-labelledby');
      if (labelledBy) {
        for (const id of labelledBy.split(/\\s+/)) {
          const refEl = doc.getElementById(id);
          if (refEl?.textContent) parts.push(refEl.textContent);
        }
      }
      if (el.id) {
        try {
          const lbl = doc.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lbl?.textContent) parts.push(lbl.textContent);
        } catch {}
      }
      const wrapLabel = el.closest?.('label');
      if (wrapLabel && wrapLabel !== el && wrapLabel.textContent) parts.push(wrapLabel.textContent);
      const placeholder = el.getAttribute?.('placeholder');
      if (placeholder) parts.push(placeholder);
      const title = el.getAttribute?.('title');
      if (title) parts.push(title);
      const alt = el.getAttribute?.('alt');
      if (alt) parts.push(alt);
      return parts.join(' ').replace(/\\s+/g, ' ').trim();
    }

    function getContextText(el) {
      const section = el.closest?.('form, section, dialog, [role="dialog"], [role="region"], article, nav, header, footer, fieldset, tr');
      if (!section) return '';
      const heading = section.querySelector?.('h1, h2, h3, h4, legend, [role="heading"]');
      const aria = section.getAttribute?.('aria-label') || '';
      return ((heading?.textContent || '') + ' ' + aria).replace(/\\s+/g, ' ').trim().slice(0, 120);
    }

    function getFrameOffset(doc) {
      let ox = 0, oy = 0;
      let win = doc.defaultView;
      while (win && win !== win.parent) {
        try {
          const fe = win.frameElement;
          if (!fe) break;
          const fr = fe.getBoundingClientRect();
          ox += fr.left;
          oy += fr.top;
          win = win.parent;
        } catch { break; }
      }
      return { ox, oy };
    }

    const candidates = [];
    const seen = new Set();

    function collect(root, doc) {
      const win = doc.defaultView || window;
      const vw = win.innerWidth || doc.documentElement.clientWidth || 1280;
      const vh = win.innerHeight || doc.documentElement.clientHeight || 720;
      const { ox, oy } = getFrameOffset(doc);

      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll(INTERACTIVE_SEL)); } catch {}
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        const tag = (el.tagName || '').toLowerCase();
        const st = win.getComputedStyle(el);
        if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
        let rect = el.getBoundingClientRect();
        if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio') && (rect.width <= 2 || rect.height <= 2)) {
          const lbl = el.closest?.('label') || (el.id ? doc.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
          if (lbl) rect = lbl.getBoundingClientRect();
        }
        if (!rect || rect.width < 2 || rect.height < 2) continue;

        const inViewport = rect.bottom >= -40 && rect.top <= vh + 40 && rect.right >= -40 && rect.left <= vw + 40;
        if (viewportOnly && !inViewport) continue;

        const role = getAccessibleRole(el);
        const label = getLabelText(el, doc);
        const rawText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180);
        const placeholder = (el.getAttribute?.('placeholder') || '').trim();
        const attrs = [
          el.id || '',
          el.getAttribute?.('name') || '',
          el.getAttribute?.('data-testid') || '',
          el.getAttribute?.('type') || '',
          typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        ].join(' ').toLowerCase();
        const ctxText = getContextText(el).toLowerCase();

        const primaryName = (label || rawText || placeholder || '').trim().slice(0, 140);
        const primaryLower = primaryName.toLowerCase();
        const textLower = rawText.toLowerCase();
        const fullHaystack = (primaryLower + ' ' + textLower + ' ' + attrs + ' ' + role + ' ' + tag).trim();

        let score = 0;

        // 1. Exact & phrase matches
        if (qNorm && primaryLower === qNorm) score += 120;
        else if (qNorm && primaryLower.includes(qNorm)) score += 85;
        else if (qNorm && textLower.includes(qNorm)) score += 70;
        else if (qNorm && attrs.includes(qNorm)) score += 50;

        // 2. Direct token coverage
        let directHits = 0;
        for (const tok of tokens) {
          if (primaryLower.includes(tok)) {
            score += 36;
            directHits++;
          } else if (textLower.includes(tok)) {
            score += 28;
            directHits++;
          } else if (attrs.includes(tok)) {
            score += 18;
            directHits++;
          } else if (ctxText.includes(tok)) {
            score += 12;
            directHits++;
          }
        }
        if (tokens.length > 1 && directHits === tokens.length) {
          score += 35;
        }

        // 3. Bilingual synonym token matches
        let synHits = 0;
        for (const syn of expanded) {
          if (tokens.includes(syn)) continue;
          if (primaryLower.includes(syn) || textLower.includes(syn)) {
            score += 20;
            synHits++;
            if (synHits >= 3) break;
          } else if (attrs.includes(syn)) {
            score += 12;
            synHits++;
            if (synHits >= 3) break;
          }
        }

        // Special icon-only close button recognition (× / ✕ / X)
        if (expanded.includes('close') && /^[×✕✖x]$/.test(primaryLower)) {
          score += 48;
        }

        if (score <= 0) continue;

        // 4. Role / tag intent alignment boost
        if (prefRoles.has(role)) score += 26;
        if (prefTags.has(tag)) score += 16;

        // 5. Interactive preference & viewport presence boost
        const isInteractive = ['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'option', 'slider'].includes(role);
        if (isInteractive) score += 14;
        if (inViewport) score += 10;
        // Prefer concise exact controls over huge parent containers with long text
        if (rawText.length > 120) score -= 12;

        let loc = '';
        try { loc = stableLocatorFn.call(el); } catch { loc = tag; }

        candidates.push({
          el,
          meta: {
            role,
            tag,
            name: primaryName,
            text: rawText.slice(0, 120),
            placeholder,
            score,
            inViewport,
            box: {
              x: Math.round(rect.left + ox),
              y: Math.round(rect.top + oy),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            offsetX: ox,
            offsetY: oy,
            recommendedLocator: loc,
          },
        });
      }

      // Traverse open Shadow DOM & same-origin iframes
      let all = [];
      try { all = Array.from(root.querySelectorAll('*')); } catch {}
      for (const el of all) {
        if (el.shadowRoot) collect(el.shadowRoot, doc);
        if (el.tagName === 'IFRAME') {
          try {
            if (el.contentDocument) collect(el.contentDocument, el.contentDocument);
          } catch {}
        }
      }
    }

    collect(document, document);
    candidates.sort((a, b) => b.meta.score - a.meta.score);
    const top = candidates.slice(0, limit);
    const maxRaw = top.length > 0 ? Math.max(top[0].meta.score, 100) : 100;
    const elements = top.map((c) => c.el);
    const metas = top.map((c) => ({
      ...c.meta,
      score: Number(Math.min(1, c.meta.score / maxRaw).toFixed(2)),
    }));
    return { elements, metas };
  })()`
}

async function runFindInTarget(
  deps: ActionabilityDeps,
  queryInfo: ReturnType<typeof expandQueryTokens>,
  limit: number,
  viewportOnly: boolean,
  childSession?: { sessionId: string; url: string; targetId: string },
): Promise<Array<FindElementMatch & { _rawScore: number }>> {
  const sessionId = childSession?.sessionId
  const evalRes = await deps.session
    .send<{ result?: { objectId?: string } }>(
      'Runtime.evaluate',
      {
        expression: buildInPageFindScript(queryInfo, limit, viewportOnly),
        returnByValue: false,
      },
      { sessionId },
    )
    .catch(() => null)

  const rootObjId = evalRes?.result?.objectId
  if (!rootObjId) return []

  try {
    const props = await deps.session.send<{
      result?: Array<{ name: string; value?: { objectId?: string } }>
    }>('Runtime.getProperties', { objectId: rootObjId, ownProperties: true }, { sessionId })

    const elementsObjId = props.result?.find((p) => p.name === 'elements')?.value?.objectId
    const metasObjId = props.result?.find((p) => p.name === 'metas')?.value?.objectId
    if (!elementsObjId || !metasObjId) return []

    const [metasRes, elPropsRes] = await Promise.all([
      deps.session.send<{ result?: { value?: RawCandidate[] } }>(
        'Runtime.callFunctionOn',
        { objectId: metasObjId, functionDeclaration: 'function() { return this; }', returnByValue: true },
        { sessionId },
      ),
      deps.session.send<{ result?: Array<{ name: string; value?: { objectId?: string } }> }>(
        'Runtime.getProperties',
        { objectId: elementsObjId, ownProperties: true },
        { sessionId },
      ),
    ])

    const metas = metasRes.result?.value ?? []
    if (!metas.length) return []

    const frameOffset = childSession
      ? await getIframeOffset(deps, childSession.targetId, childSession.sessionId).catch(() => ({ x: 0, y: 0 }))
      : { x: 0, y: 0 }

    const elByIndex = new Map<number, string>()
    for (const p of elPropsRes.result ?? []) {
      const idx = Number(p.name)
      if (Number.isInteger(idx) && p.value?.objectId) {
        elByIndex.set(idx, p.value.objectId)
      }
    }

    const out: Array<FindElementMatch & { _rawScore: number }> = []
    await Promise.all(
      metas.map(async (m, idx) => {
        const objId = elByIndex.get(idx)
        if (!objId) return
        const desc = await deps.session
          .send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId: objId }, { sessionId })
          .catch(() => null)
        const backendNodeId = desc?.node?.backendNodeId
        if (!backendNodeId) return

        const ref = deps.snapshotEngine.registerRef(deps.session.tabId, {
          backendDOMNodeId: backendNodeId,
          frameId: childSession?.targetId,
          sessionId,
          role: m.role,
          name: m.name,
          tag: m.tag,
        })

        out.push({
          ref,
          role: m.role,
          tag: m.tag,
          name: m.name,
          text: m.text,
          ...(m.placeholder ? { placeholder: m.placeholder } : {}),
          score: m.score,
          inViewport: m.inViewport,
          box: {
            x: Math.round(m.box.x + frameOffset.x),
            y: Math.round(m.box.y + frameOffset.y),
            width: m.box.width,
            height: m.box.height,
          },
          recommendedLocator: m.recommendedLocator,
          ...(childSession?.url ? { frameUrl: childSession.url } : {}),
          _rawScore: m.score,
        })
      }),
    )

    return out
  } finally {
    void deps.session.send('Runtime.releaseObject', { objectId: rootObjId }, { sessionId }).catch(() => {})
  }
}

/**
 * Natural-language fuzzy element finder (bilingual EN/ZH) across main DOM, open Shadow DOM,
 * same-origin iframes, and cross-origin OOPIF frames. Every match is registered as a live `[eN]` ref
 * so subsequent click/fill/hover tools can target it immediately without a full-page snapshot.
 */
export async function findElementsByQuery(
  deps: ActionabilityDeps,
  query: string,
  options: FindElementsOptions = {},
): Promise<FindElementMatch[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  await deps.session.ensureBaseDomains()
  const limit = Math.max(1, Math.min(25, options.limit ?? 8))
  const viewportOnly = options.viewportOnly === true
  const queryInfo = expandQueryTokens(trimmed)

  const childSessions = options.includeIframes !== false ? deps.session.getChildSessions() : []
  const allGroups = await Promise.all([
    runFindInTarget(deps, queryInfo, limit, viewportOnly),
    ...childSessions.map((c) => runFindInTarget(deps, queryInfo, Math.min(limit, 5), viewportOnly, c)),
  ])

  const merged = allGroups.flat()
  merged.sort((a, b) => b._rawScore - a._rawScore || Number(b.inViewport) - Number(a.inViewport))

  return merged.slice(0, limit).map(({ _rawScore: _ignored, ...match }) => match)
}
