import type { TabCDPSession } from '../cdp-client.js'
import type { HumanHandoffResult } from './types.js'

export interface HandoffDeps {
  session: TabCDPSession
  evaluate: <T = unknown>(expression: string) => Promise<T>
  getUrlAndTitle: () => Promise<{ url: string; title: string }>
}

/**
 * Displays an interactive in-page Human Handoff card ("请你手动完成操作" / "Your Turn") and pauses until
 * the user clicks "我已完成，继续执行" ("Done, Continue AI") or "取消" ("Cancel") inside the browser tab.
 */
export async function requestHumanHandoff(
  deps: HandoffDeps,
  message: string,
  options: { timeoutMs?: number; language?: 'zh' | 'en' } = {},
): Promise<HumanHandoffResult> {
  const tabId = deps.session.tabId
  const timeoutMs = options.timeoutMs ?? 300_000
  const start = Date.now()
  const bindingName = '__browserpilotHandoffDone'

  let lang: 'zh' | 'en' = options.language === 'en' ? 'en' : 'zh'
  if (!options.language) {
    const extRpc = (
      deps.session.transport as {
        rpc?: (method: string) => Promise<{ config?: { language?: string } } | null>
      }
    ).rpc
    if (typeof extRpc === 'function') {
      const extState = await extRpc.call(deps.session.transport, 'extension.getState').catch(() => null)
      if (extState?.config?.language === 'en') lang = 'en'
    }
  }
  const isEn = lang === 'en'
  const cardTitle = isEn ? 'BrowserPilot · Your Turn' : 'BrowserPilot · 请你手动完成操作'
  const resumeLabel = isEn ? 'Done, Continue AI' : '我已完成，继续执行'
  const cancelLabel = isEn ? 'Cancel' : '取消'

  await deps.session.ensureBaseDomains()
  await deps.session.send('Runtime.addBinding', { name: bindingName }).catch(() => {})
  await deps.session.transport
    .setControlBanner?.(tabId, { active: true, status: 'Waiting for you...', mode: 'handoff' })
    .catch(() => {})

  let resolveAction!: (action: 'resume' | 'cancel') => void
  const decisionPromise = new Promise<'resume' | 'cancel'>((resolve) => {
    resolveAction = resolve
  })

  const offBinding = deps.session.on('Runtime.bindingCalled', (params) => {
    if (params.name !== bindingName) return
    const payload = String(params.payload ?? '')
    resolveAction(payload === 'cancel' ? 'cancel' : 'resume')
  })

  const injectCard = async () => {
    await deps
      .evaluate(`(() => {
        const old = document.getElementById('__browserpilot_handoff_host');
        if (old) old.remove();
        const host = document.createElement('div');
        host.id = '__browserpilot_handoff_host';
        host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = \`
          .bp-edge {
            position: fixed; inset: 0; pointer-events: none;
            box-shadow: inset 0 0 0 3px rgba(245, 158, 11, 0.72), inset 0 0 26px rgba(245, 158, 11, 0.22);
          }
          .bp-card {
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            pointer-events: auto;
            display: flex; align-items: center; gap: 14px; max-width: 560px;
            background: rgba(15, 23, 42, 0.94); color: #f8fafc;
            border: 1px solid rgba(251, 191, 36, 0.55);
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            border-radius: 14px; padding: 12px 16px;
            box-shadow: 0 14px 36px rgba(2, 6, 23, 0.45);
            font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif;
          }
          .bp-dot {
            width: 10px; height: 10px; border-radius: 999px; flex: none;
            background: #fbbf24; box-shadow: 0 0 10px #f59e0b;
          }
          .bp-msg { flex: 1; color: #f1f5f9; }
          .bp-title { font-weight: 700; font-size: 12px; color: #fcd34d; margin-bottom: 2px; }
          .bp-actions { display: flex; gap: 8px; flex: none; }
          button {
            cursor: pointer; border-radius: 8px; border: 1px solid transparent;
            padding: 7px 12px; font: 600 12px/1 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
          }
          .bp-resume { background: linear-gradient(135deg, #2dd4bf, #06b6d4); color: #042f2e; }
          .bp-resume:hover { filter: brightness(1.06); }
          .bp-cancel { background: rgba(148, 163, 184, 0.16); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.3); }
          .bp-cancel:hover { background: rgba(148, 163, 184, 0.28); }
        \`;
        shadow.appendChild(style);
        const edge = document.createElement('div');
        edge.className = 'bp-edge';
        const card = document.createElement('div');
        card.className = 'bp-card';
        const dot = document.createElement('div');
        dot.className = 'bp-dot';
        const msgWrap = document.createElement('div');
        msgWrap.className = 'bp-msg';
        const title = document.createElement('div');
        title.className = 'bp-title';
        title.textContent = ${JSON.stringify(cardTitle)};
        const body = document.createElement('div');
        body.textContent = ${JSON.stringify(message)};
        msgWrap.append(title, body);
        const actions = document.createElement('div');
        actions.className = 'bp-actions';
        const btnResume = document.createElement('button');
        btnResume.className = 'bp-resume';
        btnResume.textContent = ${JSON.stringify(resumeLabel)};
        btnResume.onclick = () => { globalThis.${bindingName}?.('resume'); host.remove(); };
        const btnCancel = document.createElement('button');
        btnCancel.className = 'bp-cancel';
        btnCancel.textContent = ${JSON.stringify(cancelLabel)};
        btnCancel.onclick = () => { globalThis.${bindingName}?.('cancel'); host.remove(); };
        actions.append(btnResume, btnCancel);
        card.append(dot, msgWrap, actions);
        shadow.append(edge, card);
        (document.documentElement || document.body).appendChild(host);
      })()`)
      .catch(() => {})
  }

  await injectCard()
  const offLoad = deps.session.on('Page.loadEventFired', () => {
    void injectCard()
  })

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const outcome = await Promise.race([
      decisionPromise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
    const meta = await deps.getUrlAndTitle().catch(() => ({ url: '', title: '' }))
    return {
      resumed: outcome === 'resume',
      cancelled: outcome === 'cancel',
      timedOut: outcome === 'timeout',
      elapsedMs: Date.now() - start,
      url: meta.url,
      title: meta.title,
    }
  } finally {
    if (timer) clearTimeout(timer)
    offBinding()
    offLoad()
    await deps.evaluate(`document.getElementById('__browserpilot_handoff_host')?.remove()`).catch(() => {})
    await deps.session.transport
      .setControlBanner?.(tabId, { active: true, status: 'Active', mode: 'working' })
      .catch(() => {})
  }
}
