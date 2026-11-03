/**
 * dsh-memory-evolve — 记忆使用统计（命中数 / 注入数），零依赖。
 *
 * 目的：为「注入预算化」（决定默认给模型看哪些记忆）提供**数据依据**，而不是
 * 拍脑袋。统计口径（三者独立计数，便于做比值）：
 *   - hits      ：被**定向查询**返回过几次（list 带 filter；整句/多词/关键词都算）
 *   - expanded  ：被 expand 取回原文几次（= 模型确实要看全文）
 *   - injects   ：被注入快照几次（每回合快照渲染一次，全量/摘要模式都算）
 * 2026-11-03 增补两维（原数据无法回答「试点有没有用」与「查了没查到」）：
 *   - byProject ：每条条目的计数再按**会话项目 hash** 分桶，用于给灰度试点
 *                  （如 me-update 索引模式）单独归因——旧数据是全局混在一起的。
 *   - projects  ：文件级项目聚合，多两个**事件**计数 searches / misses。
 *                  misses = 带 filter 的查询返回 0 条，这是「该查未查」的唯一直接
 *                  证据；只记命中时，「0 命中」既可能是没用过、也可能是查了没查到。
 * 由 hits/injects 与 expanded/injects 的比值可以回答两个问题：
 *   「哪些条目录入了但从没被查过」→ 不再默认注入的候选；
 *   「哪些条目被查过但没进注入」→ 说明它靠检索取回，注入可以省。
 *
 * 硬约束（本仓库出过两次「展示层剥元数据、匹配层没跟上」的事故，第三次不许）：
 *   1. **只写 sidecar** `<memoryDir>/usage.json`：不碰任何 .md 条目、不进注入、
 *      不改任何工具返回值——统计失败绝不能让记忆工具失败（全部 try/catch 吞掉）。
 *   2. memoryDir 的 .gitignore 是 deny-all + 白名单（lib/sync/repo.js），新增的
 *      usage.json 不会被 git 跟踪，不会污染 memories 仓库。
 *   3. 条目键与匹配层同源：优先用**头部**的 `[id:…]`（canonical = id 在时间戳之前，
 *      与 entryid.extractEntryId 的契约一致）；没有 id 才用
 *      `normalizeForMatch(entry)` 的 sha1——不自己再实现一遍剥离逻辑。注意
 *      normalizeForMatch **只剥 id/summary、不剥时间戳**：无 id 的条目键含日期
 *      （同一段话在不同日期算两个条目），真实库条目绝大多数有 id。
 *
 * 写入策略：内存 Map 累积 + 节流落盘（定向查询 2s 内、注入 120s 内、原子替换），
 * 键数上限 20,000（超出按「最久未触及」裁剪），损坏文件自动备份 `.corrupt-*`。
 *
 * @module dsh-memory-evolve/memory-usage
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extractEntryId } from './sync/entryid.js'
import { normalizeForMatch } from './store.js'

/** sidecar 文件名（与记忆文件同目录，但不受 git 跟踪）。 */
export const USAGE_FILE_NAME = 'usage.json'
/** 键数上限：超出按最久未触及裁剪，防止无限膨胀。 */
export const MAX_KEYS = 20000
/** 定向查询触发的落盘延迟（查询少而珍贵，尽快落盘）。 */
const RETRIEVAL_FLUSH_MS = 2000
/** 注入触发的落盘延迟（每回合都会发生，批量攒着写）。 */
const INJECT_FLUSH_MS = 120000
/** 每条条目最多记多少个项目的归属（超出归入 __other，防止键数爆炸）。 */
export const MAX_PROJECTS_PER_ENTRY = 8
/** 项目级聚合表最多记多少个项目（超出按最久未触及裁剪）。 */
export const MAX_PROJECT_KEYS = 64

let usageDir = null
let entries = new Map()
/** 项目级聚合：{ [projectHash]: { injects, hits, expanded, searches, misses, lastSearch } } */
let projects = new Map()
let loaded = false
let dirty = false
let timer = null
let timerDue = 0
let lastError = ''

/** 初始化（在 apply() 里调用一次）：解析路径 + 载入既有统计。 */
export function initUsage(memoryDir) {
  try {
    usageDir = memoryDir ? String(memoryDir) : null
    entries = new Map()
    loaded = false
    dirty = false
    cancelTimer()
    load()
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
}

/** 统计文件绝对路径（未初始化时返回空串）。 */
export function usageFilePath() {
  return usageDir ? join(usageDir, USAGE_FILE_NAME) : ''
}

/** 最近一次内部错误（诊断用；正常运行恒为空串）。 */
export function usageLastError() {
  return lastError
}

/**
 * 条目键：`<target>#<id|hash12>`。与匹配层同源（id 优先，缺失则用归一化文本的
 * sha1），因此「展示层剥离逻辑变了」不会让统计键漂移。
 * @param {string} target
 * @param {string} entry
 * @returns {string}
 */
export function usageKey(target, entry) {
  const id = extractEntryId(String(entry ?? ''))
  const base = id ?? 'h' + createHash('sha1').update(normalizeForMatch(String(entry ?? ''))).digest('hex').slice(0, 12)
  return String(target) + '#' + base
}

function blank(track) {
  return { track, hits: 0, expanded: 0, injects: 0, lastRetrieved: '', lastInjected: '', firstSeen: now(), byProject: {} }
}

function now() {
  return new Date().toISOString().slice(0, 19) + 'Z'
}

function load() {
  loaded = true
  const file = usageFilePath()
  if (!file || !existsSync(file)) return
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    lastError = String(error?.message ?? error)
    return
  }
  try {
    const parsed = JSON.parse(raw)
    const list = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {}
    for (const [key, value] of Object.entries(list)) {
      if (!value || typeof value !== 'object') continue
      const rec = blank(String(value.track ?? key.split('#')[0] ?? ''))
      rec.hits = Number(value.hits) || 0
      rec.expanded = Number(value.expanded) || 0
      rec.injects = Number(value.injects) || 0
      rec.lastRetrieved = typeof value.lastRetrieved === 'string' ? value.lastRetrieved : ''
      rec.lastInjected = typeof value.lastInjected === 'string' ? value.lastInjected : ''
      rec.firstSeen = typeof value.firstSeen === 'string' && value.firstSeen !== '' ? value.firstSeen : now()
      if (value.byProject && typeof value.byProject === 'object') {
        for (const [p, v] of Object.entries(value.byProject)) {
          if (!v || typeof v !== 'object') continue
          rec.byProject[p] = { inj: Number(v.inj) || 0, hit: Number(v.hit) || 0, exp: Number(v.exp) || 0 }
        }
      }
      entries.set(key, rec)
    }
    if (parsed && parsed.projects && typeof parsed.projects === 'object') {
      for (const [hash, value] of Object.entries(parsed.projects)) {
        if (!value || typeof value !== 'object') continue
        projects.set(String(hash), {
          injects: Number(value.injects) || 0,
          hits: Number(value.hits) || 0,
          expanded: Number(value.expanded) || 0,
          searches: Number(value.searches) || 0,
          misses: Number(value.misses) || 0,
          lastSearch: typeof value.lastSearch === 'string' ? value.lastSearch : '',
        })
      }
    }
  } catch {
    // 损坏统计不阻断任何功能：备份后从空开始（与 store 的 .corrupt-* 同纪律）
    try {
      renameSync(file, file + '.corrupt-' + Date.now())
    } catch { /* 备份失败也不抛 */ }
  }
}

function touch(target, entry) {
  const key = usageKey(target, entry)
  let rec = entries.get(key)
  if (!rec) {
    rec = blank(String(target))
    entries.set(key, rec)
  }
  return rec
}

/** 项目标签归一：缺省/非字符串统一为 ''（= 无会话 cwd 的调用）。 */
function projectLabel(ctx) {
  const raw = ctx && typeof ctx === 'object' ? ctx.project : ''
  return typeof raw === 'string' ? raw.trim() : ''
}

function blankProject() {
  return { injects: 0, hits: 0, expanded: 0, searches: 0, misses: 0, lastSearch: '' }
}

/** 项目级聚合计数（searches/misses 只能在聚合层落，条目级推不出来）。 */
function bumpProject(project, field, n = 1) {
  const key = project || ''
  let rec = projects.get(key)
  if (!rec) {
    rec = blankProject()
    projects.set(key, rec)
  }
  if (field === 'lastSearch') rec.lastSearch = now()
  else rec[field] = (Number(rec[field]) || 0) + n
  pruneProjects()
  return rec
}

/** 条目级项目归属：第 N+1 个项目起归入 __other（防 byProject 键数爆炸）。 */
function bumpEntryProject(rec, project, field, n = 1) {
  const key = project || ''
  if (key === '') return
  let slot = rec.byProject[key]
  if (!slot) {
    const used = Object.keys(rec.byProject).filter((k) => k !== '__other')
    if (used.length >= MAX_PROJECTS_PER_ENTRY) {
      slot = rec.byProject.__other || (rec.byProject.__other = { inj: 0, hit: 0, exp: 0 })
    } else {
      slot = rec.byProject[key] = { inj: 0, hit: 0, exp: 0 }
    }
  }
  const prop = field === 'injects' ? 'inj' : field === 'hits' ? 'hit' : 'exp'
  slot[prop] = (Number(slot[prop]) || 0) + n
}

function pruneProjects() {
  if (projects.size <= MAX_PROJECT_KEYS) return
  const sorted = Array.from(projects.entries()).sort((a, b) => (a[1].lastSearch < b[1].lastSearch ? -1 : 1))
  for (let i = 0; i < projects.size - MAX_PROJECT_KEYS; i++) projects.delete(sorted[i][0])
}

/**
 * 记录「定向查询命中」：list 带 filter 时返回的条目。
 * @param {string} target
 * @param {string[]} list
 * @param {{ project?: string }} [ctx] - 发起查询的会话项目 hash（可缺省）
 */
export function recordRetrieval(target, list, ctx = {}) {
  try {
    if (!Array.isArray(list) || list.length === 0) return
    const stamp = now()
    const project = projectLabel(ctx)
    for (const entry of list) {
      const rec = touch(target, entry)
      rec.hits += 1
      rec.lastRetrieved = stamp
      bumpEntryProject(rec, project, 'hits')
    }
    bumpProject(project, 'hits', list.length)
    dirty = true
    schedule(RETRIEVAL_FLUSH_MS)
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
}

/**
 * 记录一次**定向查询事件**（list 带 filter，命中与否都算一次）：
 *   searches +1；有结果走 recordRetrieval 记 hits；**零结果记 misses +1**。
 * misses 是「该查未查/降级后找不到」的唯一直接证据——旧版只记命中，
 * 因此「0 命中」既可能是没用过、也可能是查了没查到，无法区分。
 * @param {string} target
 * @param {{ results?: string[], filter?: string, project?: string }} [ctx]
 */
export function recordQuery(target, ctx = {}) {
  try {
    const project = projectLabel(ctx)
    bumpProject(project, 'searches')
    bumpProject(project, 'lastSearch')
    const results = Array.isArray(ctx.results) ? ctx.results : []
    if (results.length === 0) {
      bumpProject(project, 'misses')
      dirty = true
      schedule(RETRIEVAL_FLUSH_MS)
      return
    }
    recordRetrieval(target, results, { project })
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
}

/** 记录「expand 取回全文」（同时算一次命中）。 */
export function recordExpanded(target, entry, ctx = {}) {
  try {
    if (!entry) return
    const stamp = now()
    const project = projectLabel(ctx)
    const rec = touch(target, entry)
    rec.hits += 1
    rec.expanded += 1
    rec.lastRetrieved = stamp
    bumpEntryProject(rec, project, 'expanded')
    bumpProject(project, 'expanded')
    dirty = true
    schedule(RETRIEVAL_FLUSH_MS)
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
}

/** 记录「本轮注入了哪些条目」（每回合快照渲染一次）。 */
export function recordInjection(target, list, ctx = {}) {
  try {
    if (!Array.isArray(list) || list.length === 0) return
    const stamp = now()
    const project = projectLabel(ctx)
    for (const entry of list) {
      const rec = touch(target, entry)
      rec.injects += 1
      rec.lastInjected = stamp
      bumpEntryProject(rec, project, 'injects')
    }
    bumpProject(project, 'injects', list.length)
    dirty = true
    schedule(INJECT_FLUSH_MS)
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
}

function lastTouch(rec) {
  return rec.lastRetrieved > rec.lastInjected ? rec.lastRetrieved : rec.lastInjected
}

function prune() {
  if (entries.size <= MAX_KEYS) return
  const sorted = Array.from(entries.entries()).sort((a, b) => (lastTouch(a[1]) < lastTouch(b[1]) ? -1 : 1))
  const drop = entries.size - MAX_KEYS
  for (let i = 0; i < drop; i++) entries.delete(sorted[i][0])
}

/** 立即落盘（测试与进程收尾用）。返回是否写入成功。 */
export function flushUsage() {
  cancelTimer()
  if (!dirty || usageDir === null) return false
  try {
    prune()
    mkdirSync(usageDir, { recursive: true })
    const payload = {
      version: 1,
      updatedAt: now(),
      entries: Object.fromEntries(entries),
      projects: Object.fromEntries(projects),
    }
    const file = usageFilePath()
    const tmp = file + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8')
    renameSync(tmp, file) // 原子替换：读者永远看不到半截文件
    dirty = false
    return true
  } catch (error) {
    lastError = String(error?.message ?? error)
    return false
  }
}

/** 读回当前统计（内存态；测试用）。 */
export function readUsage() {
  if (!loaded) load()
  return { version: 1, entries: Object.fromEntries(entries), projects: Object.fromEntries(projects) }
}

/** 测试用：清空内存态与定时器（不删文件）。 */
export function resetUsageState() {
  cancelTimer()
  usageDir = null
  entries = new Map()
  projects = new Map()
  loaded = false
  dirty = false
  lastError = ''
}

function schedule(delayMs) {
  try {
    const due = Date.now() + delayMs
    if (timer !== null && timerDue <= due) return
    cancelTimer()
    timerDue = due
    timer = setTimeout(() => {
      timer = null
      flushUsage()
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref() // 不阻止进程退出
  } catch (error) {
    lastError = String(error?.message ?? error)
  }
}

function cancelTimer() {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  timerDue = 0
}

// 进程退出前尽力落盘（宿主正常退出/插件停用时）。
try {
  process.on('exit', () => { if (dirty) flushUsage() })
} catch { /* 忽略 */ }
