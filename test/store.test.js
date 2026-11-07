import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { flattenEntries, indexPath, putSession, readIndex, searchEntries, writeIndex } from '../lib/store.js'

test('索引：写入、读回、按会话替换', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-'))
  const index = readIndex(home)
  putSession(index, 'session-a', [{ kind: 'command', text: 'git status', seq: 1 }])
  putSession(index, 'session-b', [{ kind: 'file', text: 'src/b.js', seq: 2 }])
  writeIndex(index, home)
  assert.ok(fs.existsSync(indexPath(home)))
  const back = readIndex(home)
  assert.equal(back.sessions['session-a'].entries.length, 1)
  assert.equal(flattenEntries(back).length, 2)

  putSession(back, 'session-a', [{ kind: 'command', text: 'git log', seq: 3 }])
  writeIndex(back, home)
  const again = readIndex(home)
  assert.equal(again.sessions['session-a'].entries[0].text, 'git log', '同一会话整体替换')
})

test('索引：坏文件当成空索引', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-'))
  fs.mkdirSync(path.dirname(indexPath(home)), { recursive: true })
  fs.writeFileSync(indexPath(home), '{oops')
  assert.deepEqual(readIndex(home).sessions, {})
})

test('检索：多词全命中、大小写不敏感、限量', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-'))
  const index = readIndex(home)
  putSession(index, 's1', [
    { kind: 'command', text: 'git status --short', seq: 1 },
    { kind: 'command', text: 'npm test', seq: 2 },
  ])
  assert.equal(searchEntries(index, 'GIT status').length, 1)
  assert.equal(searchEntries(index, 'git npm').length, 0)
  assert.equal(searchEntries(index, '').length, 0)
  assert.equal(searchEntries(index, 'command', 1).length <= 1, true)
})
