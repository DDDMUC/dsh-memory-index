// dsh-memory-index —— 长程记忆的「非 LLM」版本。
//
// 它不生成摘要，只做三件确定性的事：
//   1. 用规则从会话日志里抽事实：改过哪些文件、跑过哪些命令、遇到哪些错误、
//      用户明确说过的决定、链接、待办；
//   2. 存成一份可直接 grep 的 JSON 索引（`~/.dsh/dsh-memory-index/index.json`）；
//   3. 提供本机只读路由给界面和其它插件查（state / search / rebuild）。
//
// 与 LLM 摘要的分工：摘要负责「这一段到底讲了什么」，这里负责「确切发生过什么」。
// 它不调模型，所以可重放、可审计、零成本，也不会把事实改写成另一种说法。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractEntries } from './extract.js'
import { flattenEntries, putSession, readIndex, searchEntries, writeIndex } from './store.js'
import { readLogAsync } from './vendor-compact-session.mjs'

/** 插件版本。 */
export const PLUGIN_VERSION = '0.1.0'
/** 路由前缀。 */
const ROUTE_PREFIX = '/api/dsh-memory-index'
/** 启动后多久开始扫（让首屏先加载）。 */
const BOOT_SCAN_DELAY_MS = 5000
/** 小于这个体积的日志不扫（大多是空会话）。 */
const MIN_BYTES = 16 * 1024
/** 一次最多扫多少份日志（按 mtime 倒序）。 */
const MAX_LOGS = 200

/** 会话根目录。 */
function sessionsRoot() {
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/**
 * 列出候选日志（只读、跳过备份与暂存文件）。
 *
 * @returns {{ file: string, mtimeMs: number, size: number }[]} 日志列表，按 mtime 倒序。
 */
export function listLogs(root = sessionsRoot()) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (entry.name !== 'session.v4.jsonl.zstd') continue
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.size < MIN_BYTES) continue
      out.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }
  walk(root, 0)
  out.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return out.slice(0, MAX_LOGS)
}

/**
 * 扫一份日志并写进索引。
 *
 * @param {object} index - 索引（原地改）。
 * @param {string} file - 日志路径。
 * @returns {{ sessionId: string, entries: number }|null} 结果。
 */
export async function indexOne(index, file) {
  const sessionId = path.basename(path.dirname(file))
  try {
    const log = await readLogAsync(file)
    putSession(index, sessionId, extractEntries(log.events))
    return { sessionId, entries: index.sessions[sessionId]?.entries.length ?? 0 }
  } catch {
    return null
  }
}

/**
 * 扫一遍全部会话。
 *
 * @param {{ root?: string }} [options] - 根目录。
 * @returns {Promise<{ scanned: number, failed: number }>} 结果。
 */
export async function scanAll(options = {}) {
  const index = readIndex()
  const logs = listLogs(options.root ?? sessionsRoot())
  let scanned = 0
  let failed = 0
  for (const log of logs) {
    const result = await indexOne(index, log.file)
    if (result === null) failed += 1
    else scanned += 1
  }
  writeIndex(index)
  return { scanned, failed }
}

/** 只放行本机请求。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 发送 JSON。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

/** 汇总索引的统计。 */
export function stats(index) {
  const counts = {}
  for (const entry of flattenEntries(index)) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
  return { sessions: Object.keys(index.sessions).length, entries: flattenEntries(index).length, counts }
}

/**
 * 插件入口。
 *
 * @param {object} ctx - cordis 上下文。
 */
export function apply(ctx) {
  const logger = ctx.logger ?? {}
  const state = { running: false, last: null }

  const run = async () => {
    if (state.running) return state.last
    state.running = true
    try {
      state.last = await scanAll()
      if (typeof logger.info === 'function') logger.info(`[dsh-memory-index] 索引 ${state.last.scanned} 个会话`)
      return state.last
    } finally {
      state.running = false
    }
  }

  // 启动后自己扫一遍。
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      await new Promise((resolve) => setTimeout(resolve, BOOT_SCAN_DELAY_MS))
      if (cancelled) return
      try {
        await run()
      } catch (error) {
        if (!cancelled && typeof logger.warn === 'function') logger.warn(`[dsh-memory-index] 扫描失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  })

  const registerRoutes = (webServer, fiber) => {
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/state`,
        handler: (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
          const index = readIndex()
          const url = new URL(req.url, 'http://127.0.0.1')
          const sessionId = url.searchParams.get('sessionId')
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 40))
          const entries = sessionId === null || sessionId === ''
            ? flattenEntries(index).slice(-limit)
            : (index.sessions[sessionId]?.entries ?? []).slice(-limit)
          return sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, running: state.running, last: state.last, stats: stats(index), sessionId: sessionId ?? null, entries })
        },
      }),
    )
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/search`,
        handler: (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' })
          const url = new URL(req.url, 'http://127.0.0.1')
          const query = url.searchParams.get('q') ?? ''
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
          return sendJson(res, 200, { ok: true, query, hits: searchEntries(readIndex(), query, limit) })
        },
      }),
    )
    fiber.effect(() =>
      webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/rebuild`,
        handler: async (req, res) => {
          if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
          if (state.running) return sendJson(res, 200, { ok: true, started: false, busy: true })
          void run().catch(() => {})
          return sendJson(res, 200, { ok: true, started: true })
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer !== undefined && webServer !== null) registerRoutes(webServer, ctx)
  else if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
}
