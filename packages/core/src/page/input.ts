import type { TabCDPSession } from '../cdp-client.js'
import { sleep } from '../wait.js'
import type { KeyModifier, MouseButton } from './types.js'

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const SPECIAL_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
}

for (let i = 1; i <= 12; i++) {
  SPECIAL_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i }
}

export function modifierBitmask(modifiers?: KeyModifier[]): number {
  if (!modifiers?.length) return 0
  let mask = 0
  for (const m of modifiers) {
    if (m === 'Alt') mask |= 1
    else if (m === 'Control') mask |= 2
    else if (m === 'Meta') mask |= 4
    else if (m === 'Shift') mask |= 8
  }
  return mask
}

export function buttonBitmask(button: MouseButton): number {
  if (button === 'right') return 2
  if (button === 'middle') return 4
  return 1
}

function resolveEditingCommands(key: string, mods: KeyModifier[]): string[] {
  const hasAccel = mods.includes('Meta') || mods.includes('Control')
  const hasShift = mods.includes('Shift')
  const lower = key.toLowerCase()
  if (hasAccel && !mods.includes('Alt')) {
    if (lower === 'a' && !hasShift) return ['selectAll']
    if (lower === 'c' && !hasShift) return ['copy']
    if (lower === 'x' && !hasShift) return ['cut']
    if (lower === 'v' && !hasShift) return ['paste']
    if (lower === 'v' && hasShift) return ['pasteAndMatchStyle']
    if (lower === 'z' && !hasShift) return ['undo']
    if ((lower === 'z' && hasShift) || (lower === 'y' && !hasShift)) return ['redo']
  }
  if (!hasAccel && !mods.includes('Alt')) {
    if (key === 'Backspace') return ['deleteBackward']
    if (key === 'Delete') return ['deleteForward']
  }
  return []
}

function resolveKeyDef(keyName: string): KeyDef {
  if (SPECIAL_KEYS[keyName]) return SPECIAL_KEYS[keyName]
  if (keyName.length === 1) {
    const ch = keyName
    const upper = ch.toUpperCase()
    const code = /[A-Z]/.test(upper)
      ? `Key${upper}`
      : /[0-9]/.test(ch)
        ? `Digit${ch}`
        : ch
    return { key: ch, code, keyCode: upper.charCodeAt(0), text: ch }
  }
  return { key: keyName, code: keyName, keyCode: 0 }
}

/**
 * Low-level browser-trusted CDP mouse & keyboard driver tracking held button
 * and modifier bitmasks across multi-step gestures, strokes, and editor shortcuts.
 */
export class PageInputDriver {
  private readonly session: TabCDPSession
  lastMousePos = { x: 0, y: 0 }
  private pressedButtonsMask = 0
  private activeModifiersMask = 0
  private touchEnabled = false

  constructor(session: TabCDPSession) {
    this.session = session
  }

  private get tabId(): number {
    return this.session.tabId
  }

  async mouseMove(x: number, y: number, options: { steps?: number } = {}): Promise<void> {
    const steps = Math.max(1, options.steps ?? 1)
    const startX = this.lastMousePos.x
    const startY = this.lastMousePos.y
    const heldButton: MouseButton | 'none' =
      this.pressedButtonsMask & 1
        ? 'left'
        : this.pressedButtonsMask & 2
          ? 'right'
          : this.pressedButtonsMask & 4
            ? 'middle'
            : 'none'
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const eased = steps > 1 ? 1 - Math.pow(1 - t, 2) : 1
      const cx = startX + (x - startX) * eased
      const cy = startY + (y - startY) * eased
      await this.session.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: cx,
        y: cy,
        button: heldButton,
        buttons: this.pressedButtonsMask,
        modifiers: this.activeModifiersMask,
      })
      if (steps > 1) {
        void this.session.transport.moveGhostCursor?.(this.tabId, cx, cy, this.pressedButtonsMask > 0).catch(() => {})
        await sleep(6)
      }
    }
    this.lastMousePos = { x, y }
    if (steps === 1) {
      void this.session.transport.moveGhostCursor?.(this.tabId, x, y, this.pressedButtonsMask > 0).catch(() => {})
    }
  }

  async mouseDown(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left'
    this.pressedButtonsMask |= buttonBitmask(button)
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: this.pressedButtonsMask,
      clickCount: opts.clickCount ?? 1,
      modifiers: (opts.modifiers ?? 0) | this.activeModifiersMask,
    })
    this.lastMousePos = { x, y }
    void this.session.transport.moveGhostCursor?.(this.tabId, x, y, true).catch(() => {})
  }

  async mouseUp(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left'
    this.pressedButtonsMask &= ~buttonBitmask(button)
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: this.pressedButtonsMask,
      clickCount: opts.clickCount ?? 1,
      modifiers: (opts.modifiers ?? 0) | this.activeModifiersMask,
    })
    this.lastMousePos = { x, y }
    void this.session.transport.moveGhostCursor?.(this.tabId, x, y, false).catch(() => {})
  }

  async mouseClick(
    x: number,
    y: number,
    opts: { button?: MouseButton; clickCount?: number; modifiers?: number } = {},
  ): Promise<void> {
    const button = opts.button ?? 'left'
    const clicks = opts.clickCount ?? 1
    await this.mouseMove(x, y, { steps: 1 })
    for (let c = 1; c <= clicks; c++) {
      await this.mouseDown(x, y, { button, clickCount: c, modifiers: opts.modifiers })
      await this.mouseUp(x, y, { button, clickCount: c, modifiers: opts.modifiers })
    }
  }

  async wheel(deltaX: number, deltaY: number, pos?: { x: number; y: number }): Promise<void> {
    const x = pos?.x ?? this.lastMousePos.x ?? 400
    const y = pos?.y ?? this.lastMousePos.y ?? 300
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    })
  }

  async mouseStroke(
    points: Array<{ x: number; y: number }>,
    options: { button?: MouseButton; stepsPerSegment?: number; delayMs?: number } = {},
  ): Promise<void> {
    if (points.length < 2) {
      throw new Error('mouseStroke requires at least 2 points')
    }
    const button = options.button ?? 'left'
    const steps = Math.max(1, options.stepsPerSegment ?? 6)
    const start = points[0]
    await this.mouseMove(start.x, start.y)
    await this.mouseDown(start.x, start.y, { button })
    for (let i = 1; i < points.length; i++) {
      await this.mouseMove(points[i].x, points[i].y, { steps })
      if (options.delayMs) await sleep(options.delayMs)
    }
    const end = points[points.length - 1]
    await this.mouseUp(end.x, end.y, { button })
  }

  async pressKey(
    combo: string,
    options: { modifiers?: KeyModifier[]; action?: 'press' | 'down' | 'up'; repeat?: number } = {},
  ): Promise<void> {
    const action = options.action ?? 'press'
    const repeat = Math.max(1, Math.min(50, options.repeat ?? 1))

    if (action === 'down') {
      const def = resolveKeyDef(combo.trim())
      const keyMod =
        def.key === 'Alt' || def.key === 'Control' || def.key === 'Meta' || def.key === 'Shift'
          ? modifierBitmask([def.key])
          : 0
      this.activeModifiersMask |= keyMod
      const mask = modifierBitmask(options.modifiers) | this.activeModifiersMask
      await this.keyDown(def.key, mask)
      return
    }
    if (action === 'up') {
      const def = resolveKeyDef(combo.trim())
      const keyMod =
        def.key === 'Alt' || def.key === 'Control' || def.key === 'Meta' || def.key === 'Shift'
          ? modifierBitmask([def.key])
          : 0
      this.activeModifiersMask &= ~keyMod
      const mask = modifierBitmask(options.modifiers) | this.activeModifiersMask
      await this.keyUp(def.key, mask)
      return
    }

    const parts = combo.split('+').map((s) => s.trim())
    const keyPart = parts.pop()!
    const mods: KeyModifier[] = [...(options.modifiers ?? [])]
    for (const p of parts) {
      const lower = p.toLowerCase()
      if (lower === 'cmd' || lower === 'meta' || lower === 'command') mods.push('Meta')
      else if (lower === 'ctrl' || lower === 'control') mods.push('Control')
      else if (lower === 'alt' || lower === 'option') mods.push('Alt')
      else if (lower === 'shift') mods.push('Shift')
    }

    const mask = modifierBitmask(mods)
    const def = resolveKeyDef(keyPart)
    const commands = resolveEditingCommands(def.key, mods)
    const hasAccel = mods.includes('Meta') || mods.includes('Control')

    const activeMods: KeyModifier[] = []
    for (const m of mods) {
      activeMods.push(m)
      await this.keyDown(m, modifierBitmask(activeMods))
    }
    for (let r = 0; r < repeat; r++) {
      await this.session.send('Input.dispatchKeyEvent', {
        type: def.text && !hasAccel ? 'keyDown' : 'rawKeyDown',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        text: hasAccel ? undefined : def.text,
        unmodifiedText: def.text,
        modifiers: mask,
        ...(commands.length ? { commands } : {}),
      })
      await this.session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        modifiers: mask,
      })
    }
    for (let i = mods.length - 1; i >= 0; i--) {
      activeMods.pop()
      await this.keyUp(mods[i], modifierBitmask(activeMods))
    }
  }

  async keyDown(keyName: string, modifiers = 0): Promise<void> {
    const def = resolveKeyDef(keyName)
    await this.session.send('Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      text: def.text,
      modifiers,
    })
  }

  async keyUp(keyName: string, modifiers = 0): Promise<void> {
    const def = resolveKeyDef(keyName)
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      modifiers,
    })
  }

  private async ensureTouchEnabled(): Promise<void> {
    if (this.touchEnabled) return
    await this.session.send('Emulation.setTouchEmulationEnabled', { enabled: true }).catch(() => {})
    this.touchEnabled = true
  }

  async touchTap(x: number, y: number): Promise<void> {
    await this.ensureTouchEnabled()
    const pt = { x: Math.round(x), y: Math.round(y), radiusX: 4, radiusY: 4, force: 1, id: 1 }
    await this.session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [pt],
      modifiers: this.activeModifiersMask,
    })
    await sleep(30)
    await this.session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      modifiers: this.activeModifiersMask,
    })
    this.lastMousePos = { x, y }
    void this.session.transport.moveGhostCursor?.(this.tabId, x, y, true).catch(() => {})
  }

  async touchSwipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    options: { steps?: number; durationMs?: number } = {},
  ): Promise<void> {
    await this.ensureTouchEnabled()
    const steps = Math.max(2, Math.min(40, options.steps ?? 10))
    const stepDelay = Math.max(8, Math.round((options.durationMs ?? 240) / steps))

    await this.session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: Math.round(from.x), y: Math.round(from.y), radiusX: 4, radiusY: 4, force: 1, id: 1 }],
      modifiers: this.activeModifiersMask,
    })
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const eased = 1 - Math.pow(1 - t, 2)
      const cx = from.x + (to.x - from.x) * eased
      const cy = from.y + (to.y - from.y) * eased
      await sleep(stepDelay)
      await this.session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: Math.round(cx), y: Math.round(cy), radiusX: 4, radiusY: 4, force: 1, id: 1 }],
        modifiers: this.activeModifiersMask,
      })
    }
    await this.session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      modifiers: this.activeModifiersMask,
    })
    this.lastMousePos = { x: to.x, y: to.y }
  }
}
