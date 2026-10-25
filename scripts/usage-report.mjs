#!/usr/bin/env node
/**
 * 记忆使用统计报告（只读）。
 *
 * 用法：
 *   node scripts/usage-report.mjs [--dir ~/.dsh/memories] [--top 20] [--json]
 *
 * 读 `<memoryDir>/usage.json`（由 lib/memory-usage.js 写入），输出：
 *   ① 覆盖率（多少条目进过注入、多少被定向查过）
 *   ② 「反复注入但从未被查过」——注入预算化（C）的第一批候选
 *   ③ 「被查过最多的条目」
 *   ④ 「被查过但没进注入」（= 靠检索取回，说明注入可以省）
 *   ⑤ 「从未被触及」
 * 只读：不写任何文件、不改任何记忆、不进注入。键→正文的解析走插件的
 * parseEntries + usageKey（与写入端同源），不依赖任何外部索引。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseEntries } from '../lib/store.js'
import { usageKey } from '../lib/memory-usage.js'

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const dir = String(arg('dir', join(homedir(), '.dsh', 'memories')))
const top = Number(arg('top', 20)) || 20
const asJson = arg('json', false) === true

const file = join(dir, 'usage.json')
if (!existsSync(file)) {
  console.error('没有统计文件：' + file + '（先让插件跑一段时间，或确认 --dir 是否正确）')
  process.exit(1)
}
const usage = JSON.parse(readFileSync(file, 'utf8'))
const records = usage.entries ?? {}

/** 键 → 正文前 90 字；键与写入端同源（usageKey）。 */
function resolveTexts() {
  const map = new Map()
  const add = (target, text) => {
    for (const entry of parseEntries(text)) {
      map.set(usageKey(target, entry), String(entry).replace(/\s+/g, ' ').slice(0, 90))
    }
  }
  for (const [name, target] of [['MEMORY.md', 'memory'], ['USER.md', 'user']]) {
    const p = join(dir, name)
    if (existsSync(p)) add(target, readFileSync(p, 'utf8'))
  }
  const projects = join(dir, 'projects')
  if (existsSync(projects)) {
    for (const hash of readdirSync(projects)) {
      for (const [name, target] of [['KEY.md', 'key'], ['MEMORY.md', 'project']]) {
        const p = join(projects, hash, name)
        if (existsSync(p)) add(target, readFileSync(p, 'utf8'))
      }
    }
  }
  return map
}

const text = resolveTexts()
const rows = Object.entries(records).map(([key, rec]) => ({
  key,
  track: String(rec.track ?? key.split('#')[0]),
  hits: Number(rec.hits) || 0,
  expanded: Number(rec.expanded) || 0,
  injects: Number(rec.injects) || 0,
  lastRetrieved: rec.lastRetrieved ?? '',
  text: text.get(key) ?? '(不在库中或无法解析)',
}))
const byInjects = [...rows].sort((a, b) => b.injects - a.injects)
const rowsNeverQueried = rows.filter((r) => r.hits === 0)
const injectedNeverQueried = rowsNeverQueried.filter((r) => r.injects > 0)
const queriedNeverInjected = rows.filter((r) => r.hits > 0 && r.injects === 0)

if (asJson) {
  console.log(JSON.stringify({ dir, updatedAt: usage.updatedAt, total: rows.length, injectedNeverQueried: injectedNeverQueried.length, queriedNeverInjected: queriedNeverInjected.length, neverQueried: rowsNeverQueried.length, rows: byInjects }, null, 1))
  process.exit(0)
}

const line = (r) => [String(r.injects).padStart(7), String(r.hits).padStart(4), String(r.expanded).padStart(4), (r.lastRetrieved || '-').padEnd(20), r.text.slice(0, 60)].join('  ')
console.log('# 记忆使用统计报告')
console.log('目录: ' + dir + '  |  统计更新时间: ' + (usage.updatedAt ?? '-') + '  |  有统计的条目: ' + rows.length)
console.log('')
console.log('## 覆盖率')
console.log('进过注入: ' + rows.filter((r) => r.injects > 0).length + ' / ' + rows.length + '　被定向查过: ' + rows.filter((r) => r.hits > 0).length + ' / ' + rows.length + '（其中 expand 过 ' + rows.filter((r) => r.expanded > 0).length + ' 条）')
console.log('')
console.log('## 反复注入但从未被查过（C 的第一批候选，共 ' + injectedNeverQueried.length + ' 条，按注入次数降序取前 ' + top + '）')
console.log('injects    hits   exp  lastRetrieved         条目')
for (const r of injectedNeverQueried.slice(0, top)) console.log(line(r))
console.log('')
console.log('## 被查过最多（前 ' + top + ' 条）')
console.log('injects    hits   exp  lastRetrieved         条目')
for (const r of [...rows].sort((a, b) => b.hits - a.hits).filter((r) => r.hits > 0).slice(0, top)) console.log(line(r))
console.log('')
console.log('## 被查过但没进注入（' + queriedNeverInjected.length + ' 条：靠检索取回）')
for (const r of queriedNeverInjected.slice(0, top)) console.log(line(r))
console.log('')
console.log('## 从未被触及（' + rowsNeverQueried.length + ' 条，前 ' + top + '）')
for (const r of byInjects.filter((r) => r.hits === 0).slice(0, top)) console.log(line(r))
