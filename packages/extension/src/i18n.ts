import type { ExtensionLanguage } from '@browserpilot/protocol'

export interface ExtensionMessages {
  statusNative: string
  statusWs: string
  statusPaused: string
  statusOffline: string
  pause: string
  resume: string
  sidePanel: string
  reconnect: string
  themeDark: string
  themeLight: string
  themeTitle: string
  langToggleTitle: string
  settingsTitle: string
  autoAttach: string
  autoAttachTip: string
  highlights: string
  highlightsTip: string
  ghostCursor: string
  ghostCursorTip: string
  groupTabs: string
  groupTabsTip: string
  attachedTabs: string
  detachAll: string
  detach: string
  noAttachedTabs: string
  advancedTitle: string
  blockedDomainsLabel: string
  blockedDomainsPlaceholder: string
  daemonUrlLabel: string
  authTokenLabel: string
  authTokenPlaceholder: string
  save: string
  saved: string
  extIdLabel: string
  copied: string
  // Side panel
  companionTitle: string
  pickElement: string
  tabActivity: string
  tabErrors: string
  tabNetwork: string
  activeTabsHeading: string
  noTabsShort: string
  activityHeading: string
  waitingCommands: string
  errorsHeading: string
  noErrors: string
  networkHeading: string
  noFailedRequests: string
  untitled: string
  tabPrefix: string
}

export const MESSAGES: Record<ExtensionLanguage, ExtensionMessages> = {
  zh: {
    statusNative: '已连接',
    statusWs: 'WS 在线',
    statusPaused: '已暂停',
    statusOffline: '未连接',
    pause: '暂停',
    resume: '恢复',
    sidePanel: '侧边栏',
    reconnect: '重连',
    themeDark: '深色',
    themeLight: '浅色',
    themeTitle: '切换深色 / 浅色外观',
    langToggleTitle: 'Switch to English',
    settingsTitle: '基础设置',
    autoAttach: '自动接管',
    autoAttachTip: 'AI 按需自动连接标签页，无需手动点击',
    highlights: '操作提示',
    highlightsTip: '显示页面光晕边框、控制条与点击高亮',
    ghostCursor: '虚拟光标',
    ghostCursorTip: '显示 AI 移动指针与点击波纹动画',
    groupTabs: '标签分组',
    groupTabsTip: '将受控标签页归入标签组，关闭后自动解组',
    attachedTabs: '受控标签页',
    detachAll: '全部断开',
    detach: '断开',
    noAttachedTabs: '暂无受控标签页，AI 会在需要时自动接管。',
    advancedTitle: '高级设置',
    blockedDomainsLabel: '禁止接管的域名',
    blockedDomainsPlaceholder: '逗号分隔，例如 *.bank.com',
    daemonUrlLabel: '本地服务地址',
    authTokenLabel: '访问令牌（选填）',
    authTokenPlaceholder: '原生模式自动认证，通常留空',
    save: '保存设置',
    saved: '已保存',
    extIdLabel: '扩展 ID',
    copied: '已复制',
    companionTitle: 'BrowserPilot 助手',
    pickElement: '选取元素',
    tabActivity: '动态',
    tabErrors: '报错',
    tabNetwork: '失败请求',
    activeTabsHeading: '当前受控标签页',
    noTabsShort: '暂无受控标签页',
    activityHeading: 'AI 实时操作动态',
    waitingCommands: '等待 AI 指令…',
    errorsHeading: '控制台报错与异常',
    noErrors: '暂无控制台报错',
    networkHeading: '失败的网络请求（4xx / 5xx / 被拦截）',
    noFailedRequests: '暂无失败请求',
    untitled: '未命名标签页',
    tabPrefix: '标签页 #',
  },
  en: {
    statusNative: 'NATIVE',
    statusWs: 'WS LIVE',
    statusPaused: 'PAUSED',
    statusOffline: 'OFFLINE',
    pause: 'Pause',
    resume: 'Resume',
    sidePanel: 'Side Panel',
    reconnect: 'Reconnect',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeTitle: 'Switch Dark / Light Theme',
    langToggleTitle: '切换为简体中文',
    settingsTitle: 'Settings',
    autoAttach: 'Auto-Attach',
    autoAttachTip: 'Attach tabs on demand with zero manual clicks',
    highlights: 'Visual Cues',
    highlightsTip: 'Show page glow border, control pill & click highlights',
    ghostCursor: 'Ghost Cursor',
    ghostCursorTip: 'Show animated pointer & click ripples',
    groupTabs: 'Tab Groups',
    groupTabsTip: 'Group controlled tabs and auto-ungroup on close/detach',
    attachedTabs: 'Active Tabs',
    detachAll: 'Detach All',
    detach: 'Detach',
    noAttachedTabs: 'No active tabs — AI attaches automatically on demand.',
    advancedTitle: 'Advanced',
    blockedDomainsLabel: 'Blocked Domains',
    blockedDomainsPlaceholder: 'Comma-separated, e.g. *.bank.com',
    daemonUrlLabel: 'Daemon URL',
    authTokenLabel: 'Auth Token (optional)',
    authTokenPlaceholder: 'Auto via Native Messaging',
    save: 'Save',
    saved: 'Saved',
    extIdLabel: 'Extension ID',
    copied: 'Copied',
    companionTitle: 'BrowserPilot Companion',
    pickElement: 'Pick Element',
    tabActivity: 'Activity',
    tabErrors: 'Errors',
    tabNetwork: 'Network',
    activeTabsHeading: 'Active Controlled Tabs',
    noTabsShort: 'No tabs attached yet.',
    activityHeading: 'Live AI Activity',
    waitingCommands: 'Waiting for agent commands…',
    errorsHeading: 'Console Errors & Exceptions',
    noErrors: 'No console errors captured.',
    networkHeading: 'Failed Network Requests (4xx / 5xx / Blocked)',
    noFailedRequests: 'No failed requests captured.',
    untitled: 'Untitled',
    tabPrefix: 'Tab #',
  },
}

export function resolveLang(lang?: ExtensionLanguage): ExtensionLanguage {
  return lang === 'en' ? 'en' : 'zh'
}
