import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyze, candidatePairs, detectIdRefs, detectRefArchived, detectStale, detectTopicPairs,
  main, parseMemoryText, renderMarkdown, scanDir, toolIdOf,
} from '../skills/memory-consolidate/scripts/scan_memory.mjs'

// v2（档1 改造，2026-10-31）新增契约：工具 id 一致 / 确定性通道 / 稀疏候选 / 体检单渲染。

const mk = (t, meta = { track: 'memory' }) => parseMemoryText(t, meta)[0]
const withId = (e) => {
  e.toolId = toolIdOf(e)
  return e
}

test('toolIdOf：与插件 legacyIdFor 同规则（sha1(空白折叠 + trim 全文) 前 8 位）', () => {
  const raw = '[2026-10-03] 订正·涨停排除「舍入缝隙」的真实机制'
  const e = mk(raw)
  const expect = createHash('sha1').update(raw).digest('hex').slice(0, 8)
  assert.equal(toolIdOf(e), expect)
  // 内部空白折叠：多个空格/换行折叠成单空格后再哈希
  const multiline = mk('[2026-10-03] 甲   乙\n丙')
  const expect2 = createHash('sha1').update('[2026-10-03] 甲 乙 丙').digest('hex').slice(0, 8)
  assert.equal(toolIdOf(multiline), expect2)
  // 头部 [id:…] 优先
  assert.equal(toolIdOf(mk('[id:deadbeef] [2026-10-03] x')), 'deadbeef')
})

test('detectIdRefs：按引用语境分「覆盖类 / 关联类 / 弱引用」', () => {
  const target = withId(mk('[2026-09-01] 旧结论：收益来自日内'))
  const id = target.toolId
  const overwrite = withId(mk('[2026-10-01] 订正 ' + id + '：实测收益几乎全来自隔夜'))
  const related = withId(mk('[2026-10-02] 相关细节可参考 ' + id))
  const weak = withId(mk('[2026-10-03] 顺带提到 ' + id + ' 这个名字'))
  const edges = detectIdRefs([target, overwrite, related, weak])
  assert.equal(edges.length, 3)
  assert.deepEqual(edges.map((x) => x.reasons[0]).sort(), ['idref', 'idref-weak', 'related'])
})

test('candidatePairs：倒排候选与全对余弦一致（真边不漏）', () => {
  const X = 'skill_manage create 走待确认队列，采纳时整目录 rename 进技能库'
  const entries = [
    mk('[2026-09-01] ' + X),
    mk('[2026-09-02] ' + X),
    mk('[2026-09-03] 前端 vite 构建产物部署到静态托管'),
  ]
  const { pairs } = candidatePairs(entries, { threshold: 0.42 })
  assert.equal(pairs.length, 1)
  assert.ok(pairs[0].sim > 0.9)
})

test('detectStale / detectTopicPairs / detectRefArchived', () => {
  const stale = detectStale(
    [mk('[2026-01-01] 该服务目前正在灰度，待确认后放量'), mk('[2026-10-30] 该服务目前正在灰度，待确认后放量')],
    { days: 60, now: Date.parse('2026-10-31') },
  )
  assert.equal(stale.length, 1)
  assert.equal(stale[0].matched, '目前')
  const topic = detectTopicPairs(
    [mk('[2026-08-01] 【ETF 动量腿·波动率目标复跑定论】结论甲'), mk('[2026-10-01] 【ETF 动量腿·波动率目标定论】结论乙')],
    { minSpan: 14 },
  )
  assert.ok(topic.length >= 1)
  const arch = withId(mk('[2026-07-01] 已归档旧条：qfq_a 9 月残缺'))
  const live = withId(mk('[2026-08-01] 订正 ' + arch.toolId + '：已修复'))
  const refArch = detectRefArchived([live], [arch])
  assert.equal(refArch.length, 1)
  assert.equal(refArch[0].archivedId, arch.toolId)
})

test('analyze + renderMarkdown：默认排除 project-log，体检单含三档与可复制命令', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memmd-'))
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '[2026-09-01] 重复条目用于体检单\n§\n[2026-09-02] 重复条目用于体检单\n')
    writeFileSync(join(dir, 'projects_marker.txt'), 'noop\n')
    const scanned = scanDir(dir)
    const res = analyze(scanned, {})
    assert.equal(res.stats.entries, 2)
    assert.equal(res.clusters.length, 1)
    assert.equal(res.clusters[0].hint, 'duplicate')
    // 报告里的 id 是 memory 工具的短 id（8 位 hex）
    assert.match(res.clusters[0].members[0].id, /^[0-9a-f]{8}$/)
    const md = renderMarkdown(
      { dir, stats: { files: 1, ...res.stats }, clusters: res.clusters, stale: res.stale, refArchived: res.refArchived },
      { top: 10 },
    )
    assert.match(md, /记忆体检单/)
    assert.match(md, /第一档/)
    assert.match(md, /memory action=archive/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main CLI：--md 落盘（v2 新增）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memcli2-'))
  try {
    writeFileSync(join(dir, 'MEMORY.md'), '[2026-09-01] 甲\n§\n[2026-09-02] 甲\n')
    const out = join(dir, 'r.json')
    const md = join(dir, 'r.md')
    assert.equal(main(['--dir', dir, '--out', out, '--md', md, '--top', '5']), 0)
    assert.match(renderMarkdown.toString(), /renderMarkdown/)
    assert.ok(md.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
