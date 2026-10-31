#!/usr/bin/env node
/**
 * memory-consolidate 预扫脚本（v2 · 档1 改造，2026-10-31）。
 *
 * 零依赖、只读扫描记忆目录，产出「候选簇 + 单条信号」报告，供 AI 按技能内
 * 批准的合并标准逐簇裁决。脚本只做候选发现，不写任何记忆文件。
 *
 * v2 相对 v1 的三处改动：
 *   1) 默认不聚类项目日志轨（project-log 是编年史、条目最多噪声最大；
 *      --include-project-log 可打开）。它仍被读入，用于「引用已归档」检测。
 *   2) 全对 O(n²) → 倒排索引稀疏候选（只对共享高区分度词元的条目对算精确余弦）。
 *   3) 新增确定性通道：idref（正文引用另一条的 8 位 id，规则与 memory 工具一致）、
 *      cite（「…」引用片段 + 覆盖线索词）、topic（同题跨期多结论）、
 *      stale（状态词 + 条目陈旧）、refArchived（引用了已归档条目）。
 *
 * 条目短 id 与插件 lib/sync/entryid.js 的 legacyIdFor 同规则：
 *   sha1(空白折叠 + trim 后的全文).slice(0,8)，故报告里的 id 可直接
 *   用于 memory 工具 action=expand id=<id>。
 *
 * 用法：
 *   node scan_memory.mjs [--dir ~/.dsh/memories] [--out report.json] [--md report.md]
 *                        [--threshold 0.42] [--top 40] [--include-project-log] [--stale-days 60]
 * 退出码：0 正常 / 2 参数错误 / 3 目录不可用
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ENTRY_DELIMITER = '\n§\n'
export const DEFAULT_EXCLUDE_TRACKS = ['project-log']

const USAGE = `usage: node scan_memory.mjs [options]
  --dir <path>            memory directory (default: ~/.dsh/memories)
  --out <path>            write JSON report to file (default: stdout)
  --md <path>             write human-readable markdown report
  --threshold <0..1>      cosine similarity floor for "similar" candidates (default: 0.42)
  --top <N>               markdown 里最多列多少簇 (default 40, 0=全部)
  --include-project-log   把项目日志轨（project-log）也放进聚类
  --stale-days <N>        「状态词 + 陈旧」的年龄门槛，天 (default 60)`

// ── 解析 ────────────────────────────────────────────────────────────────────

export function stripHeaderComment(text) {
  return String(text ?? '').replace(/^\uFEFF/, '').replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, '')
}

/** 内容归一化（与插件 lib/sync/entryid.js 的 normalizeContent 完全一致）。 */
export function normalizeContent(entry) {
  return String(entry ?? '').replace(/\s+/g, ' ').trim()
}

/** memory 工具的条目短 id：头部 [id:…] 优先，否则 sha1(归一化全文) 前 8 位。 */
export function toolIdOf(entry) {
  if (entry.headerId) return entry.headerId
  return createHash('sha1').update(normalizeContent(entry.text)).digest('hex').slice(0, 8)
}

export function parseMemoryText(text, meta = {}) {
  const body = stripHeaderComment(text)
  const out = []
  for (const raw of body.split(ENTRY_DELIMITER)) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(?:\[id:([0-9a-f]+)\]\s*)?\[(\d{4}-\d{2}-\d{2})(?:[ \d:]+)?\]\s*/)
    out.push({
      id: fnv1a32(line),
      headerId: m && m[1] ? m[1] : null,
      file: meta.file ?? null,
      track: meta.track ?? null,
      project: meta.project ?? null,
      archived: Boolean(meta.archived),
      date: m ? m[2] : null,
      text: line,
      body: m ? line.slice(m[0].length) : line,
      protected: PROTECTED_RE.test(line),
    })
  }
  return out
}

export function fnv1a32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// ── 特征与相似度 ────────────────────────────────────────────────────────────

const PROTECTED_RE = /待用户(确认|拍板)|用户确认后|勿动|勿删/
const SUPERSEDE_CUE_RE = /((?:修订|更正|修正|订正|推翻)既有|已过时|已经过时|不再准确|不再成立|已取代|取代旧|已被替代|已弃用|已废弃|已作废|以[^，。；;,.]{1,16}为准|本条(?:作废|订正))/
const SUPERSEDE_STRONG_RE = /(订正|推翻|作废|取代|更正|修正|补充|细化)/
const QUOTED_RE = /[「『]([^「」『』]{6,80})[」』]/g
const HEX_ID_RE = /\[id:([0-9a-f]{8})\]|(?<![0-9a-z])([0-9a-f]{8})(?![0-9a-z])/g
const STALE_STATUS_RE = /(目前|当前|现在|正在|暂时|尚未|待定|待确认|待用户|待观察|还没有|未完成|进行中|马上就|即将)/
/** 引用语境分类：覆盖类（说明被引用条已被订正 → 需要动作）。 */
const SUPERSEDE_VERB_RE = /(订正|更正|修正|推翻|作废|取代|替代|已过时|不再成立|不再准确|本条|以[^，。；;,.]{0,12}为准|补充(?:了)?既有)/ 
/** 引用语境分类：关联类（只是「相关/参考」，不需要动作 → 不进候选）。 */
const RELATED_VERB_RE = /(参考|详见|参见|另见|关联|相关|同上|延伸|类似|配合|呼应)/
const CONFLICT_POLARITY = [
  ['不可用', '实测可用'],
  ['无法使用', '可正常使用'],
  ['不再支持', '已支持'],
  ['无法启动', '正常启动'],
  ['已失效', '仍有效'],
  ['会崩溃', '无崩溃'],
]

export function normText(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function entryTerms(body) {
  const lower = String(body ?? '').toLowerCase()
  const terms = new Map()
  const bump = (t) => terms.set(t, (terms.get(t) || 0) + 1)
  for (const w of lower.match(/[a-z0-9][a-z0-9+#._/-]*/g) || []) bump(w)
  const cjk = lower.match(/[\u4e00-\u9fff]/g) || []
  for (let i = 0; i + 1 < cjk.length; i++) bump(cjk[i] + cjk[i + 1])
  if (cjk.length === 1) bump(cjk[0])
  return terms
}

export function computeIdf(docs) {
  const df = new Map()
  for (const terms of docs) for (const t of terms.keys()) df.set(t, (df.get(t) || 0) + 1)
  const n = docs.length
  const idf = new Map()
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1)
  return idf
}

export function cosine(a, b, idf) {
  const w = (terms) => {
    const v = new Map()
    let norm = 0
    for (const [t, c] of terms) {
      const x = c * (idf.get(t) ?? 1)
      v.set(t, x)
      norm += x * x
    }
    return { v, norm: Math.sqrt(norm) }
  }
  const va = w(a)
  const vb = w(b)
  let dot = 0
  for (const [t, x] of va.v) {
    const y = vb.v.get(t)
    if (y) dot += x * y
  }
  if (!va.norm || !vb.norm) return 0
  return dot / (va.norm * vb.norm)
}

export function diceBigrams(s1, s2) {
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const a = grams(s1)
  const b = grams(s2)
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const g of a) if (b.has(g)) inter++
  return (2 * inter) / (a.size + b.size)
}

export function quotedRefersTo(cueBody, otherBody) {
  return quotedRefersToCached(cueBody, normText(otherBody))
}

export function quotedRefersToCached(cueBody, targetNorm) {
  if (!targetNorm) return false
  for (const m of String(cueBody).matchAll(QUOTED_RE)) {
    const span = normText(m[1])
    if (span.length >= 6 && targetNorm.includes(span)) return true
    if (span.length >= 8 && diceBigrams(span, targetNorm) >= 0.45) return true
  }
  return false
}

export function pairReasons(a, b, sim, opts = {}) {
  const threshold = opts.threshold ?? 0.42
  const reasons = []
  if (sim >= 0.86) reasons.push('duplicate')
  else if (sim >= threshold) reasons.push('similar')
  const cueEntry = SUPERSEDE_CUE_RE.test(a.body) ? a : SUPERSEDE_CUE_RE.test(b.body) ? b : null
  if (cueEntry) {
    const other = cueEntry === a ? b : a
    if (sim >= 0.3 || quotedRefersTo(cueEntry.body, other.body)) reasons.push('supersede')
  }
  for (const [neg, pos] of CONFLICT_POLARITY) {
    const aNeg = a.body.includes(neg)
    const bNeg = b.body.includes(neg)
    if ((aNeg && b.body.includes(pos) && !bNeg) || (bNeg && a.body.includes(pos) && !aNeg)) {
      if (sim >= 0.3) reasons.push('conflict')
      break
    }
  }
  return reasons
}

// ── 标题 / 同题 ─────────────────────────────────────────────────────────────

export function titleOf(entry) {
  const m = String(entry.body ?? '').match(/^【([^】]{2,60})】/)
  return m ? m[1] : String(entry.body ?? '').slice(0, 24)
}

export function titleTopic(title) {
  return normText(String(title).replace(/^\s*(订正|更正|修正|补充|细化|再谈|更新|撤回|重新)[·・:\s]*/u, ''))
}

// ── 倒排索引候选 ────────────────────────────────────────────────────────────

export function candidatePairs(entries, opts = {}) {
  const threshold = opts.threshold ?? 0.42
  const blockTerms = opts.blockTerms ?? 16
  const dfCapRatio = opts.dfCapRatio ?? 0.06
  const maxPosting = opts.maxPosting ?? 400
  const n = entries.length
  const docs = entries.map((e) => entryTerms(e.body))
  const idf = computeIdf(docs)
  const weights = []
  const norms = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = new Map()
    let acc = 0
    for (const [t, c] of docs[i]) {
      const x = c * (idf.get(t) ?? 1)
      v.set(t, x)
      acc += x * x
    }
    norms[i] = Math.sqrt(acc) || 0
    weights.push(v)
  }
  const df = new Map()
  for (const v of weights) for (const t of v.keys()) df.set(t, (df.get(t) || 0) + 1)
  const dfCap = Math.max(2, Math.floor(n * dfCapRatio))
  const buckets = new Map()
  for (let i = 0; i < n; i++) {
    const cand = []
    for (const [t, x] of weights[i]) {
      const d = df.get(t) || 0
      if (d < 2 || d > dfCap) continue
      cand.push([t, x])
    }
    cand.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    for (const [t] of cand.slice(0, blockTerms)) {
      let arr = buckets.get(t)
      if (!arr) buckets.set(t, (arr = []))
      if (arr.length < maxPosting) arr.push(i)
    }
  }
  const seen = new Set()
  const pairs = []
  for (const arr of buckets.values()) {
    if (arr.length < 2) continue
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const i = Math.min(arr[x], arr[y])
        const j = Math.max(arr[x], arr[y])
        const key = i * 1048576 + j
        if (seen.has(key)) continue
        seen.add(key)
        const small = weights[i].size <= weights[j].size ? weights[i] : weights[j]
        const big = small === weights[i] ? weights[j] : weights[i]
        let dot = 0
        for (const [t, v] of small) {
          const w = big.get(t)
          if (w) dot += v * w
        }
        const sim = dot / ((norms[i] || 1) * (norms[j] || 1))
        if (sim >= threshold) pairs.push({ i, j, sim })
      }
    }
  }
  return { docs, idf, norms, pairs, weights, stats: { buckets: buckets.size, candidates: seen.size } }
}

// ── 聚类 ────────────────────────────────────────────────────────────────────

const HINT_PRIORITY = ['idref', 'supersede', 'duplicate', 'conflict', 'topic', 'idref-weak', 'cite', 'similar']
const HINT_SCORE = { idref: 100, supersede: 90, duplicate: 70, conflict: 60, topic: 50, 'idref-weak': 40, cite: 45, similar: 30 }
/** 不进候选的 reasons（只统计数量）：related = 纯「相关/参考」引用。 */
const SKIP_REASONS = new Set(['related'])

/** v1 兼容：全对比较 + 并查集聚簇。 */
export function clusterEntries(entries, opts = {}) {
  const threshold = opts.threshold ?? 0.42
  const docs = entries.map((e) => entryTerms(e.body))
  const idf = computeIdf(docs)
  const pairs = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sim = cosine(docs[i], docs[j], idf)
      const reasons = pairReasons(entries[i], entries[j], sim, { threshold })
      if (!reasons.length) continue
      pairs.push({ i, j, sim, reasons })
    }
  }
  return buildClusters(entries, pairs)
}

export function buildClusters(entries, pairs) {
  const parent = entries.map((_, i) => i)
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (x, y) => {
    parent[find(x)] = find(y)
  }
  for (const p of pairs) union(p.i, p.j)
  const groups = new Map()
  for (let i = 0; i < entries.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }
  const brief = (e) => ({
    id: e.toolId || e.id,
    fp: e.id,
    file: e.file,
    track: e.track,
    project: e.project,
    date: e.date,
    protected: e.protected,
    title: titleOf(e),
    excerpt: e.body.slice(0, 160),
    match: matchSnippet(e),
  })
  const clusters = []
  let n = 0
  for (const idx of groups.values()) {
    if (idx.length < 2) continue
    const cpairs = pairs
      .filter((p) => idx.includes(p.i) && idx.includes(p.j))
      .map((p) => ({
        a: entries[p.i].toolId || entries[p.i].id,
        b: entries[p.j].toolId || entries[p.j].id,
        sim: Math.round((p.sim ?? 0) * 1000) / 1000,
        reasons: p.reasons,
        note: p.note ?? null,
      }))
    const reasons = new Set(cpairs.flatMap((p) => p.reasons))
    const hint = HINT_PRIORITY.find((h) => reasons.has(h)) ?? 'similar'
    const dated = idx.map((i) => entries[i].date).filter(Boolean).sort()
    clusters.push({
      id: `cluster-${++n}`,
      hint,
      reasons: [...reasons],
      members: idx.map((i) => brief(entries[i])),
      pairs: cpairs,
      spanDays: dated.length >= 2 ? daysBetween(dated[0], dated[dated.length - 1]) : 0,
    })
  }
  return clusters
}

export function matchSnippet(entry) {
  const raw = String(entry.body ?? '').replace(/\s+/g, ' ').trim()
  return raw.length <= 30 ? raw : raw.slice(0, 30)
}

export function daysBetween(a, b) {
  const da = Date.parse(a)
  const db = Date.parse(b)
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0
  return Math.round((db - da) / 86400000)
}

// ── 确定性通道 ──────────────────────────────────────────────────────────────

/** 正文里出现的 8 位 hex id（含 [id:xxx] 与裸 hex）。 */
export function extractIds(body) {
  const out = new Set()
  for (const m of String(body ?? '').matchAll(HEX_ID_RE)) {
    const v = m[1] || m[2]
    if (v) out.add(v)
  }
  return out
}

/**
 * idref：正文引用了另一条的短 id（与 memory 工具 id 同规则 → 精确边）。
 * 按引用**语境**分类：覆盖类（订正/推翻/作废/以…为准）→ reasons=['idref']（必看）；
 * 关联类（参考/详见/相关…）→ reasons=['related']（不进候选）；无所指 → reasons=['idref-weak']。
 */
export function detectIdRefs(entries) {
  const byId = new Map()
  for (let i = 0; i < entries.length; i++) byId.set(entries[i].toolId || entries[i].id, i)
  const out = []
  for (let i = 0; i < entries.length; i++) {
    const body = String(entries[i].body)
    for (const m of body.matchAll(HEX_ID_RE)) {
      const v = m[1] || m[2]
      if (!v) continue
      const j = byId.get(v)
      if (j == null || j === i) continue
      const at = m.index ?? 0
      const ctx = body.slice(Math.max(0, at - 18), at + 18)
      const cls = SUPERSEDE_VERB_RE.test(ctx) ? 'idref' : RELATED_VERB_RE.test(ctx) ? 'related' : 'idref-weak'
      out.push({ i, j, reasons: [cls], note: `正文引用 id:${v}（语境：${cls}）` })
    }
  }
  return out
}

/** cite：覆盖线索词 + 「…」引用片段 → 弱引用边（每个 cue 只留最佳目标）。 */
export function detectQuotedRefs(entries, opts = {}) {
  const minSpan = opts.minSpan ?? 10
  const normCache = entries.map((e) => normText(e.body))
  const out = []
  for (let i = 0; i < entries.length; i++) {
    const body = String(entries[i].body)
    if (!SUPERSEDE_STRONG_RE.test(body)) continue
    const spans = []
    for (const m of body.matchAll(QUOTED_RE)) {
      const s = normText(m[1])
      if (s.length >= minSpan) spans.push(s)
    }
    if (!spans.length) continue
    let best = null
    for (let j = 0; j < entries.length; j++) {
      if (j === i || !normCache[j]) continue
      let score = 0
      for (const s of spans) {
        score = Math.max(score, normCache[j].includes(s) ? 1 : diceBigrams(s, normCache[j]))
      }
      if (score >= 0.45 && (!best || score > best.score)) best = { j, score }
    }
    if (best) out.push({ i, j: best.j, reasons: ['cite'], note: `「」引用片段命中（dice ${best.score.toFixed(2)}）` })
  }
  return out
}

/** topic：同题（【…】标题二元组 Jaccard）+ 跨期 → 同主题多结论候选（分桶）。 */
export function detectTopicPairs(entries, opts = {}) {
  const minJaccard = opts.minJaccard ?? 0.45
  const minSpan = opts.minSpan ?? 14
  const grams = entries.map((e) => {
    const t = titleTopic(titleOf(e))
    const set = new Set()
    for (let k = 0; k + 1 < t.length; k++) set.add(t.slice(k, k + 2))
    return set
  })
  const buckets = new Map()
  for (let i = 0; i < entries.length; i++) {
    const keys = [...grams[i]].slice(0, 4).sort()
    for (const g of keys) {
      let list = buckets.get(g)
      if (!list) buckets.set(g, (list = []))
      if (list.length < 200) list.push(i)
    }
  }
  const seen = new Set()
  const out = []
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const i = Math.min(list[x], list[y])
        const j = Math.max(list[x], list[y])
        const key = i * 1048576 + j
        if (seen.has(key)) continue
        seen.add(key)
        if (entries[i].track !== entries[j].track) continue
        if (grams[i].size < 4 || grams[j].size < 4) continue
        const span = daysBetween(entries[i].date, entries[j].date)
        if (Math.abs(span) < minSpan) continue
        let inter = 0
        for (const g of grams[i]) if (grams[j].has(g)) inter++
        const jac = inter / (grams[i].size + grams[j].size - inter)
        if (jac >= minJaccard) out.push({ i, j, reasons: ['topic'], note: `同题 Jaccard=${jac.toFixed(2)}、相隔 ${Math.abs(span)} 天` })
      }
    }
  }
  return out
}

/** refArchived：正文引用的 id 落在归档条目里 → 引用已失效（精确）。 */
export function detectRefArchived(entries, archivedEntries) {
  if (!archivedEntries.length) return []
  const archById = new Map()
  for (const e of archivedEntries) archById.set(e.toolId || e.id, e)
  const out = []
  for (const e of entries) {
    for (const v of extractIds(e.body)) {
      const hit = archById.get(v)
      if (!hit) continue
      out.push({
        id: e.toolId || e.id,
        track: e.track,
        project: e.project,
        date: e.date,
        archivedId: hit.toolId || hit.id,
        archivedDate: hit.date,
        title: titleOf(e),
        match: matchSnippet(e),
        excerpt: e.body.slice(0, 120),
      })
      break
    }
  }
  return out
}

/** stale：状态词 + 条目年龄超门槛。 */
export function detectStale(entries, opts = {}) {
  const days = opts.days ?? 60
  const now = opts.now ?? Date.now()
  const out = []
  for (const e of entries) {
    if (!e.date) continue
    const t = Date.parse(e.date)
    if (!Number.isFinite(t)) continue
    const age = Math.floor((now - t) / 86400000)
    if (age <= days) continue
    const m = String(e.body).match(STALE_STATUS_RE)
    if (!m) continue
    out.push({
      id: e.toolId || e.id,
      track: e.track,
      project: e.project,
      date: e.date,
      ageDays: age,
      matched: m[0],
      title: titleOf(e),
      match: matchSnippet(e),
      excerpt: e.body.slice(0, 120),
    })
  }
  out.sort((a, b) => b.ageDays - a.ageDays)
  return out
}

// ── 排序 ────────────────────────────────────────────────────────────────────

export function rankClusters(clusters) {
  for (const c of clusters) {
    const base = Math.max(...c.reasons.map((r) => HINT_SCORE[r] ?? 10))
    const maxSim = Math.max(0, ...c.pairs.map((p) => p.sim ?? 0))
    const protectedPenalty = c.members.some((m) => m.protected) ? 25 : 0
    const spanBonus = c.hint === 'topic' ? Math.min(15, Math.floor((c.spanDays ?? 0) / 30)) : 0
    c.score = base + Math.round(maxSim * 20) + spanBonus - protectedPenalty
  }
  clusters.sort((a, b) => b.score - a.score || String(a.members[0].id).localeCompare(String(b.members[0].id)))
  return clusters
}

// ── 目录扫描 ────────────────────────────────────────────────────────────────

export function scanDir(dir) {
  const entries = []
  const archivedEntries = []
  const filesScanned = []
  const visit = (rel, track, project, archived) => {
    const p = join(dir, rel)
    if (!existsSync(p)) return
    let text
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      return
    }
    const parsed = parseMemoryText(text, { file: rel, track, project, archived })
    for (const e of parsed) e.toolId = toolIdOf(e)
    ;(archived ? archivedEntries : entries).push(...parsed)
    filesScanned.push({ file: rel, entries: parsed.length })
  }
  visit('MEMORY.md', 'memory', null, false)
  visit('USER.md', 'user', null, false)
  visit('MEMORY-archive.md', 'memory', null, true)
  visit('USER-archive.md', 'user', null, true)
  const projectsDir = join(dir, 'projects')
  if (existsSync(projectsDir)) {
    for (const ent of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      visit(join('projects', ent.name, 'KEY.md'), 'key', ent.name, false)
      visit(join('projects', ent.name, 'MEMORY.md'), 'project-log', ent.name, false)
      visit(join('projects', ent.name, 'KEY-archive.md'), 'key', ent.name, true)
      visit(join('projects', ent.name, 'MEMORY-archive.md'), 'project-log', ent.name, true)
    }
  }
  return { entries, archivedEntries, filesScanned }
}

// ── 报告 ────────────────────────────────────────────────────────────────────

export function analyze(scanned, opts = {}) {
  const threshold = opts.threshold ?? 0.42
  const excludeTracks = opts.excludeTracks ?? DEFAULT_EXCLUDE_TRACKS
  const live = scanned.entries.filter((e) => !excludeTracks.includes(e.track))
  const byTrack = {}
  for (const e of scanned.entries) byTrack[e.track ?? 'unknown'] = (byTrack[e.track ?? 'unknown'] || 0) + 1
  const t0 = Date.now()
  const sparse = candidatePairs(live, { threshold })
  const channelEdges = {
    idref: detectIdRefs(live),
    cite: detectQuotedRefs(live),
    topic: detectTopicPairs(live, opts.topic ?? {}),
  }
  const merged = new Map()
  const push = (p) => {
    const i = Math.min(p.i, p.j)
    const j = Math.max(p.i, p.j)
    const key = i * 1048576 + j
    const cur = merged.get(key)
    if (cur) {
      for (const r of p.reasons) if (!cur.reasons.includes(r)) cur.reasons.push(r)
      if (p.note) cur.note = cur.note ? cur.note + '；' + p.note : p.note
      cur.sim = Math.max(cur.sim ?? 0, p.sim ?? 0)
    } else {
      merged.set(key, { i, j, sim: p.sim ?? 0, reasons: [...p.reasons], note: p.note ?? null })
    }
  }
  for (const p of sparse.pairs) {
    const reasons = pairReasons(live[p.i], live[p.j], p.sim, { threshold })
    if (!reasons.length) continue
    push({ ...p, reasons })
  }
  let relatedSkipped = 0
  for (const list of Object.values(channelEdges)) {
    for (const p of list) {
      if (p.reasons.some((r) => SKIP_REASONS.has(r))) {
        relatedSkipped++
        continue
      }
      push(p)
    }
  }
  const pairs = [...merged.values()]
  const clusters = rankClusters(buildClusters(live, pairs))
  const stale = detectStale(live, { days: opts.staleDays ?? 60, now: opts.now })
  const refArchived = detectRefArchived(live, scanned.archivedEntries)
  const elapsedMs = Date.now() - t0
  const hints = {}
  for (const c of clusters) hints[c.hint] = (hints[c.hint] || 0) + 1
  return {
    live, pairs, clusters, stale, refArchived, byTrack, elapsedMs,
    channelStats: {
      candidates: sparse.stats.candidates,
      buckets: sparse.stats.buckets,
      idref: channelEdges.idref.length,
      cite: channelEdges.cite.length,
      topic: channelEdges.topic.length,
      relatedSkipped,
    },
    stats: {
      entries: live.length,
      entriesScanned: scanned.entries.length,
      excluded: scanned.entries.length - live.length,
      byTrack,
      archivedContext: scanned.archivedEntries.length,
      clusters: clusters.length,
      hints,
      pairs: pairs.length,
      stale: stale.length,
      refArchived: refArchived.length,
      elapsedMs,
    },
  }
}

const ACTION_BY_HINT = {
  idref: '一条正文引用了另一条的 id → 必看：确认现行结论是哪条，旧条归档并在保留条内注明关系',
  supersede: '覆盖更新 → 保留较新/有实证的一条（旧条独有细节并进去），旧条归档',
  duplicate: '字面重复 → 留信息最全的一条，其余归档',
  conflict: '冲突 → 以有实证、日期更新的一方为准，被否定说法归档，保留条内注明订正关系',
  topic: '同题跨期多结论 → 核对是否同一结论的多个版本；被推翻的旧条归档并注明',
  'idref-weak': '正文提到对方 id 但无明确覆盖措辞 → 扫一眼：确认是否同一件事的两个版本',
  cite: '引用了对方原文片段 → 确认引用是否仍有效（被引用条若已归档，需更新引用）',
  similar: '相近 → 确认是否同一事项；「同主题不同事实」不要合并',
}

export function renderMarkdown(report, opts = {}) {
  const top = opts.top ?? 40
  const L = []
  const iso = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const clusters = top > 0 ? report.clusters.slice(0, top) : report.clusters
  const h = report.stats.hints || {}
  L.push('# 记忆体检单')
  L.push('')
  L.push(`- 生成时间：${iso}`)
  L.push(`- 目录：\`${report.dir}\``)
  L.push(`- 参与聚类：${report.stats.entries} 条（扫描 ${report.stats.entriesScanned}，排除 ${report.stats.excluded}）`)
  L.push(`- 分轨：${Object.entries(report.stats.byTrack).map(([k, v]) => `${k}=${v}`).join('  ')}`)
  L.push(`- 候选簇：${report.stats.clusters}（列出 ${clusters.length}）｜条目对 ${report.stats.pairs}｜陈旧 ${report.stats.stale}｜引用已归档 ${report.stats.refArchived}`)
  L.push(`- 通道：idref=${h.idref || 0} supersede=${h.supersede || 0} duplicate=${h.duplicate || 0} conflict=${h.conflict || 0} topic=${h.topic || 0} cite=${h.cite || 0} similar=${h.similar || 0}`)
  L.push(`- 耗时：${(report.stats.elapsedMs / 1000).toFixed(1)} 秒`)
  L.push('')
  L.push('> 只读产出：脚本不改任何记忆文件；执行一律用 memory 工具的 archive（可逆），禁止直接编辑 .md。')
  L.push('')
  const sections = [
    ['第一档 · 必看（id 互引 / 覆盖更新）', ['idref', 'supersede']],
    ['第二档 · 可看（重复 / 冲突 / 同题跨期）', ['duplicate', 'conflict', 'topic']],
    ['第三档 · 扫一眼（弱 id 引用 / 引用片段 / 相近）', ['idref-weak', 'cite', 'similar']],
  ]
  for (const [title, hints] of sections) {
    const list = clusters.filter((c) => hints.includes(c.hint))
    L.push(`## ${title}（${list.length}）`)
    L.push('')
    if (!list.length) {
      L.push('（无）')
      L.push('')
      continue
    }
    for (const c of list) {
      L.push(`### ${c.id}｜${c.hint}｜score ${c.score}${c.spanDays ? `｜跨度 ${c.spanDays} 天` : ''}`)
      L.push('')
      L.push(`建议：${ACTION_BY_HINT[c.hint] ?? ''}`)
      L.push('')
      for (const m of c.members) {
        const where = m.project ? `${m.track}/${m.project}` : m.track
        L.push(`- [${m.date ?? '----'}|${m.id}] ${where}${m.protected ? ' 待确认' : ''}：${m.title}`)
        L.push(`  - 摘录：${String(m.excerpt).replace(/\n/g, ' ').slice(0, 110)}`)
        L.push(`  - match：\`${String(m.match).replace(/`/g, '')}\``)
      }
      const notes = [...new Set(c.pairs.filter((p) => p.note).map((p) => p.note))]
      if (notes.length) L.push(`- 证据：${notes.slice(0, 3).join('；')}`)
      L.push('')
    }
  }
  if (report.stale.length) {
    L.push(`## 单条信号 · 陈旧状态词（${report.stale.length}）`)
    L.push('')
    L.push('判定：正文含「目前/当前/待定/尚未…」且条目年龄超过门槛——大概率已过期，确认后归档。')
    L.push('')
    for (const s of report.stale.slice(0, 30)) {
      const where = s.project ? `${s.track}/${s.project}` : s.track
      L.push(`- [${s.date}|${s.id}] ${where}（${s.ageDays} 天，命中「${s.matched}」）：${s.title}`)
      L.push(`  - match：\`${String(s.match).replace(/`/g, '')}\``)
    }
    L.push('')
  }
  if (report.refArchived.length) {
    L.push(`## 单条信号 · 引用了已归档条目（${report.refArchived.length}）`)
    L.push('')
    L.push('判定：正文引用的 id 落在归档文件里——引用已失效，确认后清理或归档本条。')
    L.push('')
    for (const s of report.refArchived.slice(0, 30)) {
      const where = s.project ? `${s.track}/${s.project}` : s.track
      L.push(`- [${s.date}|${s.id}] ${where} → 引用已归档 [${s.archivedDate ?? '----'}|${s.archivedId}]：${s.title}`)
      L.push(`  - match：\`${String(s.match).replace(/`/g, '')}\``)
    }
    L.push('')
  }
  L.push('---')
  L.push('')
  L.push('执行提示（用 memory 工具，不要直接改文件）：')
  L.push('')
  L.push('```')
  L.push('memory action=expand id=<上面的 id>                                 # 先看全文')
  L.push('memory action=archive target=<memory|user|key> match="<match 片段>"   # 归档旧条')
  L.push('memory action=replace target=... match=... content="..."             # 需要并集时先改保留条')
  L.push('```')
  L.push('')
  return L.join('\n')
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { dir: null, out: null, md: null, threshold: 0.42, top: 40, includeProjectLog: false, staleDays: 60 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') opts.dir = argv[++i]
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--md') opts.md = argv[++i]
    else if (a === '--threshold') opts.threshold = Number(argv[++i])
    else if (a === '--top') opts.top = Number(argv[++i])
    else if (a === '--stale-days') opts.staleDays = Number(argv[++i])
    else if (a === '--include-project-log') opts.includeProjectLog = true
    else throw new Error(`unknown arg: ${a}`)
  }
  if (!Number.isFinite(opts.threshold) || opts.threshold <= 0 || opts.threshold >= 1) {
    throw new Error('--threshold must be a number in (0, 1)')
  }
  if (!Number.isFinite(opts.top) || opts.top < 0) throw new Error('--top must be a number >= 0')
  if (!Number.isFinite(opts.staleDays) || opts.staleDays < 0) throw new Error('--stale-days must be a number >= 0')
  if (opts.dir != null && typeof opts.dir !== 'string') throw new Error('--dir requires a path')
  if (opts.out != null && typeof opts.out !== 'string') throw new Error('--out requires a path')
  if (opts.md != null && typeof opts.md !== 'string') throw new Error('--md requires a path')
  return opts
}

const expandHome = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

export function main(argv = []) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`[memory-consolidate] ${err.message}`)
    console.error(USAGE)
    return 2
  }
  const dir = opts.dir ? expandHome(opts.dir) : join(homedir(), '.dsh', 'memories')
  if (!existsSync(dir)) {
    console.error(`[memory-consolidate] dir not found: ${dir}`)
    return 3
  }
  const scanned = scanDir(dir)
  const result = analyze(scanned, {
    threshold: opts.threshold,
    excludeTracks: opts.includeProjectLog ? [] : DEFAULT_EXCLUDE_TRACKS,
    staleDays: opts.staleDays,
  })
  const report = {
    generatedAt: new Date().toISOString(),
    version: 2,
    dir,
    threshold: opts.threshold,
    excludeTracks: opts.includeProjectLog ? [] : DEFAULT_EXCLUDE_TRACKS,
    stats: { files: scanned.filesScanned.length, ...result.stats },
    channelStats: result.channelStats,
    clusters: result.clusters,
    stale: result.stale,
    refArchived: result.refArchived,
  }
  if (opts.out) writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8')
  if (opts.md) writeFileSync(opts.md, renderMarkdown(report, { top: opts.top }), 'utf8')
  if (opts.out || opts.md) {
    const h = report.stats.hints || {}
    console.log('[memory-consolidate] scan complete')
    console.log(`  dir: ${dir}`)
    console.log(`  entries: ${report.stats.entries} clustered (scanned ${report.stats.entriesScanned}, excluded ${report.stats.excluded})`)
    console.log(`  clusters: ${report.stats.clusters}`)
    console.log(`  hints: idref=${h.idref || 0} supersede=${h.supersede || 0} duplicate=${h.duplicate || 0} conflict=${h.conflict || 0} topic=${h.topic || 0} cite=${h.cite || 0} similar=${h.similar || 0}`)
    console.log(`  signals: stale=${report.stats.stale} refArchived=${report.stats.refArchived}`)
    console.log(`  elapsed: ${(report.stats.elapsedMs / 1000).toFixed(1)}s`)
    if (opts.out) console.log(`  report: ${opts.out}`)
    if (opts.md) console.log(`  markdown: ${opts.md}`)
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  }
  return 0
}

const isDirectRun = Boolean(process.argv[1]) && (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()
if (isDirectRun) process.exitCode = main(process.argv.slice(2))
