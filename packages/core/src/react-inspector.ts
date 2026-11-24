import type { ReactComponentInfo } from '@browserpilot/protocol'
import type { TabCDPSession } from './cdp-client.js'
import type { SnapshotEngine } from './snapshot.js'

/**
 * Inspects React Fiber internals on a DOM element to recover component name,
 * dev-mode source location (`_debugSource`), component hierarchy, and sanitized props.
 * Returns `null` cleanly for non-React elements.
 */
export async function getReactComponentInfo(
  session: TabCDPSession,
  snapshots: SnapshotEngine,
  target: string,
): Promise<ReactComponentInfo | null> {
  const refTarget = snapshots.getRef(session.tabId, target)
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

  if (!objectId) return null

  const res = await session.send<{ result?: { value?: ReactComponentInfo | null } }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
        const el = this;
        const fiberKey = Object.keys(el).find(
          (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        if (!fiberKey) return null;

        let fiber = el[fiberKey];
        if (!fiber) return null;

        function getName(f) {
          if (!f || !f.type) return null;
          if (typeof f.type === 'string') return null;
          return f.type.displayName || f.type.name || f.type.render?.displayName || f.type.render?.name || null;
        }

        function sanitize(val, depth) {
          if (depth > 2) return '[MaxDepth]';
          if (val === null || val === undefined) return val;
          const t = typeof val;
          if (t === 'string') return val.length > 160 ? val.slice(0, 160) + '…' : val;
          if (t === 'number' || t === 'boolean') return val;
          if (t === 'function') return '[Function ' + (val.name || 'anonymous') + ']';
          if (t === 'symbol') return String(val);
          if (val instanceof Element) return '[Element <' + val.tagName.toLowerCase() + '>]';
          if (Array.isArray(val)) return val.slice(0, 10).map((x) => sanitize(x, depth + 1));
          if (val.$$typeof) return '[ReactElement]';
          const out = {};
          const keys = Object.keys(val).slice(0, 15);
          for (const k of keys) {
            if (k === 'children') {
              out.children = typeof val[k] === 'string' ? val[k].slice(0, 80) : '[ReactNode]';
            } else {
              try { out[k] = sanitize(val[k], depth + 1); } catch { out[k] = '[Unreadable]'; }
            }
          }
          return out;
        }

        // Walk up to find the nearest user React component and build hierarchy
        let nearest = null;
        const hierarchy = [];
        let cur = fiber;
        let guard = 0;
        while (cur && guard++ < 60) {
          const name = getName(cur);
          if (name) {
            if (!nearest) nearest = cur;
            hierarchy.push(name);
            if (hierarchy.length >= 12) break;
          }
          cur = cur.return;
        }

        if (!nearest) return null;
        const debugSource = nearest._debugSource || fiber._debugSource || null;
        const source = debugSource
          ? {
              fileName: String(debugSource.fileName || ''),
              lineNumber: debugSource.lineNumber,
              columnNumber: debugSource.columnNumber,
            }
          : null;

        return {
          componentName: getName(nearest) || 'Unknown',
          source,
          hierarchy,
          props: sanitize(nearest.memoizedProps || {}, 0),
        };
      }`,
    },
    { sessionId },
  )

  return res.result?.value ?? null
}
