import type { BoundingBox } from '@browserpilot/protocol'
import type { TabCDPSession } from '../cdp-client.js'
import { queryLocator } from '../locator.js'
import type { SnapshotEngine } from '../snapshot.js'
import { sleep, waitForCondition } from '../wait.js'
import type { ResolvedElement } from './types.js'

export interface ActionabilityDeps {
  session: TabCDPSession
  snapshotEngine: SnapshotEngine
  evaluate: <T = unknown>(expression: string) => Promise<T>
}

interface RawViewportRectResult {
  x: number
  y: number
  width: number
  height: number
  offsetX: number
  offsetY: number
  connected: boolean
  needsScroll?: boolean
}

const READ_ELEMENT_VIEWPORT_RECT_FN = `function() {
  if (!this.isConnected) return { x: 0, y: 0, width: 0, height: 0, offsetX: 0, offsetY: 0, connected: false };
  const doc = this.ownerDocument || document;
  let r = this.getBoundingClientRect();
  const tag = (this.tagName || '').toLowerCase();
  const inputType = (this.type || '').toLowerCase();
  if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio') && (!r || r.width <= 2 || r.height <= 2)) {
    const lbl = this.closest?.('label') || (this.id ? doc.querySelector('label[for="' + CSS.escape(this.id) + '"]') : null);
    if (lbl) {
      const lr = lbl.getBoundingClientRect();
      if (lr && lr.width > 2 && lr.height > 2) r = lr;
    }
  }
  if (!r || (r.width === 0 && r.height === 0)) return { x: 0, y: 0, width: 0, height: 0, offsetX: 0, offsetY: 0, connected: true };
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
  return { x: r.left, y: r.top, width: r.width, height: r.height, offsetX: ox, offsetY: oy, connected: true };
}`

const CHECK_SCROLL_AND_READ_RECT_FN = `function() {
  if (!this.isConnected) return { x: 0, y: 0, width: 0, height: 0, offsetX: 0, offsetY: 0, connected: false, needsScroll: false };
  const doc = this.ownerDocument || document;
  const win = doc.defaultView || window;
  let r = this.getBoundingClientRect();
  const tag = (this.tagName || '').toLowerCase();
  const inputType = (this.type || '').toLowerCase();
  if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio') && (!r || r.width <= 2 || r.height <= 2)) {
    const lbl = this.closest?.('label') || (this.id ? doc.querySelector('label[for="' + CSS.escape(this.id) + '"]') : null);
    if (lbl) {
      const lr = lbl.getBoundingClientRect();
      if (lr && lr.width > 2 && lr.height > 2) r = lr;
    }
  }
  let needsScroll = false;
  if (!r || (r.width === 0 && r.height === 0)) {
    needsScroll = true;
  } else {
    const vw = win.innerWidth || doc.documentElement.clientWidth || 1280;
    const vh = win.innerHeight || doc.documentElement.clientHeight || 720;
    if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
      needsScroll = true;
    } else {
      let cur = this.parentElement;
      while (cur && cur !== doc.body && cur !== doc.documentElement) {
        const st = win.getComputedStyle(cur);
        const clipY = /(auto|scroll|hidden|clip)/.test(st.overflowY) && cur.scrollHeight > cur.clientHeight + 2;
        const clipX = /(auto|scroll|hidden|clip)/.test(st.overflowX) && cur.scrollWidth > cur.clientWidth + 2;
        if (clipY || clipX) {
          const ar = cur.getBoundingClientRect();
          if (clipY && (r.top < ar.top - 1 || r.bottom > ar.bottom + 1)) { needsScroll = true; break; }
          if (clipX && (r.left < ar.left - 1 || r.right > ar.right + 1)) { needsScroll = true; break; }
        }
        cur = cur.parentElement;
      }
    }
  }
  if (!r || (r.width === 0 && r.height === 0)) {
    return { x: 0, y: 0, width: 0, height: 0, offsetX: 0, offsetY: 0, connected: true, needsScroll };
  }
  let ox = 0, oy = 0;
  let w = doc.defaultView;
  while (w && w !== w.parent) {
    try {
      const fe = w.frameElement;
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      ox += fr.left;
      oy += fr.top;
      w = w.parent;
    } catch { break; }
  }
  return { x: r.left, y: r.top, width: r.width, height: r.height, offsetX: ox, offsetY: oy, connected: true, needsScroll };
}`

export async function scrollChildIframeIntoView(
  deps: ActionabilityDeps,
  frameId?: string,
  childSessionId?: string,
): Promise<void> {
  const child = childSessionId
    ? deps.session.getChildSessions().find((c) => c.sessionId === childSessionId)
    : undefined
  const effectiveFrameId = frameId || child?.targetId
  if (effectiveFrameId) {
    try {
      const owner = await deps.session.send<{ backendNodeId?: number }>('DOM.getFrameOwner', {
        frameId: effectiveFrameId,
      })
      if (owner.backendNodeId) {
        await deps.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: owner.backendNodeId })
        return
      }
    } catch {
      // fall through to URL-based iframe lookup
    }
  }
  if (child?.url) {
    await deps
      .evaluate(`(() => {
        const targetUrl = ${JSON.stringify(child.url)};
        for (const f of document.querySelectorAll('iframe')) {
          const src = f.src || f.getAttribute('src') || '';
          if (src && (src === targetUrl || targetUrl.startsWith(src) || src.startsWith(targetUrl))) {
            const r = f.getBoundingClientRect();
            if (r.top < 0 || r.bottom > window.innerHeight || r.left < 0 || r.right > window.innerWidth) {
              f.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            }
            return true;
          }
        }
        return false;
      })()`)
      .catch(() => {})
  }
}

async function getSingleFrameOffsetInParent(
  deps: ActionabilityDeps,
  frameId: string | undefined,
  childUrl: string | undefined,
  parentSessionId: string | undefined,
): Promise<{ x: number; y: number } | null> {
  if (frameId) {
    try {
      const owner = await deps.session.send<{ backendNodeId?: number }>(
        'DOM.getFrameOwner',
        { frameId },
        { sessionId: parentSessionId },
      )
      if (owner.backendNodeId) {
        const box = await deps.session.send<{ model?: { content?: number[] } }>(
          'DOM.getBoxModel',
          { backendNodeId: owner.backendNodeId },
          { sessionId: parentSessionId },
        )
        const c = box.model?.content
        if (c && c.length >= 2) return { x: c[0], y: c[1] }
      }
    } catch {
      // fall through to URL-based iframe rect lookup
    }
  }

  if (childUrl) {
    try {
      const evalRes = await deps.session.send<{ result?: { value?: { x: number; y: number } | null } }>(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const targetUrl = ${JSON.stringify(childUrl)};
            for (const f of document.querySelectorAll('iframe')) {
              const src = f.src || f.getAttribute('src') || '';
              if (src && (src === targetUrl || targetUrl.startsWith(src) || src.startsWith(targetUrl))) {
                const r = f.getBoundingClientRect();
                return { x: r.left, y: r.top };
              }
            }
            return null;
          })()`,
          returnByValue: true,
        },
        { sessionId: parentSessionId },
      )
      if (evalRes.result?.value) return evalRes.result.value
    } catch {
      // ignore
    }
  }
  return null
}

export async function getIframeOffset(
  deps: ActionabilityDeps,
  frameId?: string,
  childSessionId?: string,
): Promise<{ x: number; y: number }> {
  const allChildren = deps.session.getChildSessions()
  const child = childSessionId ? allChildren.find((c) => c.sessionId === childSessionId) : undefined

  // Walk up nested OOPIF parent chain (supports 1-level, 2-level, and N-level cross-origin iframes)
  if (child) {
    let totalX = 0
    let totalY = 0
    let cur: typeof child | undefined = child
    const seen = new Set<string>()
    while (cur && !seen.has(cur.sessionId)) {
      seen.add(cur.sessionId)
      const effectiveFrameId = cur === child ? frameId || cur.targetId : cur.targetId
      let off = await getSingleFrameOffsetInParent(deps, effectiveFrameId, cur.url, cur.parentSessionId)
      if (!off && !cur.parentSessionId) {
        // Fallback: if Chrome attached nested OOPIF directly under tab without parentSessionId, search sibling child sessions
        for (const candidate of allChildren) {
          if (candidate.sessionId === cur.sessionId) continue
          const hit = await getSingleFrameOffsetInParent(deps, effectiveFrameId, cur.url, candidate.sessionId)
          if (hit) {
            off = hit
            totalX += off.x
            totalY += off.y
            cur = candidate
            off = null
            break
          }
        }
        if (cur !== child && !off) continue
      }
      if (off) {
        totalX += off.x
        totalY += off.y
      }
      cur = cur.parentSessionId ? allChildren.find((c) => c.sessionId === cur!.parentSessionId) : undefined
    }
    return { x: totalX, y: totalY }
  }

  const off = await getSingleFrameOffsetInParent(deps, frameId, undefined, undefined)
  return off ?? { x: 0, y: 0 }
}

/**
 * Resolves a snapshot ref, CSS selector, chained locator, semantic locator, or cross-iframe locator
 * into a visible, conditionally scrolled-into-view element with top-frame viewport coordinates.
 */
export async function resolveElement(
  deps: ActionabilityDeps,
  target: string,
  timeoutMs: number = 8_000,
  options: { allowHidden?: boolean; strict?: boolean } = {},
): Promise<ResolvedElement> {
  const tabId = deps.session.tabId
  let strictError: Error | null = null
  const resolved = await waitForCondition<ResolvedElement | { __strictAbort: true }>(
    async () => {
      strictError = null
      const refTarget = deps.snapshotEngine.getRef(tabId, target)
      let objectId: string | undefined
      let backendNodeId: number | undefined
      let sessionId: string | undefined
      let frameOffset: { x: number; y: number } | undefined

      if (refTarget) {
        backendNodeId = refTarget.backendDOMNodeId
        sessionId = refTarget.sessionId
        const r = await deps.session
          .send<{ object?: { objectId?: string } }>(
            'DOM.resolveNode',
            { backendNodeId },
            { sessionId },
          )
          .catch(() => null)
        objectId = r?.object?.objectId
      } else {
        const hit = await queryLocator(deps.session, target, {
          visibilityMode: options.allowHidden ? 'any' : 'prefer-visible',
        })
        if (options.strict && hit.count > 1) {
          strictError = new Error(
            `Strict mode violation: "${target}" resolved to ${hit.count} elements. Narrow the locator or add >> first / >> nth=0.`,
          )
          return { __strictAbort: true }
        }
        objectId = hit.objectId
        sessionId = hit.sessionId
        if (hit.frameOffset.x !== 0 || hit.frameOffset.y !== 0) {
          frameOffset = hit.frameOffset
        }
        if (objectId) {
          const desc = await deps.session
            .send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', { objectId }, { sessionId })
            .catch(() => null)
          backendNodeId = desc?.node?.backendNodeId
        }
      }

      if (!objectId) return null

      // Scroll into view ONLY when outside viewport or clipped by a scrollable ancestor.
      // Fast path: combine scroll-check + viewport bounding-box read into a single CDP round-trip.
      let rawRect: RawViewportRectResult | null = null
      if (!options.allowHidden) {
        if (sessionId) {
          await scrollChildIframeIntoView(deps, refTarget?.frameId, sessionId).catch(() => {})
        }
        const combinedRes = await deps.session
          .send<{ result?: { value?: RawViewportRectResult | null } }>(
            'Runtime.callFunctionOn',
            {
              objectId,
              returnByValue: true,
              functionDeclaration: CHECK_SCROLL_AND_READ_RECT_FN,
            },
            { sessionId },
          )
          .catch(() => null)

        rawRect = combinedRes?.result?.value ?? null
        if (rawRect && !rawRect.connected) return null

        if (!rawRect || rawRect.needsScroll !== false) {
          if (backendNodeId) {
            await deps.session
              .send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, { sessionId })
              .catch(() => {})
          }
          await deps.session
            .send(
              'Runtime.callFunctionOn',
              {
                objectId,
                functionDeclaration: `function() {
                  if (typeof this.scrollIntoView === 'function') {
                    this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                  }
                }`,
              },
              { sessionId },
            )
            .catch(() => {})
          const rectRes = await deps.session
            .send<{ result?: { value?: RawViewportRectResult | null } }>(
              'Runtime.callFunctionOn',
              {
                objectId,
                returnByValue: true,
                functionDeclaration: READ_ELEMENT_VIEWPORT_RECT_FN,
              },
              { sessionId },
            )
            .catch(() => null)
          rawRect = rectRes?.result?.value ?? null
        }
      } else {
        const rectRes = await deps.session
          .send<{ result?: { value?: RawViewportRectResult | null } }>(
            'Runtime.callFunctionOn',
            {
              objectId,
              returnByValue: true,
              functionDeclaration: READ_ELEMENT_VIEWPORT_RECT_FN,
            },
            { sessionId },
          )
          .catch(() => null)
        rawRect = rectRes?.result?.value ?? null
      }

      if (rawRect && !rawRect.connected) return null

      let box: BoundingBox | null =
        rawRect && (rawRect.width > 0 || rawRect.height > 0)
          ? { x: rawRect.x, y: rawRect.y, width: rawRect.width, height: rawRect.height }
          : null

      if (rawRect && (rawRect.offsetX !== 0 || rawRect.offsetY !== 0) && !sessionId) {
        frameOffset = { x: rawRect.offsetX, y: rawRect.offsetY }
      }

      if (!box && backendNodeId) {
        const quads = await deps.session
          .send<{ quads?: number[][] }>('DOM.getContentQuads', { backendNodeId }, { sessionId })
          .catch(() => null)
        const q = quads?.quads?.[0]
        if (q && q.length >= 8) {
          const xs = [q[0], q[2], q[4], q[6]]
          const ys = [q[1], q[3], q[5], q[7]]
          const minX = Math.min(...xs)
          const minY = Math.min(...ys)
          box = {
            x: minX,
            y: minY,
            width: Math.max(...xs) - minX,
            height: Math.max(...ys) - minY,
          }
        }
      }

      if (!box || (box.width === 0 && box.height === 0)) {
        if (!options.allowHidden) return null
        box = { x: 0, y: 0, width: 0, height: 0 }
      }

      if (sessionId) {
        const freshOffset = await getIframeOffset(deps, refTarget?.frameId, sessionId)
        if (freshOffset.x !== 0 || freshOffset.y !== 0 || !frameOffset) {
          frameOffset = freshOffset
        }
      }
      if (frameOffset && (frameOffset.x !== 0 || frameOffset.y !== 0)) {
        box = {
          x: box.x + frameOffset.x,
          y: box.y + frameOffset.y,
          width: box.width,
          height: box.height,
        }
      }

      return {
        objectId,
        backendNodeId,
        sessionId,
        frameOffset,
        box,
        center: {
          x: Math.round(box.x + box.width / 2),
          y: Math.round(box.y + box.height / 2),
        },
      }
    },
    { timeoutMs, intervalMs: 80, description: `element "${target}"` },
  )
  if (strictError) throw strictError
  if ('__strictAbort' in resolved) {
    throw new Error(`Strict mode violation for "${target}"`)
  }
  return resolved
}

export async function readElementViewportBox(
  session: TabCDPSession,
  el: ResolvedElement,
): Promise<BoundingBox | null> {
  try {
    const res = await session.send<{
      result?: { value?: RawViewportRectResult }
    }>(
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        functionDeclaration: READ_ELEMENT_VIEWPORT_RECT_FN,
        returnByValue: true,
      },
      { sessionId: el.sessionId },
    )
    const b = res.result?.value
    if (!b || !b.connected || b.width <= 0 || b.height <= 0) return null
    const ox = el.sessionId ? (el.frameOffset?.x ?? 0) : b.offsetX || (el.frameOffset?.x ?? 0)
    const oy = el.sessionId ? (el.frameOffset?.y ?? 0) : b.offsetY || (el.frameOffset?.y ?? 0)
    return {
      x: b.x + ox,
      y: b.y + oy,
      width: b.width,
      height: b.height,
    }
  } catch {
    return null
  }
}

interface FusedActionableCheckResult {
  ok: boolean
  reason?: string
  occluder?: string
  underOwnPill?: boolean
  box?: { x: number; y: number; width: number; height: number; offsetX: number; offsetY: number }
}

const FUSED_CLICK_ACTIONABLE_FN = `async function(isCrossOrigin) {
  const doc = this.ownerDocument || document;
  const win = doc.defaultView || window;
  const readBox = () => {
    if (!this.isConnected) return null;
    let r = this.getBoundingClientRect();
    const tag = (this.tagName || '').toLowerCase();
    const inputType = (this.type || '').toLowerCase();
    if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio') && (!r || r.width <= 2 || r.height <= 2)) {
      const lbl = this.closest?.('label') || (this.id ? doc.querySelector('label[for="' + CSS.escape(this.id) + '"]') : null);
      if (lbl) {
        const lr = lbl.getBoundingClientRect();
        if (lr && lr.width > 2 && lr.height > 2) r = lr;
      }
    }
    if (!r || (r.width === 0 && r.height === 0)) return null;
    let ox = 0, oy = 0;
    let w = win;
    while (w && w !== w.parent) {
      try {
        const fe = w.frameElement;
        if (!fe) break;
        const fr = fe.getBoundingClientRect();
        ox += fr.left;
        oy += fr.top;
        w = w.parent;
      } catch { break; }
    }
    return { x: r.left, y: r.top, width: r.width, height: r.height, offsetX: ox, offsetY: oy };
  };
  const nextFrame = () => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(finish);
    }
    setTimeout(finish, 120);
  });

  // Playwright-style 2-rAF bounding-box stability wait executed completely in-page (1 CDP RPC instead of 5+)
  let prev = readBox();
  if (!prev) return { ok: false, reason: 'detached' };
  let stableFrames = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    await nextFrame();
    const next = readBox();
    if (!next) return { ok: false, reason: 'detached' };
    const moved =
      Math.abs(next.x - prev.x) > 1.5 ||
      Math.abs(next.y - prev.y) > 1.5 ||
      Math.abs(next.width - prev.width) > 1.5 ||
      Math.abs(next.height - prev.height) > 1.5;
    prev = next;
    if (!moved) {
      stableFrames++;
      if (stableFrames >= 2) break;
    } else {
      stableFrames = 0;
    }
  }
  if (stableFrames < 2) {
    return { ok: false, reason: 'animating', box: prev };
  }
  if (!this.isConnected) return { ok: false, reason: 'detached' };
  if (this.disabled === true || this.getAttribute?.('aria-disabled') === 'true') {
    return { ok: false, reason: 'disabled', box: prev };
  }
  if (isCrossOrigin) {
    return { ok: true, box: prev, underOwnPill: false };
  }
  const style = win.getComputedStyle(this);
  if (style.pointerEvents === 'none') {
    return { ok: false, reason: 'pointer-events-none', box: prev };
  }

  const deepHit = (root, x, y) => {
    let hit = root.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };

  let underOwnPill = false;
  for (let retry = 0; retry < 2; retry++) {
    const cx = prev.x + prev.width / 2;
    const cy = prev.y + prev.height / 2;
    let hit = deepHit(doc, cx, cy);
    if (hit && hit.id === '__browserpilot_ui_host') {
      underOwnPill = true;
      const prevDisplay = hit.style.display;
      hit.style.display = 'none';
      hit = deepHit(doc, cx, cy);
      const uiHost = doc.getElementById('__browserpilot_ui_host');
      if (uiHost) uiHost.style.display = prevDisplay;
    }
    if (!hit || hit === this || this.contains(hit) || hit.contains(this)) {
      return { ok: true, box: prev, underOwnPill };
    }
    if (this.id && hit.closest && hit.closest('label[for="' + CSS.escape(this.id) + '"]')) {
      return { ok: true, box: prev, underOwnPill };
    }
    const ownLabel = this.closest?.('label');
    if (ownLabel && (hit === ownLabel || ownLabel.contains(hit))) {
      return { ok: true, box: prev, underOwnPill };
    }
    let cur = hit;
    let isFixedOrSticky = false;
    let occluderBottom = 0;
    while (cur && cur !== doc.body && cur !== doc.documentElement) {
      const pos = win.getComputedStyle(cur).position;
      if (pos === 'fixed' || pos === 'sticky') {
        isFixedOrSticky = true;
        occluderBottom = cur.getBoundingClientRect().bottom;
        break;
      }
      cur = cur.parentElement;
    }
    if (isFixedOrSticky && retry === 0) {
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = this.getBoundingClientRect();
      if (occluderBottom > 0 && r.top < occluderBottom + 8) {
        win.scrollBy(0, -(occluderBottom - r.top + 24));
      }
      await nextFrame();
      const refreshed = readBox();
      if (refreshed) {
        prev = refreshed;
        continue;
      }
    }
    const tag = hit.tagName?.toLowerCase() || 'element';
    const cls = typeof hit.className === 'string' && hit.className.trim()
      ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.')
      : '';
    const id = hit.id ? '#' + hit.id : '';
    const txt = (hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    return {
      ok: false,
      reason: 'occluded',
      occluder: '<' + tag + id + cls + '>' + (txt ? ' ("' + txt + '")' : ''),
      box: prev,
      underOwnPill,
    };
  }
  return { ok: true, box: prev, underOwnPill };
}`

async function checkClickActionableOnce(
  session: TabCDPSession,
  el: ResolvedElement,
  targetLabel: string,
): Promise<
  | { ok: true; el: ResolvedElement; underOwnPill: boolean }
  | { ok: false; retryable: boolean; reason: string; error: Error }
> {
  const res = await session
    .send<{ result?: { value?: FusedActionableCheckResult } }>(
      'Runtime.callFunctionOn',
      {
        objectId: el.objectId,
        arguments: [{ value: Boolean(el.sessionId) }],
        awaitPromise: true,
        returnByValue: true,
        functionDeclaration: FUSED_CLICK_ACTIONABLE_FN,
      },
      { sessionId: el.sessionId },
    )
    .catch(() => null)

  const val = res?.result?.value
  if (!val) {
    return {
      ok: false,
      retryable: true,
      reason: 'detached',
      error: new Error(`Element "${targetLabel}" became stale during actionability check.`),
    }
  }

  let current = el
  if (val.box) {
    const ox = el.sessionId ? (el.frameOffset?.x ?? 0) : val.box.offsetX || (el.frameOffset?.x ?? 0)
    const oy = el.sessionId ? (el.frameOffset?.y ?? 0) : val.box.offsetY || (el.frameOffset?.y ?? 0)
    const nextBox: BoundingBox = {
      x: val.box.x + ox,
      y: val.box.y + oy,
      width: val.box.width,
      height: val.box.height,
    }
    current = {
      ...el,
      box: nextBox,
      center: { x: nextBox.x + nextBox.width / 2, y: nextBox.y + nextBox.height / 2 },
    }
  }

  if (val.ok) {
    return { ok: true, el: current, underOwnPill: Boolean(val.underOwnPill) }
  }
  if (val.reason === 'animating') {
    return {
      ok: false,
      retryable: true,
      reason: 'animating',
      error: new Error(`Element "${targetLabel}" kept moving / animating and did not stabilize.`),
    }
  }
  if (val.reason === 'detached') {
    return {
      ok: false,
      retryable: true,
      reason: 'detached',
      error: new Error(`Element "${targetLabel}" detached or hidden during actionability check.`),
    }
  }
  if (val.reason === 'disabled') {
    return {
      ok: false,
      retryable: true,
      reason: 'disabled',
      error: new Error(`Element "${targetLabel}" is disabled and cannot be clicked.`),
    }
  }
  if (val.reason === 'pointer-events-none') {
    return {
      ok: false,
      retryable: true,
      reason: 'pointer-events-none',
      error: new Error(`Element "${targetLabel}" has pointer-events: none (pass force: true to override).`),
    }
  }
  return {
    ok: false,
    retryable: true,
    reason: 'occluded',
    error: new Error(
      `Element "${targetLabel}" is occluded at (${Math.round(current.center.x)}, ${Math.round(current.center.y)}) by ${val.occluder ?? 'another element'}. Dismiss the overlay/banner first or pass force: true.`,
    ),
  }
}

/**
 * Playwright-grade Action Auto-Waiting Retry Loop across DOM remounts, animations,
 * transient overlays, and temporarily disabled states.
 */
export async function resolveActionableForClick(
  deps: ActionabilityDeps,
  target: string,
  options: { timeoutMs?: number; force?: boolean; strict?: boolean } = {},
): Promise<{ el: ResolvedElement; underOwnPill: boolean }> {
  const resolveBudget = options.timeoutMs ?? 8_000
  const actionBudget = options.timeoutMs ?? 1_500
  const start = Date.now()
  let actionDeadline: number | null = null
  let lastError: Error | null = null

  while (true) {
    const remainingResolve = Math.max(100, resolveBudget - (Date.now() - start))
    const el = await resolveElement(deps, target, remainingResolve, { strict: options.strict })
    if (options.force) {
      return { el, underOwnPill: false }
    }
    if (actionDeadline === null) {
      actionDeadline = Date.now() + actionBudget
    }

    const check = await checkClickActionableOnce(deps.session, el, target)
    if (check.ok) {
      return { el: check.el, underOwnPill: check.underOwnPill }
    }
    lastError = check.error
    if (!check.retryable || Date.now() >= actionDeadline) {
      throw lastError
    }
    await sleep(check.reason === 'detached' ? 35 : 80)
  }
}
