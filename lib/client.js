// dsh-memory-index —— browser half.
//
// 一张卡：显示索引规模、按类型统计、最近条目，带一个检索框和「重建索引」按钮。
// 全部数据来自本插件自己的只读路由（/api/dsh-memory-index/*），不依赖宿主内部。
window.__ModuleLoader__.load({
  id: 'dsh-memory-index',
  factory: (require) => {
    const react = require('react')
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const ROUTE_PREFIX = '/api/dsh-memory-index'
    const PLUGIN_VERSION = '0.1.0'
    const KIND_LABEL = {
      command: '命令',
      file: '文件',
      link: '链接',
      error: '错误',
      decision: '决定',
      todo: '待办',
    }

    async function call(path, body) {
      const response = await fetch(`${ROUTE_PREFIX}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || data.ok !== true) throw new Error(data.error ? String(data.error) : `HTTP ${response.status}`)
      return data
    }

    const style = {
      card: { display: 'flex', flexDirection: 'column', gap: 10 },
      row: { display: 'flex', alignItems: 'baseline', gap: 8 },
      label: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8f98)', margin: 0 },
      stats: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: { fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.25))', color: 'var(--dsw-alias-label-secondary, #5c6270)' },
      list: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' },
      item: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary, inherit)', overflowWrap: 'anywhere' },
      kind: { color: 'var(--dsw-alias-brand-primary, #4c7dff)', marginRight: 6 },
      input: { flex: 1, minWidth: 120, fontSize: 12, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
      button: { fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
    }

    function MemoryCard() {
      const [data, setData] = react.useState(null)
      const [queryKind, setQueryKind] = react.useState('')
      const [query, setQuery] = react.useState('')
      const [hits, setHits] = react.useState(null)
      const [busy, setBusy] = react.useState('')
      const [error, setError] = react.useState('')
      const [note, setNote] = react.useState('')

      const load = async () => {
        try {
          const next = await call('/state')
          setData(next)
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }

      react.useEffect(() => {
        void load()
      }, [])

      const rebuild = async () => {
        setBusy('rebuild')
        setError('')
        setNote('')
        try {
          const started = await call('/rebuild', {})
          if (started.busy === true) setNote('已经在扫了…')
          for (let attempt = 0; attempt < 120; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 500))
            const next = await call('/state')
            if (next.running !== true) {
              setData(next)
              setNote(`索引了 ${next.last?.scanned ?? 0} 个会话`)
              return
            }
          }
        } catch (failure) {
          setError(String(failure.message || failure))
        } finally {
          setBusy('')
        }
      }

      const search = async () => {
        const text = query.trim()
        if (text === '') {
          setHits(null)
          return
        }
        try {
          const result = await call(`/search?q=${encodeURIComponent(text)}`)
          setHits(result.hits ?? [])
        } catch (failure) {
          setError(String(failure.message || failure))
        }
      }

      const counts = data?.stats?.counts ?? {}
      const entries = (hits ?? data?.entries ?? []).slice(-40).reverse()

      return react.createElement('div', { style: style.card }, [
        react.createElement('div', { key: 'head', style: style.row }, [
          react.createElement('span', { key: 'l', style: style.label }, '记忆索引（规则抽取，不调用模型）'),
          react.createElement('span', { key: 'v', style: style.hint }, `v${PLUGIN_VERSION}`),
        ]),
        react.createElement('p', { key: 'hint', style: style.hint }, '从会话日志里抽命令、文件、错误、决定、链接、待办；存在 ~/.dsh/dsh-memory-index/index.json，可 grep、可被其它插件读。'),
        react.createElement('div', { key: 'stats', style: style.stats },
          [
            react.createElement('span', { key: 'sessions', style: style.chip }, `${data?.stats?.sessions ?? 0} 个会话`),
            react.createElement('span', { key: 'entries', style: style.chip }, `${data?.stats?.entries ?? 0} 条记忆`),
            ...Object.entries(counts).map(([kind, value]) =>
              react.createElement('span', { key: kind, style: style.chip }, `${KIND_LABEL[kind] ?? kind} ${value}`),
            ),
          ]),
        react.createElement('div', { key: 'search', style: style.row }, [
          react.createElement('input', {
            key: 'q',
            style: style.input,
            placeholder: '检索：命令 / 文件 / 关键词…',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void search()
            },
          }),
          react.createElement('button', { key: 'go', type: 'button', style: style.button, onClick: () => void search() }, '搜索'),
          react.createElement('button', { key: 're', type: 'button', style: style.button, disabled: busy !== '', onClick: () => void rebuild() }, busy === '' ? '重建索引' : '扫描中…'),
        ]),
        note === '' ? null : react.createElement('p', { key: 'note', style: style.hint }, note),
        error === '' ? null : react.createElement('p', { key: 'err', style: { ...style.hint, color: 'var(--dsw-alias-state-error-primary, #d54941)' } }, `出错：${error}`),
        react.createElement('ul', { key: 'list', style: style.list },
          entries.length === 0
            ? [react.createElement('li', { key: 'empty', style: style.hint }, '还没有条目；点「重建索引」。')]
            : entries.map((entry, index) =>
                react.createElement('li', { key: `${entry.kind}-${entry.seq}-${index}`, style: style.item }, [
                  react.createElement('span', { key: 'k', style: style.kind }, KIND_LABEL[entry.kind] ?? entry.kind),
                  react.createElement('span', { key: 't' }, entry.text),
                ]),
              )),
      ])
    }

    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-memory-index' }, () => react.createElement(MemoryCard, {})),
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.ConfigCard = MemoryCard
    exports.PLUGIN_VERSION = PLUGIN_VERSION
    return module.exports
  },
})
