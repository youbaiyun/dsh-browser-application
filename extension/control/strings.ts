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
import type { OpenError } from './command.ts'

export interface ControlCopy {
  /**
   * The browser tab's title.
   *
   * The heading a user reads above the panel is **not** drawn by this code: the
   * browser renders the side panel's title from the extension's manifest name, so
   * changing it means editing the locale message files. This field only covers
   * the tab, and both are set to the same full name so the extension does not
   * introduce itself two different ways. A `brand` field used to sit here for a
   * heading that was never built, which made it look as though the heading were
   * ours to change.
   */
  documentTitle: string
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
  plan: {
    title: string
    /** `{done}` and `{total}` are substituted with the counts. */
    progress: string
  }
  composer: {
    placeholder: string
    send: string
    sending: string
    stop: string
    openHint: string
    disconnected: string
  }
  /**
   * Why a typed `@open` directive could not be used.
   *
   * These are functions rather than templates because the two languages order the
   * parts differently — Chinese states the rule and then the offending value,
   * English names the value first — so a string with placeholders substituted
   * would read as translated rather than as written.
   *
   * They live here, and not beside the parser, because a user who chose English
   * must not be answered in Chinese. That is what they used to be: nine messages
   * hard-coded in the parser, so every `@open` mistake reported itself in Chinese
   * whatever language the panel was in.
   */
  openError: {
    directiveFormat: (known: string) => string
    unknownDirective: (directive: string, known: string) => string
    missingUrl: (directive: string) => string
    firstArgumentNotUrl: (directive: string, received: string) => string
    notKeyValue: (pair: string) => string
    paceInvalid: (allowed: string, received: string) => string
    pinInvalid: (received: string) => string
    unknownKey: (key: string) => string
    unparsable: string
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
  /**
   * Marker on a conversation the desktop is working in right now.
   *
   * The single most useful thing the picker can say: the list is long, the titles
   * repeat, and the conversation whose turn is running is nearly always the one the
   * user is looking at. Without it the only signal is a timestamp.
   */
  conversationRunning: string
    autoOpen: string
    autoOpenHelp: string
    unrestricted: string
    unrestrictedHelp: string
    widthHint: string
    visionTier: string
    visionTierHelp: string
    visionTierOff: string
    visionTierLow: string
    visionTierStandard: string
    visionTierEnhanced: string
  }
  empty: {
    title: string
  }
  common: {
    reconnecting: string
    reconnectFailed: string
    close: string
  }
}

const ZH: ControlCopy = {
  documentTitle: 'dsh 浏览器扩展（全端）',
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
    // Names the one action that exists. "Pick a page" implied a chooser, but the
    // button binds the tab you are already on — so the sentence says to switch
    // first, and the button below it does the binding.
    lostText: 'AI 已暂停，不会自作主张换页面。想让它继续，就切到你希望它操作的页面，再点下面的按钮绑定；不管它也行。',
    bind: '用我现在这个页面',
    bindFailed: '无法接管这个页面',
  },
  approval: {
    askRead: 'AI 想读取这个页面',
    askAction: 'AI 想操作这个页面',
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
  plan: {
    title: '任务表',
    progress: '{done}/{total} 已完成',
  },
  composer: {
    placeholder: '输入要做什么',
    send: '发送',
    sending: '发送中',
    stop: '停止',
    openHint: '@open 网页地址（可加 pace=slow 让它慢一点、pin=off 不接管页面）',
    disconnected: '还没连上桌面端 —— 先把桌面端打开，再重新打开这个侧边栏',
  },
  openError: {
    directiveFormat: (known) => `指令格式：${known} <网址> [pace=…] [pin=…]`,
    unknownDirective: (directive, known) => `未知指令 @${directive}，可用：${known}`,
    missingUrl: (directive) => `@${directive} 缺少网址，例如：@${directive} https://example.com`,
    firstArgumentNotUrl: (directive, received) =>
      `@${directive} 的第一个参数必须是网址（http/https 或域名），收到：${received}`,
    notKeyValue: (pair) => `参数要写成 key=value，无法识别：${pair}`,
    paceInvalid: (allowed, received) => `pace 只能是 ${allowed}，收到：${received}`,
    pinInvalid: (received) => `pin 只能是 on / off，收到：${received}`,
    unknownKey: (key) => `未知参数：${key}（可用：pace、pin）`,
    unparsable: '指令无法解析',
  },
  settings: {
    heading: '更改设置',
    openPages: '桌面端允许 AI 打开网页',
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
  conversationRunning: '进行中',
    autoOpen: '自动弹出侧边栏',
    autoOpenHelp: '它一动浏览器，这边就自己弹出来。你能实时看到它在找什么、下什么、点哪里。平常聊天不弹。',
    unrestricted: '不再询问，直接操作',
    unrestrictedHelp: '读网页、点按钮、关标签页，都不再问你。不确定它在做什么就别开。',
    widthHint: '宽度由浏览器决定，拖左边缘调整，Chrome 会记住。',
    visionTier: '看图',
    visionTierHelp: '建议不开：看一张图要多花约一秒，图会离开这台机器发给你配置的模型；关着就完全不读图。开了就是让模型看图——低档说图里有什么，标准档再和页面文字对一下，增强档再问它在页里干什么。同一张图问过一次就不再重复请求，记 24 小时。',
    visionTierOff: '关',
    visionTierLow: '低',
    visionTierStandard: '标准',
    visionTierEnhanced: '增强',
  },
  empty: {
    title: '准备就绪',
  },
  common: {
    reconnecting: '正在重连后台',
    reconnectFailed: '后台连接已断开，请重新加载页面',
    close: '关闭',
  },
}

const EN: ControlCopy = {
  // English has no parenthetical to mirror: the store name is the same phrase,
  // so the short form and the full name are identical here.
  documentTitle: 'dsh Browser Extension',
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
    lostText: 'The AI has paused and will not pick a page on its own. To continue, switch to the page you want it to use, then press the button below to bind it — or leave it for now.',
    bind: 'Use the page I am on',
    bindFailed: 'Could not take over this page',
  },
  approval: {
    askRead: 'Wants to read this page',
    askAction: 'Wants to change this page',
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
  plan: {
    title: 'Task list',
    progress: '{done}/{total} done',
  },
  composer: {
    placeholder: 'What should happen?',
    send: 'Send',
    sending: 'Sending',
    stop: 'Stop',
    openHint: '@open <url> [pace=fast|normal|slow] [pin=on|off] — the extension opens it so you can watch',
    disconnected: 'dsh is not connected — start the desktop app, then reopen this panel',
  },
  openError: {
    directiveFormat: (known) => `Format: ${known} <url> [pace=…] [pin=…]`,
    unknownDirective: (directive, known) => `Unknown directive @${directive}. Available: ${known}`,
    missingUrl: (directive) => `@${directive} needs a URL, for example: @${directive} https://example.com`,
    firstArgumentNotUrl: (directive, received) =>
      `The first @${directive} argument must be a URL (http/https or a domain); got: ${received}`,
    notKeyValue: (pair) => `Options are written key=value; could not read: ${pair}`,
    paceInvalid: (allowed, received) => `pace must be one of ${allowed}; got: ${received}`,
    pinInvalid: (received) => `pin must be on or off; got: ${received}`,
    unknownKey: (key) => `Unknown option: ${key}. Available: pace, pin`,
    unparsable: 'The directive could not be parsed',
  },
  settings: {
    heading: 'Change settings',
    openPages: 'The desktop lets the AI open pages',
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
  conversationRunning: 'running',
    autoOpen: 'Open the side panel automatically',
    autoOpenHelp: 'The panel opens while it uses the browser, so you can watch what it searches, downloads and clicks. Ordinary chat does not open it.',
    unrestricted: 'Stop asking and just act',
    unrestrictedHelp: 'Reading pages, clicking buttons and closing tabs all happen without asking you. Do not turn this on unless you know what it is doing.',
    widthHint: 'The browser decides the width; drag the left edge, and Chrome remembers it.',
    visionTier: 'Look at images',
    visionTierHelp: 'Off means no image is ever looked at, and none leaves this machine. Turning it on costs about a second per new image: that image leaves this machine for the model you configured. Low only says what is in the picture. Standard also checks it against the words on your page and warns you when the two disagree. Enhanced additionally asks what the image is doing on the page. An image you already asked about is answered from a 24-hour memo instead of being looked at again.',
    visionTierOff: 'Off',
    visionTierLow: 'Low',
    visionTierStandard: 'Standard',
    visionTierEnhanced: 'Enhanced',
  },
  empty: {
    title: 'Ready',
  },
  common: {
    reconnecting: 'Reconnecting to the background',
    reconnectFailed: 'The background connection is gone; reload this panel',
    close: 'Close',
  },
}

export function controlCopy(locale: UiLocale): ControlCopy {
  return locale === 'zh' ? ZH : EN
}

/**
 * Turn a directive-parsing failure into a sentence the user can read.
 *
 * The parser reports a reason rather than a message, because it has no locale and
 * because a module that builds its own user-facing sentences cannot be reused for
 * anything else. This is the single place that decides how a reason is worded.
 *
 * An unknown `kind` falls back to the generic message instead of throwing: a
 * newer background build could send a reason this panel has not learned, and
 * failing to explain a typo is not worth a blank panel.
 */
export function describeOpenError(locale: UiLocale, error: OpenError): string {
  const copy = controlCopy(locale).openError
  switch (error.kind) {
    case 'directiveFormat': return copy.directiveFormat(error.known)
    case 'unknownDirective': return copy.unknownDirective(error.directive, error.known)
    case 'missingUrl': return copy.missingUrl(error.directive)
    case 'firstArgumentNotUrl': return copy.firstArgumentNotUrl(error.directive, error.received)
    case 'notKeyValue': return copy.notKeyValue(error.pair)
    case 'paceInvalid': return copy.paceInvalid(error.allowed, error.received)
    case 'pinInvalid': return copy.pinInvalid(error.received)
    case 'unknownKey': return copy.unknownKey(error.key)
    default: return copy.unparsable
  }
}
