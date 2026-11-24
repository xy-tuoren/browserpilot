export const BROWSERPILOT_VERSION = '1.2.2'
export const CDP_PROTOCOL_VERSION = '1.3'

export const DEFAULT_DAEMON_HOST = '127.0.0.1'
export const DEFAULT_DAEMON_PORT = 19888

export const NATIVE_HOST_NAME = 'com.browserpilot.bridge'
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024 // Chrome Native Messaging 1MB per-message cap

export const EXTENSION_KEEPALIVE_INTERVAL_MS = 20_000
export const DEFAULT_CDP_TIMEOUT_MS = 15_000
export const DEFAULT_ACTION_TIMEOUT_MS = 10_000
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000

export const MAX_CONSOLE_BUFFER = 5_000
export const MAX_NETWORK_BUFFER = 2_000
export const MAX_ACTIVITY_BUFFER = 200

export const DEFAULT_TAB_GROUP_TITLE = 'browserpilot'

export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const

export type TabGroupColor = (typeof TAB_GROUP_COLORS)[number]

/**
 * Profile-wide destructive CDP commands that would wipe cookies/cache across
 * every website in the user's real Chrome profile. Always blocked by default.
 */
export const BLOCKED_PROFILE_WIDE_CDP_COMMANDS = new Set<string>([
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
])

/**
 * URL schemes Chrome prohibits extensions from attaching chrome.debugger to.
 */
export const RESTRICTED_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'brave://',
  'about:blank#blocked',
  'https://chrome.google.com/webstore',
  'https://chromewebstore.google.com',
] as const

export function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false
  const lower = url.toLowerCase()
  return RESTRICTED_URL_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

export function isBlockedProfileWideCommand(method: string): boolean {
  return BLOCKED_PROFILE_WIDE_CDP_COMMANDS.has(method)
}
