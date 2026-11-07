import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractEntries, entriesOfEvent, MAX_PER_KIND } from '../lib/extract.js'

/** 造一条事件。 */
const ev = (seq, type, data) => ({ seq, type, time: 1000 + seq, data })

test('抽取：命令、文件、链接、错误、决定、待办', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'tool/call', { name: 'bash', arguments: '{"command":"git status"}' }),
    ev(3, 'tool/call', { name: 'read', arguments: { file_path: 'src/a.js' } }),
    ev(4, 'tool/result', { message: { isError: true, content: [{ type: 'text', text: 'fatal: not a repo' }] } }),
    ev(5, 'user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我们决定就这样做 https://example.com/x\n- [ ] 补测试' }] }),
  ]
  const entries = extractEntries(events)
  const kinds = entries.map((entry) => entry.kind)
  assert.deepEqual([...new Set(kinds)].sort(), ['command', 'decision', 'error', 'file', 'link', 'todo'])
  assert.equal(entries.find((entry) => entry.kind === 'command').text, 'git status')
  assert.equal(entries.find((entry) => entry.kind === 'file').text, 'src/a.js')
  assert.equal(entries.find((entry) => entry.kind === 'link').text, 'https://example.com/x')
})

test('抽取：注入的用户消息不算「人说的决定」', () => {
  const events = [
    ev(1, 'user/message', { role: 'user', source: { kind: 'tool-result' }, content: [{ type: 'text', text: '决定不这么做' }] }),
  ]
  const entries = extractEntries(events)
  assert.equal(entries.some((entry) => entry.kind === 'decision'), false)
})

test('抽取：同一文本只记一次，且按类限量', () => {
  const many = Array.from({ length: MAX_PER_KIND + 20 }, (_, index) =>
    ev(index + 1, 'tool/call', { name: 'bash', arguments: { command: `echo ${index}` } }),
  )
  const entries = extractEntries([...many, ...many])
  const commands = entries.filter((entry) => entry.kind === 'command')
  assert.equal(commands.length, MAX_PER_KIND)
  assert.equal(new Set(commands.map((entry) => entry.text)).size, commands.length)
})

test('抽取：工具参数是坏 JSON 时不崩', () => {
  const entries = entriesOfEvent(ev(1, 'tool/call', { name: 'bash', arguments: '{not json' }), null)
  assert.deepEqual(entries, [])
})

test('抽取：错误结果里的普通输出不算错误', () => {
  const entries = entriesOfEvent(ev(1, 'tool/result', { message: { content: [{ type: 'text', text: 'all good' }] } }), null)
  assert.deepEqual(entries, [])
})
