import test from 'node:test'
import assert from 'node:assert/strict'
import { INDEX_TITLE_MAX, buildIndexLines, formatStamp, indexLine, renderMemoryIndexBlock, resolveIndexMode } from '../lib/memory-index.js'

// 逐条索引（B30）：标题 30 字 + 短 id。纯函数，无 IO、无缓存、无聚类。

const entry = (id, date, body) => `[id:${id}] [${date}] ${body}`

test('indexLine：短 id + 标题截断到 30 字，[summary:…] 优先', () => {
  const long = '这是一条很长很长的记忆正文，用来验证标题会被截断到三十个字符以内，不应原样注入'
  const line = indexLine(entry('deadbeef', '2026-10-31', long))
  const prefix = '- [deadbeef] '
  assert.ok(line.startsWith(prefix), '应以短 id 前缀开头，实际：' + line)
  const title = line.slice(prefix.length)
  assert.ok(title.length <= INDEX_TITLE_MAX, '标题长度 ' + title.length + ' 应 ≤ ' + INDEX_TITLE_MAX)
  assert.ok(long.startsWith(title.replace(/…$/, '')))
  // 作者写了 summary 时用 summary，不再二次截断成正文首行
  const withSum = '[id:cafe0001] [2026-10-31] [summary:自定义摘要] 正文首行很长很长很长很长很长很长很长很长很长'
  assert.equal(indexLine(withSum), '- [cafe0001] 自定义摘要')
})

test('buildIndexLines：条数/顺序/字符统计', () => {
  const entries = [entry('00000001', '2026-10-01', '甲'), entry('00000002', '2026-10-02', '乙'), entry('00000003', '2026-10-03', '丙')]
  const r = buildIndexLines(entries)
  assert.equal(r.covered, 3)
  assert.equal(r.lines.length, 3)
  assert.deepEqual(r.lines.map((l) => l.slice(2, 12)), ['[00000001]', '[00000002]', '[00000003]'])
  assert.equal(r.chars, r.lines.reduce((a, l) => a + l.length + 1, 0))
  assert.deepEqual(buildIndexLines([]), { lines: [], covered: 0, chars: 0 })
})

test('renderMemoryIndexBlock：尾行自报覆盖数与新鲜度；空输入返回空串', () => {
  assert.equal(renderMemoryIndexBlock([]), '')
  const block = renderMemoryIndexBlock([entry('00000001', '2026-10-01', '甲')], { stamp: '2026/10/31 21:30' })
  const lines = block.split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[1], /共 1 条/)
  assert.match(lines[1], /更新于 2026\/10\/31 21:30/)
  assert.match(lines[1], /memory expand id=<id>/)
})

test('formatStamp：补零', () => {
  assert.equal(formatStamp(new Date(2026, 0, 5, 3, 7)), '2026/01/05 03:07')
})

test('resolveIndexMode：默认摘要、on 全开、off 优先、项目白名单灰度', () => {
  assert.equal(resolveIndexMode({}), 'summary')
  assert.equal(resolveIndexMode({ env: { DSH_MEMORY_INDEX: 'on' } }), 'index')
  assert.equal(resolveIndexMode({ env: { DSH_MEMORY_INDEX: 'OFF' } }), 'summary')
  assert.equal(resolveIndexMode({ env: { DSH_MEMORY_INDEX: 'on', DSH_MEMORY_INDEX_PROJECTS: 'x' } }), 'index')
  assert.equal(resolveIndexMode({ env: { DSH_MEMORY_INDEX: 'off' } }), 'summary')
  // 白名单按 cwd 的 projectHash 匹配；不传 cwd 时不会误开
  const cwd = '/home/ml88wwqq/workspace'
  assert.equal(resolveIndexMode({ env: { DSH_MEMORY_INDEX_PROJECTS: 'deadbeef' }, cwd }), 'summary')
  const hash = resolveIndexMode({ env: { DSH_MEMORY_INDEX_PROJECTS: '*' }, cwd })
  assert.equal(hash, 'summary')
})
