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

export interface ExtensionConfig {
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
}

export interface ActivityLogEntry {
  id: string
  timestamp: number
  tabId?: number
  action: string
  detail?: string
  status: 'ok' | 'error' | 'info'
  durationMs?: number
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
  /** Include non-interactive text/structure nodes (default true) */
  includeText?: boolean
  /** Maximum depth to traverse (default 40) */
  maxDepth?: number
  /** Include iframe subtrees (default true) */
  includeIframes?: boolean
}

export interface SnapshotResult {
  url: string
  title: string
  text: string
  isDiff: boolean
  totalRefs: number
  refs: Record<string, RefTarget>
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
}

export interface RecordingOptions {
  outputPath: string
  frameRate?: number
  maxWidth?: number
  maxHeight?: number
  quality?: number
  maxDurationMs?: number
  showGhostCursor?: boolean
}

export interface RecordingResult {
  path: string
  durationMs: number
  frameCount: number
  sizeBytes: number
  actionTimestamps: number[]
}
