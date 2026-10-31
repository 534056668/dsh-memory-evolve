// 记忆逐条索引（B30）——把 memory 轨的摘要注入从「80 字摘要」换成「30 字标题」。
//
// 为什么不是主题索引：Task 1 实测（2026-10-31）词法只聚出 12 个主题覆盖 7.1%、
// 4B 语义聚出 31 个主题覆盖 17.0%——本库 477 条是互不重复的工程教训，没有主题结构。
// 逐条索引覆盖 100%，实测 memory 轨注入 50,841 → 19,724 字符（−61.2%）。
//
// 为什么不需要缓存/增量重建：本模块只是把每条的标题截短，成本与现有的
// autoSummary(80) 同量级（几百次字符串操作），注入路径每回合直接算即可——
// 原计划的 index.json + sourceHash + 异步重建全部不需要（YAGNI）。
import { autoSummary, parseEntrySummary, projectHash } from './store.js'
import { extractEntryId, legacyIdFor } from './sync/entryid.js'

/** 标题截断长度（B30：实测 19,724 字符 / −61.2%）。 */
export const INDEX_TITLE_MAX = 30

/** 本地时间戳 yyyy/mm/dd hh:mm（索引自报新鲜度用）。 */
export function formatStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 单条索引行：`- [短id] 标题`（有 [summary:…] 时优先用它，保持作者写的一句话摘要）。 */
export function indexLine(entry, maxTitle = INDEX_TITLE_MAX) {
  const shortId = extractEntryId(entry) ?? legacyIdFor(entry)
  const title = parseEntrySummary(entry) || autoSummary(entry, maxTitle)
  return `- [${shortId}] ${title}`
}

/** 批量生成索引行；chars 用于测试与报告（含行尾换行）。 */
export function buildIndexLines(entries, opts = {}) {
  const maxTitle = opts.maxTitle ?? INDEX_TITLE_MAX
  const lines = (entries ?? []).map((entry) => indexLine(entry, maxTitle))
  const chars = lines.reduce((sum, line) => sum + line.length + 1, 0)
  return { lines, covered: lines.length, chars }
}

/** 渲染整块（行 + 自报覆盖/新鲜度的尾行）；无条目时返回空串（调用方据此跳过注入）。 */
export function renderMemoryIndexBlock(entries, opts = {}) {
  const { lines, covered } = buildIndexLines(entries, opts)
  if (covered === 0) return ''
  const stamp = opts.stamp ?? formatStamp()
  const footer = `（逐条索引 · 共 ${covered} 条 · 更新于 ${stamp} · 需要详情用 memory expand id=<id>）`
  return [...lines, footer].join('\n')
}

/**
 * 索引模式判定（默认关闭，可一键回退）：
 *   DSH_MEMORY_INDEX=off            → 摘要（任何情况下优先，作紧急回退开关）
 *   DSH_MEMORY_INDEX=on             → 索引（全量试点/转正）
 *   DSH_MEMORY_INDEX_PROJECTS=a,b   → 只对列出的项目 hash 开索引（灰度试点）
 *   其余                             → 摘要（缺省行为与改造前完全一致）
 */
export function resolveIndexMode({ env = {}, cwd = null } = {}) {
  const global = String(env.DSH_MEMORY_INDEX ?? '').trim().toLowerCase()
  if (global === 'off') return 'summary'
  if (global === 'on') return 'index'
  const list = String(env.DSH_MEMORY_INDEX_PROJECTS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  if (cwd && list.length > 0 && list.includes(projectHash(cwd))) return 'index'
  return 'summary'
}
