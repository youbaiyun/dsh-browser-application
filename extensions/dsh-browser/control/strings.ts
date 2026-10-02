/**
 * Bilingual copy for the control page.
 *
 * Chinese is the primary text and English must be complete: the extension is
 * used by people whose dsh UI may be in either language, and a half-translated
 * surface reads as broken. Every string here is static; page- and dsh-supplied
 * values are inserted by `main.ts` with `textContent` and never through this
 * dictionary.
 *
 * @module
 */

import type { UiLocale } from '../src/i18n.ts'

export interface ControlCopy {
  documentTitle: string
  brand: string
  /**
   * Connection wording.
   *
   * `Record<BridgeState, string>` plus the extra members, rather than a total
   * record: every connection state must have a label (the index lookup falls
   * back to `stopped`), while `replaced`/`reclaim` describe a condition that is
   * not a state and would be misleading as one.
   */
  bridge: Record<'connecting' | 'connected' | 'reconnecting' | 'stopped', string> & {
    /** Another browser holds the single bridge slot. */
    replaced: string
    reclaim: string
  }
  tab: {
    none: string
    controlled: string
    handoffTitle: string
    handoffText: string
    keep: string
    follow: string
    keepAlways: string
    lostTitle: string
    lostText: string
    bind: string
    bindFailed: string
  }
  approval: {
    askRead: string
    askAction: string
    origins: string
    unknownOrigin: string
    deny: string
    allowOnce: string
    alwaysAllowReads: string
    trustSession: string
  }
  timeline: {
    request: string
    step: string
    result: string
    tool: string
  }
  composer: {
    placeholder: string
    send: string
    sending: string
    stop: string
    commandBadge: string
    askBadge: string
    unavailable: string
    openHint: string
    disconnected: string
  }
  settings: {
    heading: string
    openPages: string
    openPagesOn: string
    openPagesOff: string
    openPagesOnHelp: string
    openPagesOffHelp: string
    openPagesUnknown: string
    sharing: string
    sharingAsk: string
    sharingAuto: string
    sharingOff: string
    sharingHelp: string
    tabSwitch: string
    tabSwitchFollow: string
    tabSwitchKeep: string
    tabSwitchAsk: string
    tabSwitchHelp: string
    conversation: string
    conversationFresh: string
    conversationPinned: string
    conversationHelp: string
    conversationPick: string
    conversationLoading: string
    conversationNone: string
    conversationUntitled: string
    autoOpen: string
    autoOpenHelp: string
    unrestricted: string
    unrestrictedHelp: string
    widthHint: string
  }
  empty: {
    title: string
  }
  common: {
    reconnecting: string
    reconnectFailed: string
    close: string
    working: string
  }
}

const ZH: ControlCopy = {
  documentTitle: 'dsh 浏览器的手与眼',
  brand: 'dsh 浏览器的手与眼',
  bridge: {
    connecting: '正在连接',
    connected: '已连接',
    reconnecting: '正在重连',
    stopped: '未连接',
    replaced: '连接被另一个浏览器窗口接管了。要在这个窗口用，点下面取回来；不用那个窗口的话，建议把它的扩展关掉。',
    reclaim: '取回连接',
  },
  tab: {
    none: '未选择页面',
    controlled: 'AI 正在操作的页面',
    handoffTitle: '你换了标签页',
    handoffText: 'AI 已暂停。留在原来的页面，还是跟着你换过去？',
    keep: '留在原页面',
    follow: '跟过去',
    keepAlways: '留在这里，不再问',
    lostTitle: '操作的页面被关闭了',
    lostText: 'AI 已暂停。选一个页面让它继续，或者先不管。',
    bind: '用我现在这个页面',
    bindFailed: '无法接管这个页面',
  },
  approval: {
    askRead: 'AI 想读取这个页面',
    askAction: 'AI 想操作这个页面',
    origins: '网站',
    unknownOrigin: '未知网站',
    deny: '不允许',
    allowOnce: '允许',
    alwaysAllowReads: '以后读取不用问',
    trustSession: '这个网站以后不用问',
  },
  timeline: {
    request: '你的指令',
    step: '步骤',
    result: '结果',
    tool: '工具',
  },
  composer: {
    placeholder: '输入要做什么',
    send: '发送',
    sending: '发送中',
    stop: '停止',
    commandBadge: '浏览器命令',
    askBadge: '交给 AI',
    unavailable: '无法发送',
    openHint: '@open 网页地址（可加 pace=slow 让它慢一点、pin=off 不接管页面）',
    disconnected: '还没连上桌面端 —— 先把桌面端打开，再重新打开这个侧边栏',
  },
  settings: {
    heading: '更改设置',
    openPages: 'AI 能打开网页',
    openPagesOn: '已连接',
    openPagesOff: '未连接',
    openPagesOnHelp: '需要给你看页面时，它直接打开，不先问你。开关在桌面端，这里改不了。',
    openPagesOffHelp: '它不会打开新网页，只能读你已经打开的页面。',
    openPagesUnknown: '还没连上桌面端。先启动桌面端，再重新打开侧边栏。',
    sharing: '让 AI 读取网页',
    sharingAsk: '每次询问',
    sharingAuto: '直接读取',
    sharingOff: '从不',
    sharingHelp: '它读你正在看的网页之前，会不会先问你。选「从不」，网页内容不会离开浏览器。',
    tabSwitch: 'AI 跟随标签页',
    tabSwitchFollow: '跟随',
    tabSwitchKeep: '留在原页面',
    tabSwitchAsk: '每次询问',
    tabSwitchHelp: '你换到别的标签页，它跟不跟过去。选「每次询问」，会弹出来让你决定。',
    conversation: '对话发到',
    conversationFresh: '新开一段',
    conversationPinned: '当前对话',
    conversationHelp: '你在这里打的话，发到桌面端哪段对话。选「当前对话」，再从下面挑一段。',
    conversationPick: '选择对话',
    conversationLoading: '正在读取…',
    conversationNone: '请选择…',
    conversationUntitled: '未命名',
    autoOpen: '自动弹出侧边栏',
    autoOpenHelp: '它一动浏览器，这边就自己弹出来。你能实时看到它在找什么、下什么、点哪里。平常聊天不弹。',
    unrestricted: '不再询问，直接操作',
    unrestrictedHelp: '读网页、点按钮、关标签页，都不再问你。不确定它在做什么就别开。',
    widthHint: '宽度由浏览器决定，拖左边缘调整，Chrome 会记住。',
  },
  empty: {
    title: '准备就绪',
  },
  common: {
    reconnecting: '正在重连后台',
    reconnectFailed: '后台连接已断开，请重新加载页面',
    close: '关闭',
    working: '进行中',
  },
}

const EN: ControlCopy = {
  documentTitle: 'dsh Browser Hand & Eye',
  brand: 'dsh Browser Hand & Eye',
  bridge: {
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    stopped: 'Not connected',
    replaced: 'Another browser window took over the connection. Take it back with the button below, or turn that window\'s extension off if you are not using it.',
    reclaim: 'Take it back',
  },
  tab: {
    none: 'No page selected',
    controlled: 'The page the AI is using',
    handoffTitle: 'You switched tabs',
    handoffText: 'The AI has paused. Stay on the original page, or follow you to this one?',
    keep: 'Stay on the page',
    follow: 'Follow me',
    keepAlways: 'Stay here, stop asking',
    lostTitle: 'The page being used was closed',
    lostText: 'The AI has paused. Pick a page for it to continue on, or leave it for now.',
    bind: 'Use the page I am on',
    bindFailed: 'Could not take over this page',
  },
  approval: {
    askRead: 'Wants to read this page',
    askAction: 'Wants to change this page',
    origins: 'Website',
    unknownOrigin: 'Unknown website',
    deny: 'Don\'t allow',
    allowOnce: 'Allow',
    alwaysAllowReads: 'Never ask about reading',
    trustSession: 'Never ask about this website',
  },
  timeline: {
    request: 'Your instruction',
    step: 'Step',
    result: 'Result',
    tool: 'Tool',
  },
  composer: {
    placeholder: 'What should happen?',
    send: 'Send',
    sending: 'Sending',
    stop: 'Stop',
    commandBadge: 'Browser command',
    askBadge: 'Ask the model',
    unavailable: 'Cannot send',
    openHint: '@open <url> [pace=fast|normal|slow] [pin=on|off] — the extension opens it so you can watch',
    disconnected: 'dsh is not connected — start the desktop app, then reopen this panel',
  },
  settings: {
    heading: 'Change settings',
    openPages: 'AI can open web pages',
    openPagesOn: 'Connected',
    openPagesOff: 'Not connected',
    openPagesOnHelp: 'It opens a page directly when it needs to show you one, without asking. The switch is in the desktop app and cannot be changed here.',
    openPagesOffHelp: 'It will not open new pages, only read the ones you already have open.',
    openPagesUnknown: 'Not connected to the desktop app. Start it, then reopen this panel.',
    sharing: 'Let the AI read pages',
    sharingAsk: 'Ask me',
    sharingAuto: 'Read directly',
    sharingOff: 'Never',
    sharingHelp: 'Whether it asks before reading the page you are on. Set it to "Never" and page content does not leave the browser.',
    tabSwitch: 'AI follows tab switches',
    tabSwitchFollow: 'Follow',
    tabSwitchKeep: 'Stay on the page',
    tabSwitchAsk: 'Ask me',
    tabSwitchHelp: 'Whether it comes with you when you switch tabs. "Ask me" pops up a choice each time.',
    conversation: 'Send messages to',
    conversationFresh: 'A new chat',
    conversationPinned: 'Current chat',
    conversationHelp: 'Which desktop conversation receives what you type here. Pick "Current chat", then choose one below.',
    conversationPick: 'Choose a conversation',
    conversationLoading: 'Reading…',
    conversationNone: 'Choose one…',
    conversationUntitled: 'Untitled',
    autoOpen: 'Open the side panel automatically',
    autoOpenHelp: 'The panel opens while it uses the browser, so you can watch what it searches, downloads and clicks. Ordinary chat does not open it.',
    unrestricted: 'Stop asking and just act',
    unrestrictedHelp: 'Reading pages, clicking buttons and closing tabs all happen without asking you. Do not turn this on unless you know what it is doing.',
    widthHint: 'The browser decides the width; drag the left edge, and Chrome remembers it.',
  },
  empty: {
    title: 'Ready',
  },
  common: {
    reconnecting: 'Reconnecting to the background',
    reconnectFailed: 'The background connection is gone; reload this panel',
    close: 'Close',
    working: 'Working',
  },
}

export function controlCopy(locale: UiLocale): ControlCopy {
  return locale === 'zh' ? ZH : EN
}
