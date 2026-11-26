import type { BrowserPilotTab } from '@browserpilot/core'
import { classifyActionRisk, type ApprovalMode } from '@browserpilot/protocol'

export async function resolveApprovalMode(
  tab: BrowserPilotTab,
  explicit?: ApprovalMode,
): Promise<ApprovalMode> {
  if (explicit === 'off' || explicit === 'high-risk' || explicit === 'strict') {
    return explicit
  }
  const envRaw = (process.env.BROWSERPILOT_APPROVAL_MODE || '').trim().toLowerCase()
  if (envRaw === 'high-risk' || envRaw === 'strict' || envRaw === 'off') {
    return envRaw
  }
  const extRpc = (
    tab.session.transport as {
      rpc?: (method: string) => Promise<{ config?: { approvalMode?: ApprovalMode } } | null>
    }
  ).rpc
  if (typeof extRpc === 'function') {
    const st = await extRpc.call(tab.session.transport, 'extension.getState').catch(() => null)
    const m = st?.config?.approvalMode
    if (m === 'high-risk' || m === 'strict') return m
  }
  return 'off'
}

export async function enforceActionApproval(
  tab: BrowserPilotTab,
  input: {
    action: string
    target?: string
    detail?: string
    explicitMode?: ApprovalMode
  },
): Promise<void> {
  const mode = await resolveApprovalMode(tab, input.explicitMode)
  if (mode === 'off') return

  const meta = await tab.page.getUrlAndTitle().catch(() => ({ url: '', title: '' }))
  let targetText: string | undefined
  if (input.target) {
    const refEntry = tab.snapshots.getRef(tab.tabId, input.target)
    if (refEntry?.name) {
      targetText = refEntry.name
    } else if (/^[#.[a-zA-Z]/.test(input.target) && !input.target.includes('=')) {
      targetText = await tab.page
        .evaluate<string>(
          `(() => {
            try {
              const el = document.querySelector(${JSON.stringify(input.target)});
              return el ? ((el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.value || '').trim().slice(0, 120)) : '';
            } catch { return ''; }
          })()`,
        )
        .catch(() => '')
    }
  }

  const assessment = classifyActionRisk({
    mode,
    action: input.action,
    target: input.target,
    targetText,
    url: meta.url,
  })
  if (assessment.risk !== 'high') return

  const detail =
    input.detail ||
    `${input.action}${input.target ? ` ${input.target}` : ''}${targetText ? ` ("${targetText.slice(0, 60)}")` : ''}`
  const res = await tab.page.requestActionApproval({
    action: input.action,
    detail,
    reason: assessment.reason,
  })
  if (!res.approved) {
    throw new Error(
      res.timedOut
        ? `High-risk action "${detail}" timed out waiting for user confirmation.`
        : `High-risk action "${detail}" was denied by user.`,
    )
  }
}

export async function appendPostActionDiff(
  tab: BrowserPilotTab,
  baseText: string,
  returnDiff: unknown,
): Promise<string> {
  if (!returnDiff) return baseText
  const snap = await tab.snapshots
    .capture(tab.session, { interactiveOnly: true, showDiffSinceLastCall: true })
    .catch(() => null)
  if (!snap?.text) return baseText
  return `${baseText}\n\n--- Page Diff ---\n${snap.text}`
}
