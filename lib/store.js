/**
 * 记忆索引的持久化：一份 JSON，按会话存规则抽取出来的条目。
 *
 * 为什么不放数据库：条目本来就是从日志里重算出来的派生数据，坏了删掉重建即可；
 * JSON 可以直接看、直接 grep，也方便别的插件读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 索引版本；结构变了就 +1，读者据此决定认不认。 */
export const INDEX_VERSION = 1

/** 索引文件路径。 */
export function indexPath(home = os.homedir()) {
  return path.join(home, '.dsh', 'dsh-memory-index', 'index.json')
}

/**
 * 读索引；不存在或坏掉时返回空索引。
 *
 * @param {string} [home] - 家目录（测试用）。
 * @returns {{ version: number, sessions: Record<string, object> }} 索引。
 */
export function readIndex(home = os.homedir()) {
  const empty = { version: INDEX_VERSION, sessions: {} }
  let raw
  try {
    raw = fs.readFileSync(indexPath(home), 'utf8')
  } catch {
    return empty
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return empty
    const sessions = parsed.sessions !== null && typeof parsed.sessions === 'object' ? parsed.sessions : {}
    return { version: INDEX_VERSION, sessions }
  } catch {
    return empty
  }
}

/**
 * 写回索引（先写临时文件再改名，避免半截文件）。
 *
 * @param {object} index - 索引。
 * @param {string} [home] - 家目录（测试用）。
 * @returns {boolean} 是否写成功。
 */
export function writeIndex(index, home = os.homedir()) {
  const file = indexPath(home)
  const temp = file + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, JSON.stringify({ version: INDEX_VERSION, sessions: index.sessions ?? {} }))
    fs.renameSync(temp, file)
    return true
  } catch {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 清理失败无所谓，下次会覆盖。
    }
    return false
  }
}

/**
 * 把一份会话的条目并进索引（同一会话整体替换，保证幂等）。
 *
 * @param {object} index - 索引（原地修改）。
 * @param {string} sessionId - 会话 id。
 * @param {object[]} entries - 条目。
 * @param {number} [now] - 时间戳（测试用）。
 * @returns {object} 该会话的记录。
 */
export function putSession(index, sessionId, entries, now = Date.now()) {
  const record = { updatedAt: new Date(now).toISOString(), entries: Array.isArray(entries) ? entries : [] }
  index.sessions[sessionId] = record
  return record
}

/** 所有会话的条目带上 sessionId 摊平。 */
export function flattenEntries(index) {
  const out = []
  for (const [sessionId, record] of Object.entries(index.sessions ?? {})) {
    for (const entry of Array.isArray(record?.entries) ? record.entries : []) out.push({ sessionId, ...entry })
  }
  return out
}

/**
 * 按关键词检索条目（子串、大小写不敏感，多词全部命中）。
 *
 * @param {object} index - 索引。
 * @param {string} query - 查询。
 * @param {number} [limit] - 最多返回几条。
 * @returns {object[]} 命中的条目。
 */
export function searchEntries(index, query, limit = 50) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '')
  if (words.length === 0) return []
  const hits = []
  for (const entry of flattenEntries(index)) {
    const haystack = String(entry.text ?? '').toLowerCase()
    if (!words.every((word) => haystack.includes(word))) continue
    hits.push(entry)
    if (hits.length >= limit) break
  }
  return hits
}
