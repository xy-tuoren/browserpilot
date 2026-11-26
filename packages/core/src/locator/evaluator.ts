import { computeStableDomSelector } from '@browserpilot/protocol'
import type { TabCDPSession } from '../cdp-client.js'
import { splitLocatorChain } from './parser.js'

export type LocatorVisibilityMode = 'prefer-visible' | 'visible-only' | 'any'

export interface LocatorQueryResult {
  objectId?: string
  sessionId?: string
  frameId?: string
  frameOffset: { x: number; y: number }
  count: number
}

interface CrossOriginHandoff {
  __bpCrossOrigin: true
  src: string
  id: string
  name: string
  offsetX: number
  offsetY: number
  remainingStages: string[]
}

/**
 * Builds the in-browser evaluator expression that resolves a multi-stage locator chain.
 * Supports Shadow DOM piercing, same-origin iframe piercing, visibility filtering,
 * `role=`, `text=`, `label=`, `placeholder=`, `alt=`, `title=`, `testid=`, `xpath=`,
 * `has-text=`, `has=`, `visible=true|false`, `first`, `last`, `nth=N`, `pinned`, and CSS.
 *
 * When a stage hits a cross-origin iframe, returns a descriptor so the caller can
 * continue resolution seamlessly inside the matching OOPIF child CDP session.
 */
function buildInPageChainEvaluator(
  stages: string[],
  visibilityMode: LocatorVisibilityMode,
  mode: 'first' | 'count',
): string {
  return `(() => {
    const STAGES = ${JSON.stringify(stages)};
    const VIS_MODE = ${JSON.stringify(visibilityMode)};
    const RETURN_MODE = ${JSON.stringify(mode)};

    function stripQuotes(s) {
      const t = s.trim();
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1);
      }
      return t;
    }

    function parseMatcher(raw) {
      const t = raw.trim();
      const reMatch = t.match(/^\\/(.+)\\/([gimsuy]*)$/);
      if (reMatch) {
        try {
          const re = new RegExp(reMatch[1], reMatch[2]);
          return (text) => re.test(text);
        } catch {}
      }
      const needle = stripQuotes(t).toLowerCase();
      return (text) => text.toLowerCase().includes(needle);
    }

    function isVisible(el) {
      if (!el || el.nodeType !== 1) return false;
      const tag = el.tagName?.toLowerCase();
      if (tag === 'option') return true;
      const win = el.ownerDocument?.defaultView || window;
      const st = win.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
      if (parseFloat(st.opacity) === 0 && tag !== 'input') return false;
      const r = el.getBoundingClientRect();
      return (r.width > 0 || r.height > 0) && el.getClientRects().length > 0;
    }

    function dedupe(list) {
      const out = [];
      const seen = new Set();
      for (const el of list) {
        if (el && el.nodeType === 1 && !seen.has(el)) {
          seen.add(el);
          out.push(el);
        }
      }
      return out;
    }

    function walkRoots(root, visitor) {
      if (!root) return;
      visitor(root);
      if (root.shadowRoot) walkRoots(root.shadowRoot, visitor);
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) walkRoots(el.shadowRoot, visitor);
      }
    }

    function accNameOf(el) {
      const aria = el.getAttribute?.('aria-label');
      if (aria) return aria.replace(/\\s+/g, ' ').trim();
      const labelledBy = el.getAttribute?.('aria-labelledby');
      if (labelledBy && el.ownerDocument) {
        const parts = labelledBy.split(/\\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent || '').filter(Boolean);
        if (parts.length) return parts.join(' ').replace(/\\s+/g, ' ').trim();
      }
      if (el.id && el.ownerDocument) {
        try {
          const lbl = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lbl) return (lbl.innerText || lbl.textContent || '').replace(/\\s+/g, ' ').trim();
        } catch {}
      }
      return (
        el.getAttribute?.('title') ||
        el.getAttribute?.('placeholder') ||
        el.getAttribute?.('alt') ||
        el.innerText ||
        el.value ||
        el.textContent || ''
      ).replace(/\\s+/g, ' ').trim();
    }

    const ROLE_TAGS = {
      button: 'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
      link: 'a[href], [role="link"]',
      textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="search"], input[type="password"], input[type="tel"], input[type="url"], input[type="number"], textarea, [role="textbox"], [contenteditable="true"], [contenteditable=""]',
      searchbox: 'input[type="search"], [role="searchbox"]',
      checkbox: 'input[type="checkbox"], [role="checkbox"]',
      radio: 'input[type="radio"], [role="radio"]',
      switch: '[role="switch"]',
      combobox: 'select, [role="combobox"]',
      listbox: 'select[multiple], [role="listbox"]',
      option: 'option, [role="option"]',
      slider: 'input[type="range"], [role="slider"]',
      heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
      tab: '[role="tab"]',
      menuitem: '[role="menuitem"]',
      dialog: 'dialog, [role="dialog"], [role="alertdialog"]',
      row: 'tr, [role="row"]',
      listitem: 'li, [role="listitem"]',
      img: 'img, [role="img"]',
    };

    function queryStageInRoot(root, stage) {
      if (stage === 'pinned' || stage.startsWith('globalThis.__browserpilotPinned')) {
        let el = null;
        if (stage === 'pinned') {
          const keys = Object.keys(globalThis).filter((k) => k.startsWith('__browserpilotPinned'));
          el = keys.length ? globalThis[keys[keys.length - 1]] : null;
        } else {
          el = globalThis[stage.replace(/^globalThis\\./, '')] || null;
        }
        return el && el.nodeType === 1 ? [el] : [];
      }

      const roleMatch = stage.match(/^role=([a-zA-Z0-9_-]+)(.*)$/i);
      if (roleMatch) {
        const role = roleMatch[1].toLowerCase();
        const rest = roleMatch[2] || '';
        const nameAttr = rest.match(/\\[name=(?:"([^"]*)"|'([^']*)'|([^\\]]+))\\]/i);
        const exactAttr = /\\[exact=(?:true|1)\\]/i.test(rest);
        const nameRaw = nameAttr ? (nameAttr[1] ?? nameAttr[2] ?? nameAttr[3] ?? '').trim() : '';
        const nameLower = nameRaw.toLowerCase();
        const nameReMatch = nameRaw.match(/^\\/(.+)\\/([gimsuy]*)$/);
        const nameRe = nameReMatch ? new RegExp(nameReMatch[1], nameReMatch[2]) : null;
        const css = ROLE_TAGS[role] || ('[role="' + role + '"]');
        const exactHits = [];
        const partialHits = [];
        walkRoots(root, (r) => {
          let found = [];
          try { found = Array.from(r.querySelectorAll(css)); } catch {}
          for (const el of found) {
            const acc = accNameOf(el);
            if (!nameRaw) {
              exactHits.push(el);
            } else if (nameRe) {
              if (nameRe.test(acc)) exactHits.push(el);
            } else if (acc.toLowerCase() === nameLower) {
              exactHits.push(el);
            } else if (!exactAttr && acc.toLowerCase().includes(nameLower)) {
              partialHits.push(el);
            }
          }
        });
        return dedupe(exactHits.length ? exactHits : partialHits);
      }

      if (stage.startsWith('label=')) {
        const matcher = parseMatcher(stage.slice(6));
        const hits = [];
        walkRoots(root, (r) => {
          for (const lbl of r.querySelectorAll('label')) {
            const t = (lbl.innerText || lbl.textContent || '').replace(/\\s+/g, ' ').trim();
            if (matcher(t)) {
              const forId = lbl.getAttribute('for');
              const doc = lbl.ownerDocument || document;
              const ctrl = forId ? (r.getElementById?.(forId) || doc.getElementById(forId)) : lbl.querySelector('input, textarea, select, [role="textbox"], [role="combobox"], [role="checkbox"], [role="switch"]');
              if (ctrl) hits.push(ctrl);
            }
          }
          for (const el of r.querySelectorAll('[aria-label]')) {
            if (matcher(el.getAttribute('aria-label') || '')) hits.push(el);
          }
        });
        return dedupe(hits);
      }

      if (stage.startsWith('placeholder=')) {
        const matcher = parseMatcher(stage.slice(12));
        const hits = [];
        walkRoots(root, (r) => {
          for (const el of r.querySelectorAll('[placeholder]')) {
            if (matcher(el.getAttribute('placeholder') || '')) hits.push(el);
          }
        });
        return dedupe(hits);
      }

      if (stage.startsWith('alt=')) {
        const matcher = parseMatcher(stage.slice(4));
        const hits = [];
        walkRoots(root, (r) => {
          for (const el of r.querySelectorAll('[alt]')) {
            if (matcher(el.getAttribute('alt') || '')) hits.push(el);
          }
        });
        return dedupe(hits);
      }

      if (stage.startsWith('title=')) {
        const matcher = parseMatcher(stage.slice(6));
        const hits = [];
        walkRoots(root, (r) => {
          for (const el of r.querySelectorAll('[title]')) {
            if (matcher(el.getAttribute('title') || '')) hits.push(el);
          }
        });
        return dedupe(hits);
      }

      if (stage.startsWith('testid=')) {
        const val = stripQuotes(stage.slice(7));
        const hits = [];
        walkRoots(root, (r) => {
          for (const el of r.querySelectorAll('[data-testid], [data-test-id], [data-test], [data-cy]')) {
            const v = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test') || el.getAttribute('data-cy') || '';
            if (v === val) hits.push(el);
          }
        });
        return dedupe(hits);
      }

      if (stage.startsWith('xpath=')) {
        const expr = stage.slice(6).trim();
        const doc = root.nodeType === 9 ? root : (root.ownerDocument || document);
        const hits = [];
        try {
          const snap = doc.evaluate(expr, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < snap.snapshotLength; i++) {
            const item = snap.snapshotItem(i);
            if (item && item.nodeType === 1) hits.push(item);
          }
        } catch {}
        return dedupe(hits);
      }

      if (stage.startsWith('text=')) {
        const rawText = stage.slice(5).trim();
        const reMatch = rawText.match(/^\\/(.+)\\/([gimsuy]*)$/);
        const re = reMatch ? new RegExp(reMatch[1], reMatch[2]) : null;
        const isQuotedExact = (rawText.startsWith('"') && rawText.endsWith('"')) || (rawText.startsWith("'") && rawText.endsWith("'"));
        const needle = stripQuotes(rawText).toLowerCase();
        const isInteractiveEl = (el) => {
          const t = el.tagName?.toLowerCase();
          if (t === 'button' || t === 'a' || t === 'label' || t === 'summary' || t === 'option') return true;
          const role = (el.getAttribute?.('role') || '').toLowerCase();
          return ['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option'].includes(role);
        };
        const exact = [];
        const partial = [];
        walkRoots(root, (r) => {
          for (const el of r.querySelectorAll('*')) {
            const tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
            const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!txt) continue;
            if (re) {
              if (re.test(txt) && !Array.from(el.children).some((c) => re.test((c.innerText || c.textContent || '').replace(/\\s+/g, ' ').trim()))) {
                exact.push(el);
              }
            } else if (txt.toLowerCase() === needle) {
              exact.push(el);
            } else if (!isQuotedExact && txt.toLowerCase().includes(needle)) {
              const childHas = Array.from(el.children).some((c) => (c.innerText || c.textContent || '').toLowerCase().includes(needle));
              if (!childHas) partial.push(el);
            }
          }
        });
        const refinedExact = exact.filter((el) => {
          const hasExactDescendant = exact.some((other) => other !== el && el.contains(other));
          if (hasExactDescendant && !isInteractiveEl(el)) return false;
          const hasInteractiveAncestor = exact.some((other) => other !== el && other.contains(el) && isInteractiveEl(other));
          if (hasInteractiveAncestor && !isInteractiveEl(el)) return false;
          return true;
        });
        const chosen = refinedExact.length ? refinedExact : exact.length ? exact : partial;
        return dedupe(chosen);
      }

      const hits = [];
      walkRoots(root, (r) => {
        try {
          hits.push(...r.querySelectorAll(stage));
        } catch {}
      });
      return dedupe(hits);
    }

    let roots = [document];
    let isDocumentRoot = true;
    let frameOffsetX = 0;
    let frameOffsetY = 0;
    let explicitVisibility = null;

    for (let idx = 0; idx < STAGES.length; idx++) {
      const stage = STAGES[idx];

      if (stage === 'first') {
        if (explicitVisibility !== 'false' && VIS_MODE !== 'any') {
          const vis = roots.filter(isVisible);
          if (vis.length > 0) roots = vis;
        }
        roots = roots.slice(0, 1);
        continue;
      }
      if (stage === 'last') {
        if (explicitVisibility !== 'false' && VIS_MODE !== 'any') {
          const vis = roots.filter(isVisible);
          if (vis.length > 0) roots = vis;
        }
        roots = roots.length ? [roots[roots.length - 1]] : [];
        continue;
      }
      const nthMatch = stage.match(/^nth=(-?\\d+)$/i);
      if (nthMatch) {
        if (explicitVisibility !== 'false' && VIS_MODE !== 'any') {
          const vis = roots.filter(isVisible);
          if (vis.length > 0) roots = vis;
        }
        const rawIdx = Number(nthMatch[1]);
        const targetIdx = rawIdx < 0 ? roots.length + rawIdx : rawIdx;
        roots = targetIdx >= 0 && targetIdx < roots.length ? [roots[targetIdx]] : [];
        continue;
      }
      if (stage === 'visible=true' || stage === 'visible') {
        explicitVisibility = 'true';
        roots = roots.filter(isVisible);
        continue;
      }
      if (stage === 'visible=false') {
        explicitVisibility = 'false';
        continue;
      }
      if (stage.startsWith('has-text=')) {
        const matcher = parseMatcher(stage.slice(9));
        roots = roots.filter((el) => matcher((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()));
        continue;
      }
      if (stage.startsWith('has=')) {
        const sub = stage.slice(4).trim();
        roots = roots.filter((el) => queryStageInRoot(el, sub).length > 0);
        continue;
      }

      if (!isDocumentRoot && roots.length > 0 && roots[0].tagName === 'IFRAME') {
        const iframe = roots.find((el) => el.tagName === 'IFRAME' && isVisible(el)) || roots[0];
        const r = iframe.getBoundingClientRect();
        let innerDoc = null;
        try { innerDoc = iframe.contentDocument; } catch {}
        if (!innerDoc) {
          return {
            __bpCrossOrigin: true,
            src: iframe.src || iframe.getAttribute('src') || '',
            id: iframe.id || '',
            name: iframe.name || iframe.getAttribute('name') || '',
            offsetX: frameOffsetX + r.left,
            offsetY: frameOffsetY + r.top,
            remainingStages: STAGES.slice(idx),
          };
        }
        frameOffsetX += r.left;
        frameOffsetY += r.top;
        roots = [innerDoc];
        isDocumentRoot = true;
      }

      const next = [];
      for (const r of roots) {
        next.push(...queryStageInRoot(r, stage));
      }
      roots = dedupe(next);
      isDocumentRoot = false;
      if (roots.length === 0) break;
    }

    let finalList = roots;
    if (explicitVisibility === 'true' || VIS_MODE === 'visible-only') {
      finalList = roots.filter(isVisible);
    } else if (explicitVisibility !== 'false' && VIS_MODE === 'prefer-visible') {
      const vis = roots.filter(isVisible);
      if (vis.length > 0) {
        finalList = vis;
      } else {
        const special = roots.filter((el) => {
          const t = el.tagName?.toLowerCase();
          return t === 'option' || (t === 'input' && el.type === 'file');
        });
        finalList = special;
      }
    }

    if (RETURN_MODE === 'count') {
      return { count: finalList.length, offsetX: frameOffsetX, offsetY: frameOffsetY };
    }
    const chosen = finalList[0] || null;
    if (!chosen) return null;
    globalThis.__bpLastLocatorMeta = { count: finalList.length, offsetX: frameOffsetX, offsetY: frameOffsetY };
    return chosen;
  })()`
}

function matchChildSession(session: TabCDPSession, desc: CrossOriginHandoff) {
  const children = session.getChildSessions()
  if (!children.length) return undefined
  if (desc.src) {
    const exact = children.find((c) => c.url === desc.src)
    if (exact) return exact
    const partial = children.find((c) => c.url && (c.url.startsWith(desc.src) || desc.src.startsWith(c.url)))
    if (partial) return partial
  }
  if (children.length === 1) return children[0]
  return children.find((c) => c.type === 'iframe')
}

async function evaluateStages(
  session: TabCDPSession,
  stages: string[],
  opts: {
    visibilityMode: LocatorVisibilityMode
    sessionId?: string
    contextId?: number
    frameOffset: { x: number; y: number }
  },
): Promise<LocatorQueryResult> {
  const expr = buildInPageChainEvaluator(stages, opts.visibilityMode, 'first')
  const evalParams: Record<string, unknown> = { expression: expr, returnByValue: false }
  if (opts.contextId !== undefined && !opts.sessionId) evalParams.contextId = opts.contextId

  const res = await session
    .send<{ result?: { objectId?: string; subtype?: string; type?: string; value?: unknown } }>(
      'Runtime.evaluate',
      evalParams,
      { sessionId: opts.sessionId },
    )
    .catch(() => null)

  const obj = res?.result
  if (!obj || !obj.objectId) {
    return { count: 0, frameOffset: opts.frameOffset }
  }

  if (obj.subtype !== 'node') {
    const handoff = await session
      .send<{ result?: { value?: CrossOriginHandoff | null } }>(
        'Runtime.callFunctionOn',
        {
          objectId: obj.objectId,
          functionDeclaration: `function() { return this && this.__bpCrossOrigin ? this : null; }`,
          returnByValue: true,
        },
        { sessionId: opts.sessionId },
      )
      .catch(() => null)

    const desc = handoff?.result?.value
    if (desc && desc.__bpCrossOrigin) {
      const child = matchChildSession(session, desc)
      if (!child) return { count: 0, frameOffset: opts.frameOffset }
      await session.send('Runtime.enable', {}, { sessionId: child.sessionId }).catch(() => {})
      await session.send('DOM.enable', {}, { sessionId: child.sessionId }).catch(() => {})
      return await evaluateStages(session, desc.remainingStages, {
        visibilityMode: opts.visibilityMode,
        sessionId: child.sessionId,
        frameOffset: {
          x: opts.frameOffset.x + desc.offsetX,
          y: opts.frameOffset.y + desc.offsetY,
        },
      })
    }
    return { count: 0, frameOffset: opts.frameOffset }
  }

  const metaParams: Record<string, unknown> = {
    expression:
      '(() => { const m = globalThis.__bpLastLocatorMeta || { count: 1, offsetX: 0, offsetY: 0 }; delete globalThis.__bpLastLocatorMeta; return m; })()',
    returnByValue: true,
  }
  if (opts.contextId !== undefined && !opts.sessionId) metaParams.contextId = opts.contextId
  const metaRes = await session
    .send<{ result?: { value?: { count: number; offsetX: number; offsetY: number } } }>(
      'Runtime.evaluate',
      metaParams,
      { sessionId: opts.sessionId },
    )
    .catch(() => null)
  const meta = metaRes?.result?.value ?? { count: 1, offsetX: 0, offsetY: 0 }

  return {
    objectId: obj.objectId,
    sessionId: opts.sessionId,
    frameOffset: {
      x: opts.frameOffset.x + meta.offsetX,
      y: opts.frameOffset.y + meta.offsetY,
    },
    count: meta.count,
  }
}

async function evaluateStagesCount(
  session: TabCDPSession,
  stages: string[],
  opts: { visibilityMode: LocatorVisibilityMode; sessionId?: string; contextId?: number },
): Promise<number> {
  const expr = buildInPageChainEvaluator(stages, opts.visibilityMode, 'count')
  const evalParams: Record<string, unknown> = { expression: expr, returnByValue: true }
  if (opts.contextId !== undefined && !opts.sessionId) evalParams.contextId = opts.contextId

  const res = await session
    .send<{ result?: { value?: { count?: number } & Partial<CrossOriginHandoff> } }>(
      'Runtime.evaluate',
      evalParams,
      { sessionId: opts.sessionId },
    )
    .catch(() => null)
  const val = res?.result?.value
  if (!val) return 0
  if (val.__bpCrossOrigin && val.remainingStages) {
    const child = matchChildSession(session, val as CrossOriginHandoff)
    if (!child) return 0
    return await evaluateStagesCount(session, val.remainingStages, {
      visibilityMode: opts.visibilityMode,
      sessionId: child.sessionId,
    })
  }
  return val.count ?? 0
}

/**
 * Resolves a chained/rich locator across Shadow DOM, same-origin iframes, and cross-origin OOPIF frames.
 */
export async function queryLocator(
  session: TabCDPSession,
  rawSelector: string,
  options: {
    visibilityMode?: LocatorVisibilityMode
    sessionId?: string
    contextId?: number
    frameOffset?: { x: number; y: number }
  } = {},
): Promise<LocatorQueryResult> {
  const stages = splitLocatorChain(rawSelector)
  if (!stages.length) {
    return { count: 0, frameOffset: options.frameOffset ?? { x: 0, y: 0 } }
  }
  return await evaluateStages(session, stages, {
    visibilityMode: options.visibilityMode ?? 'prefer-visible',
    sessionId: options.sessionId,
    contextId: options.contextId,
    frameOffset: options.frameOffset ?? { x: 0, y: 0 },
  })
}

export async function countLocatorMatches(
  session: TabCDPSession,
  rawSelector: string,
  options: {
    visibilityMode?: LocatorVisibilityMode
    sessionId?: string
    contextId?: number
  } = {},
): Promise<number> {
  const stages = splitLocatorChain(rawSelector)
  if (!stages.length) return 0
  return await evaluateStagesCount(session, stages, {
    visibilityMode: options.visibilityMode ?? 'prefer-visible',
    sessionId: options.sessionId,
    contextId: options.contextId,
  })
}

/**
 * Serialized cross-realm-safe stable DOM locator function for CDP `Runtime.callFunctionOn`.
 */
export const STABLE_LOCATOR_FUNCTION = computeStableDomSelector.toString()
