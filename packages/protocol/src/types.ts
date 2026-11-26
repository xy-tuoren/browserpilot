import type { TabGroupColor } from './constants.js'

export interface TabInfo {
  tabId: number
  windowId?: number
  url: string
  title: string
  active: boolean
  attached: boolean
  groupId?: number
  groupTitle?: string
  targetId?: string
  openerTabId?: number
  status?: string
  favIconUrl?: string
}

export interface BrowserClientInfo {
  clientId: string
  transport: 'extension-ws' | 'extension-native' | 'direct-cdp'
  browser: string
  extensionId?: string
  extensionVersion?: string
  profileEmail?: string
  profileLabel?: string
  connectedAt: number
  lastSeenAt: number
  attachedTabCount: number
}

export interface DomainRules {
  /** Domains where auto-attach is blocked (e.g. "bank.example.com", "*.gov") */
  blockedDomains: string[]
  /** If non-empty, only allow auto-attach on matching domains */
  allowedDomains: string[]
}

export type ExtensionTheme = 'dark' | 'light'
export type ExtensionLanguage = 'zh' | 'en'

export type ApprovalMode = 'off' | 'high-risk' | 'strict'

export interface ExtensionConfig {
  theme: ExtensionTheme
  language?: ExtensionLanguage
  profileLabel?: string
  approvalMode?: ApprovalMode
  autoAttach: boolean
  paused: boolean
  showHighlights: boolean
  showGhostCursor: boolean
  groupTabs: boolean
  daemonUrl: string
  authToken: string
  domainRules: DomainRules
}

export interface ExtensionState {
  connected: boolean
  transport: 'native' | 'websocket' | 'disconnected'
  extensionId: string
  version: string
  config: ExtensionConfig
  attachedTabs: TabInfo[]
  recentActivity: ActivityLogEntry[]
  recentErrors?: Array<{ timestamp: number; tabId: number; text: string; url?: string }>
  recentFailedRequests?: Array<{ timestamp: number; tabId: number; method: string; status?: number; url: string; errorText?: string }>
  codegen?: {
    active: boolean
    tabId?: number
    assertMode?: boolean
    steps: RecordedStep[]
  }
}

export interface ActivityLogEntry {
  id: string
  timestamp: number
  tabId?: number
  action: string
  detail?: string
  status: 'ok' | 'error' | 'info'
  durationMs?: number
  /** Optional replayable workflow step payload for one-click flow.json export */
  step?: Record<string, unknown>
}

// ============================================================================
// Accessibility Snapshot & Element Refs
// ============================================================================

export interface RefTarget {
  ref: string
  backendDOMNodeId: number
  frameId?: string
  sessionId?: string
  role: string
  name: string
  tag?: string
}

export interface SnapshotOptions {
  /** Regex or substring to filter snapshot lines */
  search?: string | RegExp
  /** Return diff since last snapshot call for this tab (default true when search is omitted) */
  showDiffSinceLastCall?: boolean
  /** CSS selector or ref to scope the snapshot to a subtree */
  scope?: string
  /** Optional iframe selector, frameId, or URL substring/regex to snapshot a single frame only */
  frame?: string
  /** Include non-interactive text/structure nodes (default true) */
  includeText?: boolean
  /** Return only interactive elements ([e1], [e2]...) and their enclosing landmarks (~70% fewer tokens) */
  interactiveOnly?: boolean
  /** Restrict snapshot to elements intersecting the visible viewport (+120px lookahead margin) */
  viewportOnly?: boolean
  /** Soft character budget for large pages (0 disables truncation) */
  maxChars?: number
  /** Maximum depth to traverse (default 40) */
  maxDepth?: number
  /** Include iframe subtrees (default true) */
  includeIframes?: boolean
}

export interface FrameInfo {
  frameId: string
  parentId?: string
  url: string
  name?: string
  sessionId?: string
  crossOrigin: boolean
}

export interface SnapshotResult {
  url: string
  title: string
  text: string
  isDiff: boolean
  totalRefs: number
  refs: Record<string, RefTarget>
  truncated?: boolean
  omittedLines?: number
}

export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface SomLabelItem {
  ref: string
  role: string
  name: string
  box: BoundingBox
  color: string
}

// ============================================================================
// Console & Network Inspection
// ============================================================================

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'assert' | 'exception' | 'browser'

export interface ConsoleEntry {
  id: number
  timestamp: number
  level: ConsoleLevel
  text: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stackTrace?: string
  source: 'console' | 'exception' | 'browser'
}

export interface NetworkTiming {
  dnsMs?: number
  connectMs?: number
  sslMs?: number
  ttfbMs?: number
  downloadMs?: number
  totalMs?: number
}

export interface NetworkInitiator {
  type: string
  url?: string
  lineNumber?: number
  columnNumber?: number
  stack?: string[]
}

export interface NetworkEntry {
  requestId: string
  timestamp: number
  url: string
  method: string
  resourceType?: string
  status?: number
  statusText?: string
  mimeType?: string
  requestHeaders?: Record<string, string>
  requestPostData?: string
  responseHeaders?: Record<string, string>
  encodedDataLength?: number
  failed?: boolean
  errorText?: string
  fromCache?: boolean
  timing?: NetworkTiming
  initiator?: NetworkInitiator
  completedAt?: number
}

export interface NetworkInterceptRule {
  id: string
  urlPattern: string
  resourceType?: string
  action: 'block' | 'mock' | 'modify-headers'
  status?: number
  headers?: Record<string, string>
  body?: string
  contentType?: string
}

// ============================================================================
// CSS Styles, DOM Inspection & React Fiber
// ============================================================================

export interface StyleDeclaration {
  name: string
  value: string
  important?: boolean
  overridden?: boolean
}

export interface StyleRuleInfo {
  selector: string
  origin: string
  sourceUrl?: string
  lineNumber?: number
  columnNumber?: number
  inherited?: boolean
  inheritedFrom?: string
  declarations: StyleDeclaration[]
}

export interface ElementStylesResult {
  element: string
  inlineStyles: StyleDeclaration[]
  matchedRules: StyleRuleInfo[]
  inheritedRules: StyleRuleInfo[]
  computedSubset?: Record<string, string>
}

export interface ElementInspectResult {
  tag: string
  id?: string
  classes: string[]
  box: BoundingBox | null
  childrenCount: number
  textLength: number
  scroll: {
    scrollHeight: number
    clientHeight: number
    scrollTop: number
    overflowingY: boolean
    scrollWidth: number
    clientWidth: number
    scrollLeft: number
    overflowingX: boolean
  }
  styles: Record<string, string>
  visibility?: Record<string, string>
  input?: {
    value?: string
    checked?: boolean
    disabled?: boolean
    readOnly?: boolean
    placeholder?: string
    type?: string
  }
  aria?: Record<string, string>
  recommendedLocator?: string
  formatted: string
}

export interface ReactSourceLocation {
  fileName: string
  lineNumber?: number
  columnNumber?: number
}

export interface ReactComponentInfo {
  componentName: string
  source: ReactSourceLocation | null
  hierarchy: string[]
  props: Record<string, unknown>
}

// ============================================================================
// Live JS Debugger & Live Editor
// ============================================================================

export interface DebuggerScriptInfo {
  scriptId: string
  url: string
  startLine: number
  endLine: number
  isModule?: boolean
  sourceMapURL?: string
}

export interface DebuggerBreakpoint {
  breakpointId: string
  url: string
  lineNumber: number
  columnNumber?: number
  condition?: string
}

export interface DebuggerScopeVariable {
  name: string
  type: string
  value: string
  scopeType: string
}

export interface DebuggerCallFrame {
  callFrameId: string
  functionName: string
  url: string
  lineNumber: number
  columnNumber: number
  variables?: DebuggerScopeVariable[]
}

export interface DebuggerPausedState {
  paused: boolean
  reason?: string
  callFrames: DebuggerCallFrame[]
}

// ============================================================================
// Performance, Web Vitals & Memory
// ============================================================================

export interface WebVitalsResult {
  lcpMs?: number
  cls?: number
  inpMs?: number
  fcpMs?: number
  ttfbMs?: number
  domContentLoadedMs?: number
  loadEventMs?: number
}

export interface PerformanceMetricsResult {
  url: string
  webVitals: WebVitalsResult
  cdpMetrics: Record<string, number>
  heapUsedMB?: number
  heapTotalMB?: number
  domNodes?: number
  jsEventListeners?: number
  layoutCount?: number
  recalcStyleCount?: number
}

export interface TraceInsightResult {
  durationMs: number
  totalEvents: number
  longTasks: Array<{ name: string; durationMs: number; startMs: number; category: string }>
  categoryBreakdownMs: Record<string, number>
  topFunctions?: Array<{ name: string; selfMs: number; totalMs: number }>
  warnings: string[]
}

export interface HeapSummaryResult {
  usedJSHeapSizeMB: number
  totalJSHeapSizeMB: number
  heapSizeLimitMB: number
  domNodes: number
  documents: number
  jsEventListeners: number
  detachedNodeEstimate?: number
  topConstructors?: Array<{ name: string; count: number; selfSizeBytes: number }>
}

// ============================================================================
// Sessions, Action Feedback & Recording
// ============================================================================

export interface SessionInfo {
  id: string
  tabGroup: string
  tabGroupColor: TabGroupColor
  stateKeys: string[]
  activeTabId?: number
  createdAt: number
  lastUsedAt: number
}

export interface ActionFeedback {
  url: string
  title: string
  newConsoleErrors: ConsoleEntry[]
  newFailedRequests: NetworkEntry[]
  openedTabIds?: number[]
  openedTabs?: Array<{ tabId: number; url: string; title: string }>
  dialogs?: Array<{ type: string; message: string; url?: string; handled?: boolean }>
}

export interface RecordingOptions {
  outputPath: string
  frameRate?: number
  maxWidth?: number
  maxHeight?: number
  quality?: number
  maxDurationMs?: number
  showGhostCursor?: boolean
  /** Tap page <audio>/<video>/AudioContext into the recorded video (default false) */
  audio?: boolean
}

export interface RecordingResult {
  path: string
  durationMs: number
  frameCount: number
  sizeBytes: number
  actionTimestamps: number[]
  hasAudio?: boolean
}

export interface DownloadEntry {
  id: string
  url: string
  suggestedFilename: string
  filePath?: string
  state: 'in_progress' | 'completed' | 'canceled'
  receivedBytes: number
  totalBytes?: number
  startedAt: number
  completedAt?: number
}

export type RecordedActionType =
  | 'navigate'
  | 'click'
  | 'dblclick'
  | 'check'
  | 'uncheck'
  | 'fill'
  | 'select_option'
  | 'press_key'
  | 'scroll'
  | 'assert_visible'
  | 'assert_text'
  | 'assert_value'

export type CodegenFormat = 'browserpilot' | 'playwright' | 'batch' | 'skill'

export interface RecordedStep {
  timestamp: number
  action: RecordedActionType
  url: string
  target?: string
  value?: string
  key?: string
  text?: string
  coordinates?: { x: number; y: number }
}

export interface ActionRecordingResult {
  durationMs: number
  steps: RecordedStep[]
  apiCalls?: Array<{ timestamp: number; method: string; url: string; status?: number }>
  errors?: Array<{ timestamp: number; kind: 'console' | 'exception' | 'dialog'; text: string }>
  batchSteps: Array<Record<string, unknown>>
  execScript: string
  playwrightScript: string
  skillMarkdown: string
}

// ============================================================================
// Execution Trace Recorder & Interactive Trace Viewer
// ============================================================================

export interface TraceNetworkEntry extends NetworkEntry {
  responseBodyPreview?: string
}

export interface TraceStep {
  index: number
  id: string
  action: string
  title: string
  startedAt: number
  endedAt: number
  durationMs: number
  status: 'ok' | 'error'
  error?: string
  urlBefore: string
  urlAfter: string
  pageTitle?: string
  target?: string
  value?: string
  key?: string
  point?: { x: number; y: number }
  box?: BoundingBox
  viewport?: { width: number; height: number }
  beforeScreenshot?: string
  afterScreenshot?: string
  domSummary?: string
  consoleEntries: ConsoleEntry[]
  networkEntries: TraceNetworkEntry[]
}

export interface TraceData {
  version: 1
  browserPilotVersion: string
  title: string
  startedAt: number
  endedAt: number
  durationMs: number
  initialUrl: string
  finalUrl: string
  tabId: number
  viewport?: { width: number; height: number }
  steps: TraceStep[]
  totalErrors: number
  totalNetworkRequests: number
  playwrightScript: string
  execScript: string
}

export interface TraceStopResult {
  path?: string
  viewerUrl?: string
  durationMs: number
  stepCount: number
  errorCount: number
  networkCount: number
  sizeBytes: number
}
