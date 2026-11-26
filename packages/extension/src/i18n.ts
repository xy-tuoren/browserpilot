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
  tabRecord: string
  tabSecurity: string
  activeTabsHeading: string
  noTabsShort: string
  activityHeading: string
  waitingCommands: string
  clearActivity: string
  exportFlow: string
  exported: string
  noExportableSteps: string
  errorsHeading: string
  noErrors: string
  networkHeading: string
  noFailedRequests: string
  untitled: string
  tabPrefix: string
  recordStart: string
  recordStop: string
  recordAssert: string
  recordAssertWait: string
  recordClear: string
  recordCopy: string
  recordHeading: string
  recordCodeHeading: string
  recordEmpty: string
  // Security panel
  securityApprovalHeading: string
  approvalOff: string
  approvalHighRisk: string
  approvalStrict: string
  approvalDescOff: string
  approvalDescHighRisk: string
  approvalDescStrict: string
  profileLabelHeading: string
  profileLabelPlaceholder: string
  blockedHeading: string
  allowedHeading: string
  trustedHeading: string
  trustedHint: string
  organizeTabs: string
  organizedTabs: string
  domainInputPlaceholder: string
  addDomain: string
  blockCurrentSite: string
  noDomainsConfigured: string
  allowedDomainsHint: string
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
    tabRecord: '录制',
    tabSecurity: '安全',
    activeTabsHeading: '当前受控标签页',
    noTabsShort: '暂无受控标签页',
    activityHeading: 'AI 实时操作动态',
    waitingCommands: '等待 AI 指令…',
    clearActivity: '清空',
    exportFlow: '导出 flow.json',
    exported: '已导出',
    noExportableSteps: '暂无可导出的操作步骤',
    errorsHeading: '控制台报错与异常',
    noErrors: '暂无控制台报错',
    networkHeading: '失败的网络请求（4xx / 5xx / 被拦截）',
    noFailedRequests: '暂无失败请求',
    untitled: '未命名标签页',
    tabPrefix: '标签页 #',
    recordStart: '开始录制',
    recordStop: '停止录制',
    recordAssert: '+ 断言',
    recordAssertWait: '请点击元素…',
    recordClear: '清空',
    recordCopy: '复制代码',
    recordHeading: '已录制步骤',
    recordCodeHeading: '生成代码',
    recordEmpty: '点击「开始录制」，在当前标签页操作即可实时生成回放代码。',
    securityApprovalHeading: '高危操作二次确认',
    approvalOff: '关闭',
    approvalHighRisk: '仅高危',
    approvalStrict: '严格',
    approvalDescOff: '自动执行所有操作，不弹出页面内审批卡片。',
    approvalDescHighRisk: '涉及付款、转账、删除、提交发布或银行/支付域名时，页面内弹窗确认后再执行。',
    approvalDescStrict: '所有点击、填写、拖拽、提交等写入类操作均需页面内点击确认。',
    profileLabelHeading: '浏览器资料标签（多浏览器路由用）',
    profileLabelPlaceholder: '例如：Work / Personal（可用 --profile 指定）',
    blockedHeading: '禁止接管域名（黑名单）',
    allowedHeading: '仅允许域名（白名单）',
    trustedHeading: '已信任站点（免二次审批）',
    trustedHint: '在页面确认卡片点击「信任本站」后会自动加入此列表，可随时移除。',
    organizeTabs: '整理标签',
    organizedTabs: '已整理',
    domainInputPlaceholder: '例如 *.bank.com 或 example.com',
    addDomain: '添加',
    blockCurrentSite: '禁止当前站点',
    noDomainsConfigured: '暂未配置规则',
    allowedDomainsHint: '留空表示允许所有非黑名单网站；填写后仅允许访问列表中的域名。',
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
    tabRecord: 'Record',
    tabSecurity: 'Security',
    activeTabsHeading: 'Active Controlled Tabs',
    noTabsShort: 'No tabs attached yet.',
    activityHeading: 'Live AI Activity',
    waitingCommands: 'Waiting for agent commands…',
    clearActivity: 'Clear',
    exportFlow: 'Export flow.json',
    exported: 'Exported',
    noExportableSteps: 'No replayable steps yet',
    errorsHeading: 'Console Errors & Exceptions',
    noErrors: 'No console errors captured.',
    networkHeading: 'Failed Network Requests (4xx / 5xx / Blocked)',
    noFailedRequests: 'No failed requests captured.',
    untitled: 'Untitled',
    tabPrefix: 'Tab #',
    recordStart: 'Record',
    recordStop: 'Stop',
    recordAssert: '+ Assert',
    recordAssertWait: 'Click element…',
    recordClear: 'Clear',
    recordCopy: 'Copy Code',
    recordHeading: 'Recorded Steps',
    recordCodeHeading: 'Generated Code',
    recordEmpty: 'Click "Record" and interact with the active tab to generate code live.',
    securityApprovalHeading: 'Action Risk Confirmation',
    approvalOff: 'Off',
    approvalHighRisk: 'High-Risk',
    approvalStrict: 'Strict',
    approvalDescOff: 'Execute actions automatically without in-page approval prompts.',
    approvalDescHighRisk: 'Prompt in-page approval for payments, deletes, publishes, and sensitive domains.',
    approvalDescStrict: 'Require in-page confirmation before every write or click action.',
    profileLabelHeading: 'Browser Profile Label (Multi-Browser Routing)',
    profileLabelPlaceholder: 'e.g. Work / Personal (target with --profile)',
    blockedHeading: 'Blocked Domains (Blocklist)',
    allowedHeading: 'Allowed Domains (Allowlist)',
    trustedHeading: 'Trusted Sites (Skip Approval)',
    trustedHint: 'Sites added via "Trust This Site" on approval cards appear here and can be revoked anytime.',
    organizeTabs: 'Organize Tabs',
    organizedTabs: 'Organized',
    domainInputPlaceholder: 'e.g. *.bank.com or example.com',
    addDomain: 'Add',
    blockCurrentSite: 'Block Current Site',
    noDomainsConfigured: 'No rules configured',
    allowedDomainsHint: 'Leave empty to allow all non-blocked sites; add domains to restrict access exclusively.',
  },
}

export function resolveLang(lang?: ExtensionLanguage): ExtensionLanguage {
  return lang === 'en' ? 'en' : 'zh'
}
