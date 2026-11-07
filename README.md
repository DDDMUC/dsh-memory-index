# dsh-memory-index

**不用模型的长期记忆。** 从 DeepSeek Harness 的会话日志里按规则抽出**发生过的事实**——跑过的命令、碰过的文件、遇到的错误、用户明确说过的决定、链接、待办——写进一份可以直接 `grep` 的 JSON 索引。

LLM 摘要负责「这一段讲了什么」；这个插件负责「确切发生过什么」。它**不调用任何模型**，所以可重放、可审计、零成本，也不会把事实改写成另一种说法。

## 它做什么

| 类型 | 来源 | 例子 |
|---|---|---|
| `command` | bash / exec 类工具调用 | `git status` |
| `file` | read / write / edit / grep 类工具的路径参数 | `src/a.js` |
| `link` | 文本里的 URL、web_fetch 的目标 | `https://…` |
| `error` | 标记为错误、或以 error/fatal/failed 开头的结果 | `fatal: not a repo` |
| `decision` | 用户消息里含「决定/改成/结论/let's/decide…」的句子 | `我们决定就这样做` |
| `todo` | 用户消息里 `- [ ]` / TODO / 待办 开头的行 | `- [ ] 补测试` |

去重、按类限量（每会话每类 200 条），全局一份索引：

```
~/.dsh/dsh-memory-index/index.json
```

## 接口（仅本机）

```
GET  /api/dsh-memory-index/state?sessionId=&limit=   索引规模 + 条目
GET  /api/dsh-memory-index/search?q=&limit=          跨会话检索（子串、多词全命中）
POST /api/dsh-memory-index/rebuild                   重新扫描（后台）
```

## 界面

设置 → 插件 → 本插件：类型统计、最近条目、检索框、「重建索引」。

## 边界

- 只抽**确定性**事实，不生成摘要；要「理解」还是得靠模型；
- 扫描有大小门槛（16 KB）与数量上限（200 份，按修改时间倒序）；
- 索引是派生数据：坏了删掉重建即可，不影响会话日志。

## 安装

```
dsh plugin add dsh-memory-index
```

或写进 profile 的 bundles。
