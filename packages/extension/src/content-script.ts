/**
 * BrowserPilot Content Script (Isolated World, bundled as classic IIFE).
 * Idempotently initializes visual feedback overlay, element picker/pinning,
 * and zero-debugger live Side-Panel codegen recording.
 */

import { setSidePanelCodegenState } from './content/codegen.js'
import {
  moveGhostCursor,
  removeOrphanedOverlayHost,
  safeSendRuntimeMessage,
  setContentLanguage,
  setOverlayVisible,
  showHighlight,
  updateControlBanner,
} from './content/overlay.js'
import { pinLastRightClickedElement, recordContextMenuTarget, startElementPicker } from './content/picker.js'

function bootstrapContentScript(): void {
  // Remove any orphaned floating capsule left behind in open tabs before an extension reload
  removeOrphanedOverlayHost()

  document.addEventListener(
    'contextmenu',
    (e) => {
      recordContextMenuTarget(e.target)
    },
    true,
  )

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return false
    if (typeof msg.language === 'string') {
      setContentLanguage(msg.language)
    }

    if (msg.type === 'browserpilot:control-banner') {
      updateControlBanner(msg)
      sendResponse({ ok: true })
      return false
    }
    if (msg.type === 'browserpilot:set-overlay-visible') {
      setOverlayVisible(Boolean(msg.visible))
      sendResponse({ ok: true })
      return false
    }
    if (msg.type === 'browserpilot:highlight' && msg.box) {
      showHighlight(msg.box, msg.label)
      sendResponse({ ok: true })
      return false
    }
    if (msg.type === 'browserpilot:ghost-cursor') {
      moveGhostCursor(Number(msg.x ?? 0), Number(msg.y ?? 0), Boolean(msg.clicking))
      sendResponse({ ok: true })
      return false
    }
    if (msg.type === 'browserpilot:start-picker') {
      startElementPicker()
      sendResponse({ ok: true })
      return false
    }
    if (msg.type === 'browserpilot:pin-last-right-clicked') {
      sendResponse(pinLastRightClickedElement())
      return false
    }
    if (msg.type === 'browserpilot:set-codegen') {
      setSidePanelCodegenState(Boolean(msg.active), Boolean(msg.assertMode))
      sendResponse({ ok: true })
      return false
    }
    return false
  })

  // Re-sync in-page control banner, language & live codegen state after navigation or on-demand injection
  void safeSendRuntimeMessage<{
    active?: boolean
    status?: string
    paused?: boolean
    theme?: 'dark' | 'light'
    language?: 'zh' | 'en'
    codegenActive?: boolean
    codegenAssertMode?: boolean
  }>({
    type: 'browserpilot:get-tab-banner',
  }).then((res) => {
    if (res && typeof res === 'object') {
      setContentLanguage(res.language)
      if (res.active) {
        updateControlBanner({ ...res, active: true })
      }
      if (res.codegenActive) {
        setSidePanelCodegenState(true, Boolean(res.codegenAssertMode))
      }
    }
  })
}

const bootGuard = globalThis as { __browserpilotContentBooted?: boolean }
if (!bootGuard.__browserpilotContentBooted) {
  bootGuard.__browserpilotContentBooted = true
  bootstrapContentScript()
}
