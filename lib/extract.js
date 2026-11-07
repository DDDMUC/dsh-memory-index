/**
 * 规则抽取：把会话事件变成可检索的记忆条目。
 *
 * 这里**不调用任何模型**：只按事件类型和文本模式抽取确定性事实——
 * 改过哪些文件、跑过哪些命令、遇到过哪些错误、用户明确说过的决定、链接、待办。
 * 好处是可审计、可重放、零成本；代价是覆盖不了"这段话到底什么意思"。
 *
 * @typedef {{ kind: string, text: string, seq: number, time: number|null, turn: number|null }} MemoryEntry
 */

/** 命令类工具名。 */
const COMMAND_TOOLS = new Set(['bash', 'exec_command', 'run_command', 'shell', 'terminal'])
/** 文件类工具名。 */
const FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'str_replace_editor', 'apply_patch', 'create_file', 'grep', 'glob', 'list_directory', 'read_file'])
/** 抓网页的工具名。 */
const FETCH_TOOLS = new Set(['web_fetch', 'fetch', 'download'])

/** 文本里的 URL。 */
const URL_PATTERN = /https?:\/\/[^\s)"'<>\]]+/g
/** 用户明确表态的句式（中英）。 */
const DECISION_PATTERN = /(决定|就这么|改成|定为|方案是|结论是|最终选|不要|必须|应该)|\b(let'?s|decide|decided|final(?:ly)?|we'?ll|should)\b/i
/** 待办行。 */
const TODO_PATTERN = /^\s*(?:[-*]\s*)?(?:\[ \]|TODO|待办|下一步)[:：\s]/i

/** 一条文本最多保留多少字。 */
const MAX_TEXT = 160
/** 每条会话每类最多保留多少条。 */
export const MAX_PER_KIND = 200

/** 取消息内容里的纯文本块。 */
function textOfMessage(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    if (block.type === 'tool-call' && typeof block.name === 'string') parts.push(block.name)
  }
  return parts.join('\n')
}

/** 事件的实际消息体（两种载荷形状都认）。 */
function messageOf(event) {
  const data = event?.data ?? {}
  return data.message ?? data
}

/** 解析工具参数：可能是对象，也可能是 JSON 字符串。 */
function argsOf(event) {
  const args = event?.data?.arguments ?? event?.data?.args ?? event?.data?.input
  if (args !== null && typeof args === 'object') return args
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

/** 从参数里挑出路径/命令这类字符串字段。 */
function pickString(source, keys) {
  for (const key of keys) {
    const value = source?.[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** 拆句：中英文句号、问号、叹号、换行。 */
function sentencesOf(text) {
  return String(text ?? '')
    .split(/[。！？!?\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 6 && line.length <= 240)
}

/** 截断到 MAX_TEXT，超出加省略号。 */
export function clipText(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= MAX_TEXT ? value : value.slice(0, MAX_TEXT - 1) + '…'
}

/**
 * 从一条日志事件里抽条目。
 *
 * @param {object} event - 日志事件。
 * @param {number|null} turn - 当前轮次（由调用方维护）。
 * @returns {MemoryEntry[]} 条目（可能为空）。
 */
export function entriesOfEvent(event, turn) {
  const out = []
  const base = { seq: Number(event?.seq) || 0, time: Number(event?.time) || null, turn }
  const push = (kind, text) => {
    const clipped = clipText(text)
    if (clipped !== '') out.push({ kind, text: clipped, ...base })
  }

  // 1) 工具调用：命令 / 文件 / 链接。
  if (event?.type === 'tool/call') {
    const name = typeof event.data?.name === 'string' ? event.data.name : ''
    const args = argsOf(event)
    if (COMMAND_TOOLS.has(name)) {
      const command = pickString(args, ['command', 'cmd', 'script'])
      if (command !== '') push('command', command)
    } else if (FILE_TOOLS.has(name)) {
      const file = pickString(args, ['file_path', 'path', 'file', 'target', 'pattern'])
      if (file !== '') push('file', file)
    } else if (FETCH_TOOLS.has(name)) {
      const url = pickString(args, ['url', 'href'])
      if (url !== '') push('link', url)
    }
    return out
  }

  // 2) 工具结果：错误。
  if (event?.type === 'tool/result') {
    const message = messageOf(event)
    const text = textOfMessage(message)
    if (message?.isError === true || /^\s*(error|fatal|failed|失败)/i.test(text)) {
      if (text !== '') push('error', text)
    }
    return out
  }

  // 3) 文本消息：链接、决定、待办。
  if (event?.type === 'user/message' || event?.type === 'assistant/message') {
    const message = messageOf(event)
    const text = textOfMessage(message)
    if (text === '') return out
    for (const match of text.match(URL_PATTERN) ?? []) push('link', match)
    const isHuman = event.type === 'user/message' && (message?.source === undefined || message.source?.kind === 'user' || message.source?.kind === '')
    if (isHuman) {
      for (const line of String(text).split('\n')) {
        if (TODO_PATTERN.test(line)) push('todo', line)
      }
      for (const sentence of sentencesOf(text)) {
        if (DECISION_PATTERN.test(sentence)) push('decision', sentence)
      }
    }
    return out
  }

  return out
}

/**
 * 从整份事件流里抽记忆条目，按类限量并去重。
 *
 * @param {object[]} events - 会话事件。
 * @returns {MemoryEntry[]} 条目列表（按 seq 升序）。
 */
export function extractEntries(events) {
  const counts = new Map()
  const seen = new Set()
  const out = []
  let turn = null
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) turn = event.data.turn
    for (const entry of entriesOfEvent(event, turn)) {
      const key = entry.kind + '\u0000' + entry.text
      if (seen.has(key)) continue
      const used = counts.get(entry.kind) ?? 0
      if (used >= MAX_PER_KIND) continue
      seen.add(key)
      counts.set(entry.kind, used + 1)
      out.push(entry)
    }
  }
  return out
}
