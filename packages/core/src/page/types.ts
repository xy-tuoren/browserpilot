import type { BoundingBox } from '@browserpilot/protocol'

export type MouseButton = 'left' | 'right' | 'middle'
export type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift'

export interface ClickOptions {
  button?: MouseButton
  clickCount?: number
  modifiers?: KeyModifier[]
  timeoutMs?: number
  /** Skip pre-click occlusion & stability checks and click directly */
  force?: boolean
  /** Throw a Playwright-style strict-mode error if locator matches multiple visible elements */
  strict?: boolean
}

export interface FillOptions {
  clear?: boolean
  timeoutMs?: number
  force?: boolean
  strict?: boolean
}

export interface FileChooserHandle {
  isMultiple: boolean
  frameId: string
  backendNodeId: number
  setFiles: (filePaths: string[]) => Promise<void>
  cancel: () => Promise<void>
}

export interface WaitForFileChooserOptions {
  action?: () => Promise<unknown>
  /** If provided, files are automatically supplied and interception is closed cleanly */
  files?: string[]
  timeoutMs?: number
}

export interface ScrollResult {
  scrolled: boolean
  scrollX: number
  scrollY: number
  maxScrollY: number
  percentY: number
  atTop: boolean
  atBottom: boolean
  container: string
}

export interface ScrollUntilOptions {
  /** Optional scroll container target selector/ref (auto-detects main scrollable container if omitted) */
  container?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  maxScrolls?: number
  delayMs?: number
}

export interface ScrollUntilResult {
  found: boolean
  attempts: number
  lastScroll?: ScrollResult
}

export interface DragOptions {
  steps?: number
  /** 'auto' (default) detects HTML5 draggable="true" elements and dispatches DataTransfer DragEvents alongside pointer motion */
  mode?: 'auto' | 'pointer' | 'html5'
}

export interface SwipeOptions {
  steps?: number
  durationMs?: number
}

export interface FormFieldInput {
  target: string
  value: string | string[] | number | boolean
  type?: 'auto' | 'text' | 'select' | 'checkbox' | 'radio' | 'range' | 'file'
}

export interface FormFillResult {
  filled: Array<{ target: string; type: string; value: string | string[] | number | boolean }>
}

export interface PdfOptions {
  path?: string
  landscape?: boolean
  printBackground?: boolean
  displayHeaderFooter?: boolean
  headerTemplate?: string
  footerTemplate?: string
  scale?: number
  paperWidth?: number
  paperHeight?: number
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number
  pageRanges?: string
  preferCSSPageSize?: boolean
}

export interface InitScriptEntry {
  id: string
  preview: string
  createdAt: number
}

export interface HumanHandoffResult {
  resumed: boolean
  cancelled: boolean
  timedOut: boolean
  elapsedMs: number
  url: string
  title: string
}

export interface ScreenshotOptions {
  path?: string
  fullPage?: boolean
  format?: 'png' | 'jpeg' | 'webp'
  quality?: number
  clip?: BoundingBox
  /** Crop & upscale a viewport region (e.g. for Canvas, Figma, or tiny icons) */
  zoom?: { x: number; y: number; width: number; height: number; scale?: number }
  /** Overlay a translucent pixel coordinate grid for visual/Canvas coordinate clicking */
  grid?: boolean
  /** Grid spacing in CSS pixels (default 200 for full viewport, 50 for zoomed regions) */
  gridStep?: number
  maxDimension?: number
}

export interface EmulateOptions {
  width?: number
  height?: number
  deviceScaleFactor?: number
  mobile?: boolean
  userAgent?: string
  colorScheme?: 'light' | 'dark' | 'no-preference'
  cpuThrottlingRate?: number
  networkPreset?: 'online' | 'offline' | 'slow-3g' | 'fast-3g' | '4g'
  timezone?: string
  locale?: string
  geolocation?: { latitude: number; longitude: number; accuracy?: number }
}

export interface ResolvedElement {
  objectId: string
  backendNodeId?: number
  sessionId?: string
  frameOffset?: { x: number; y: number }
  box: BoundingBox
  center: { x: number; y: number }
}

export interface PageActionReadyMeta {
  point?: { x: number; y: number }
  box?: BoundingBox
}

export interface PageActionTraceInput {
  action: string
  title: string
  target?: string
  value?: string
  key?: string
  point?: { x: number; y: number }
  box?: BoundingBox
  captureBeforeImmediately?: boolean
}

export interface PageTraceHook {
  isActive(): boolean
  runStep<T>(
    input: PageActionTraceInput,
    fn: (markReady: (meta?: PageActionReadyMeta) => Promise<void>) => Promise<T>,
  ): Promise<T>
}
