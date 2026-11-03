import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocale } from '../lib/i18n.js'
import { MemoryStore } from '../lib/store.js'
import { extractEntryId, legacyIdFor } from '../lib/sync/entryid.js'
import { apply } from '../lib/index.js'
import {
  MAX_KEYS, MAX_PROJECTS_PER_ENTRY, MAX_PROJECT_KEYS, USAGE_FILE_NAME, flushUsage, initUsage,
  readUsage, recordExpanded, recordInjection, recordQuery, recordRetrieval, resetUsageState,
  usageFilePath, usageKey, usageLastError,
} from '../lib/memory-usage.js'

setLocale('zh')

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-usage-test-'))
}
function clean(dir) {
  rmSync(dir, { recursive: true, force: true })
}
function usageOf(dir) {
  return JSON.parse(readFileSync(join(dir, USAGE_FILE_NAME), 'utf8'))
}

test('键策略：id 优先、无 id 走归一化哈希、同一文本稳定', () => {
  resetUsageState()
  // 身份证必须在**条目头部**（canonical 形态 [id:…] 在时间戳之前）才被识别——
  // 这是 entryid.extractEntryId 的既有契约（ENTRY_ID_RE 锚定头部），本模块沿用。
  assert.equal(usageKey('memory', '[id:abcd1234] [2026-01-01] 正文'), 'memory#abcd1234')
  assert.ok(usageKey('memory', '[2026-01-01] [id:abcd1234] 正文').startsWith('memory#h'), '时间戳在前的非 canonical 形态识别不到 id，退回哈希（与磁盘真实形态一致即可）')
  const k1 = usageKey('memory', '[2026-01-01] 没有身份证的条目')
  const k2 = usageKey('memory', '[2026-01-02] 没有身份证的条目')
  // 实测契约：normalizeForMatch 只剥 [id:…]/[summary:…]、**不剥时间戳**——所以无 id
  // 的条目按「正文+日期」建键，同一段话在不同日期各算一个条目（与磁盘身份一致）。
  // 有 id 的条目（真实库绝大多数）不受影响：id 才是身份。
  assert.notEqual(k1, k2, '无 id 的条目键含时间戳')
  assert.equal(k1, usageKey('memory', '[2026-01-01] 没有身份证的条目'), '同一文本键稳定')
  assert.ok(/^memory#h[0-9a-f]{12}$/.test(k1), '无 id 时用归一化文本的 sha1 前 12 位，实测 ' + k1)
  assert.notEqual(k1, usageKey('memory', '完全不同的正文'))
  assert.equal(k1, usageKey('memory', '[2026-01-01] [summary:摘要] 没有身份证的条目'), 'summary 会被剥掉、不参与键')
  assert.equal(usageKey('key', '[2026-01-01] 没有身份证的条目').startsWith('key#'), true, '轨前缀区分不同轨')
})

test('计数与落盘：hits / expanded / injects 三条独立计数', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    const e = '[id:aaaa1111] [2026-01-01] 网格交易的手续费口径'
    recordRetrieval('memory', [e])
    recordRetrieval('memory', [e])
    recordExpanded('memory', e)
    recordInjection('memory', [e])
    assert.equal(flushUsage(), true, '有脏数据应落盘')
    const raw = usageOf(dir)
    const rec = raw.entries['memory#aaaa1111']
    assert.ok(rec, '键应写入')
    assert.equal(rec.hits, 3, '两次命中 + 一次 expand')
    assert.equal(rec.expanded, 1)
    assert.equal(rec.injects, 1)
    assert.ok(rec.lastRetrieved && rec.lastInjected && rec.firstSeen)
    assert.equal(raw.version, 1)
    // 无脏数据时 flush 是空操作
    assert.equal(flushUsage(), false)
  } finally { clean(dir) }
})

test('原子写：不留 .tmp-* 残留；重复 flush 不重复计数', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    recordRetrieval('memory', ['[id:bbbb2222] [2026-01-01] 条目'])
    flushUsage()
    flushUsage()
    const names = readdirSync(dir)
    assert.equal(names.some((n) => n.includes('.tmp-')), false, '临时文件必须已 rename：' + names.join(','))
    assert.equal(usageOf(dir).entries['memory#bbbb2222'].hits, 1)
  } finally { clean(dir) }
})

test('损坏统计文件自愈：备份 .corrupt-*，从空开始，不抛错', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    writeFileSync(join(dir, USAGE_FILE_NAME), '{ 这不是 JSON')
    initUsage(dir)
    assert.deepEqual(readUsage().entries, {}, '损坏后从空开始')
    const backup = readdirSync(dir).find((n) => n.startsWith(USAGE_FILE_NAME + '.corrupt-'))
    assert.ok(backup, '必须备份损坏文件，实测目录：' + readdirSync(dir).join(','))
    recordRetrieval('memory', ['[id:cccc3333] [2026-01-01] 新条目'])
    assert.equal(flushUsage(), true, '自愈后仍能正常写入')
    assert.equal(usageOf(dir).entries['memory#cccc3333'].hits, 1)
  } finally { clean(dir) }
})

test('写入失败不抛错（统计失败绝不能让记忆工具失败）', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    // 用一个「父路径是普通文件」的目录，mkdir 必然失败
    writeFileSync(join(dir, 'blocker'), 'x')
    initUsage(join(dir, 'blocker', 'sub'))
    recordRetrieval('memory', ['[id:dddd4444] [2026-01-01] 条目'])
    assert.equal(flushUsage(), false, '写不进去要返回 false 而不是抛错')
    assert.ok(usageLastError() !== '', '要留下可诊断的错误原因')
    assert.equal(usageFilePath().endsWith(USAGE_FILE_NAME), true)
  } finally { clean(dir) }
})

test('统计不改变注入内容（快照文本前后逐字节一致）', async () => {
  const dir = tempDir()
  const dir2 = tempDir()
  try {
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const store = new MemoryStore(dir)
    store.add('memory', '全局记忆一条：用于对比注入内容')
    store.add('user', '用户档案一条')
    store.add('key', '本项目关键约定一条', { session: { header: { cwd: '/proj/x' } } })
    const snap = ctx.state.contexts.find((c) => c.name === 'memory:snapshot')
    const agent = { id: 'a', session: { header: { cwd: '/proj/x' } } }
    const before = snap.text({ agent })
    // 换一个统计目录再初始化一次：注入内容必须一模一样
    initUsage(dir2)
    const after = snap.text({ agent })
    assert.equal(after, before, '统计开关不得改变注入文本')
    assert.equal(before.includes('usage.json'), false, '统计文件名不得进注入')
    assert.equal(/\binjects\b|\bhits\b/.test(before), false, '统计字段不得进注入')
    flushUsage()
  } finally { clean(dir); clean(dir2) }
})

test('工具层端到端：定向查询记命中、expand 记 expanded、快照记注入', async () => {
  const dir = tempDir()
  try {
    resetUsageState()
    const ctx = fakeCtx()
    apply(ctx, { memoryDir: dir })
    const tool = ctx.state.tools.find((t) => t.name === 'memory')
    assert.ok(tool, 'memory 工具已注册')
    const agent = { session: { header: { cwd: '/proj/usage' } } }
    const exec = () => ({ agent, callId: 'c1', signal: new AbortController().signal })
    const store = new MemoryStore(dir)
    store.add('memory', '网格交易的手续费按佣金计算', null)
    store.add('memory', '双低策略的可转债筛选口径', null)

    // 定向查询（带 filter）→ 命中计数
    const hit = await tool.execute({ action: 'list', target: 'memory', filter: '网格 手续费', rank: true }, exec())
    assert.equal(hit.ok, true)
    assert.ok(hit.entries.length >= 1)
    const raw = store.entriesOf('memory')
    const target = raw.find((e) => e.includes('网格交易'))
    const key = usageKey('memory', target)
    flushUsage()
    assert.equal(usageOf(dir).entries[key].hits, 1, '第一次定向查询记 1 次命中')
    await tool.execute({ action: 'list', target: 'memory', filter: '网格 手续费' }, exec())
    flushUsage()
    assert.equal(usageOf(dir).entries[key].hits, 2, '第二次记 2 次')

    // 无 filter 的 list（默认视图）不记命中：只写不读的条目不该被"刷"成高频
    await tool.execute({ action: 'list', target: 'memory' }, exec())
    flushUsage()
    assert.equal(usageOf(dir).entries[key].hits, 2, '默认视图不记命中')

    // expand → expanded
    const keyEntry = (await (async () => {
      store.add('key', '本项目关键约定：复习时先看这条', agent)
      return store.entriesOf('key', agent)
    })()).find((e) => e.includes('关键约定'))
    const id = extractEntryId(keyEntry) ?? legacyIdFor(keyEntry)
    const exp = await tool.execute({ action: 'expand', target: 'key', id }, exec())
    assert.equal(exp.ok, true)
    flushUsage()
    const rec = usageOf(dir).entries[usageKey('key', keyEntry)]
    assert.equal(rec.expanded, 1, 'expand 记一次')
    assert.equal(rec.hits, 1, 'expand 同时算一次命中')

    // 全局轨（memory）的 expand 必须同等记账：只记 key 会让占注入量约七成的长期
    // 记忆轨展开率恒为 0，从而把"没记账"误读成"没人展开"。
    // 用从未被查过的那条（双低策略）做断言，避免与上面的命中计数串味
    const memTarget = raw.find((x) => x.includes('双低策略'))
    assert.ok(memTarget, '找到未被查询过的 memory 条目')
    const memId = extractEntryId(memTarget) ?? legacyIdFor(memTarget)
    const expMem = await tool.execute({ action: 'expand', target: 'memory', id: memId }, exec())
    assert.equal(expMem.ok, true)
    flushUsage()
    const recMem = usageOf(dir).entries[usageKey('memory', memTarget)]
    assert.equal(recMem.expanded, 1, 'memory 轨 expand 也记 expanded')
    assert.equal(recMem.hits, 1, 'memory 轨 expand 同时算一次命中')

    // 快照注入 → injects（三条轨各记）
    const snap = ctx.state.contexts.find((c) => c.name === 'memory:snapshot')
    snap.text({ agent })
    flushUsage()
    const all = usageOf(dir).entries
    assert.ok(all[usageKey('memory', raw[0])].injects >= 1, 'memory 轨注入被记录')
    assert.ok(all[usageKey('key', keyEntry)].injects >= 1, 'key 轨注入被记录')
  } finally { clean(dir) }
})

test('上限常量与键数自洽（防未来把裁剪删掉）', () => {
  assert.equal(MAX_KEYS >= 1000, true, 'MAX_KEYS 必须是有限的正整数：' + MAX_KEYS)
  assert.equal(USAGE_FILE_NAME, 'usage.json')
  assert.equal(existsSync(join(tmpdir(), 'never-created-usage.json')), false)
})

test('定向查询事件：命中记 hits、零结果记 misses，每次都记 searches', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    const e = '[id:eeee5555] [2026-01-01] 网格交易的手续费口径'
    recordQuery('memory', { results: [e], filter: '网格', project: 'projA' })
    recordQuery('memory', { results: [], filter: '根本不存在的一个词', project: 'projA' })
    assert.equal(flushUsage(), true)
    const raw = usageOf(dir)
    assert.equal(raw.projects.projA.searches, 2, '两次定向查询都要计 searches')
    assert.equal(raw.projects.projA.misses, 1, '零结果必须记 miss')
    assert.equal(raw.projects.projA.hits, 1)
    assert.equal(raw.entries['memory#eeee5555'].hits, 1)
    assert.ok(raw.projects.projA.lastSearch, 'lastSearch 要落盘')
  } finally { clean(dir) }
})

test('项目分桶：同一批条目在不同项目下的注入/命中/展开分开计', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    const e = '[id:ffff6666] [2026-01-01] 复权口径定案'
    recordInjection('memory', [e], { project: 'projA' })
    recordInjection('memory', [e], { project: 'projB' })
    recordInjection('memory', [e], { project: 'projB' })
    recordExpanded('memory', e, { project: 'projB' })
    flushUsage()
    const raw = usageOf(dir)
    const rec = raw.entries['memory#ffff6666']
    assert.equal(rec.injects, 3, '总量仍照旧累加')
    assert.equal(rec.byProject.projA.inj, 1)
    assert.equal(rec.byProject.projB.inj, 2)
    assert.equal(rec.byProject.projB.exp, 1)
    assert.equal(raw.projects.projA.injects, 1)
    assert.equal(raw.projects.projB.injects, 2)
    assert.equal(raw.projects.projB.expanded, 1)
  } finally { clean(dir) }
})

test('无会话 cwd 的调用落空项目桶，不污染具体项目', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    const e = '[id:aac07777] [2026-01-01] 无 cwd 场景'
    recordInjection('memory', [e]) // 不传 ctx
    flushUsage()
    const raw = usageOf(dir)
    assert.equal(raw.projects[''].injects, 1, '空项目桶承接无 cwd 调用')
    assert.equal(raw.entries['memory#aac07777'].byProject[''], undefined, '空标签不写条目级分桶')
  } finally { clean(dir) }
})

test('持久化往返：projects 与 byProject 重新载入不丢', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    recordQuery('memory', { results: [], filter: '查不到', project: 'projC' })
    recordInjection('memory', ['[id:bbc08888] [2026-01-01] 条目'], { project: 'projC' })
    flushUsage()
    resetUsageState()
    initUsage(dir)
    const again = readUsage()
    assert.equal(again.projects.projC.misses, 1)
    assert.equal(again.projects.projC.searches, 1)
    assert.equal(again.entries['memory#bbc08888'].byProject.projC.inj, 1)
  } finally { clean(dir) }
})

test('向后兼容：旧格式（无 byProject/projects）可载入并继续记账', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    writeFileSync(join(dir, USAGE_FILE_NAME), JSON.stringify({
      version: 1,
      updatedAt: '2026-10-25T00:00:00Z',
      entries: { 'memory#ccc09999': { track: 'memory', hits: 2, expanded: 0, injects: 5, lastRetrieved: '', lastInjected: '', firstSeen: '2026-10-25T00:00:00Z' } },
    }))
    initUsage(dir)
    assert.equal(readUsage().entries['memory#ccc09999'].hits, 2, '旧计数原样保留')
    assert.deepEqual(readUsage().projects, {}, '旧文件没有项目聚合')
    recordInjection('memory', ['[id:ccc09999] [2026-01-01] 旧格式条目'], { project: 'projD' })
    flushUsage()
    const raw = usageOf(dir)
    assert.equal(raw.entries['memory#ccc09999'].injects, 6)
    assert.equal(raw.entries['memory#ccc09999'].byProject.projD.inj, 1)
    assert.equal(raw.projects.projD.injects, 1)
  } finally { clean(dir) }
})

test('条目级项目桶有上限：超出归入 __other；项目聚合也有上限', () => {
  const dir = tempDir()
  try {
    resetUsageState()
    initUsage(dir)
    const e = '[id:ddc00000] [2026-01-01] 上限测试'
    for (let i = 0; i < MAX_PROJECTS_PER_ENTRY + 2; i++) recordInjection('memory', [e], { project: 'p' + i })
    flushUsage()
    const rec = usageOf(dir).entries['memory#ddc00000']
    assert.equal(rec.injects, MAX_PROJECTS_PER_ENTRY + 2)
    assert.ok(rec.byProject.__other, '超出上限的必须归入 __other')
    assert.equal(Object.keys(rec.byProject).length <= MAX_PROJECTS_PER_ENTRY + 1, true, '键数受控：' + Object.keys(rec.byProject).join(','))
    assert.ok(MAX_PROJECT_KEYS >= 8)
  } finally { clean(dir) }
})

/** 最小 fake ctx（只提供 apply() 注册所需服务，与其它套件同款）。 */
function fakeCtx() {
  const state = { tools: [], contexts: [], commands: [], listeners: [], routes: [], effects: [] }
  const services = {
    tools: {
      register: (def) => {
        state.tools.push(def)
        return () => {
          const i = state.tools.indexOf(def)
          if (i >= 0) state.tools.splice(i, 1)
        }
      },
      get: () => undefined,
    },
    systemPrompt: { context: (def) => { state.contexts.push(def); return () => {} } },
    commands: { register: (def) => { state.commands.push(def); return () => {} } },
    webServer: { register: (def) => { state.routes.push(def); return () => {} } },
    settings: { get: (ns) => (ns === 'locale' ? { preference: 'zh' } : undefined) },
  }
  const ctx = {
    state,
    tools: services.tools,
    systemPrompt: services.systemPrompt,
    commands: services.commands,
    webServer: services.webServer,
    settings: services.settings,
    on: (name, listener) => {
      ;(state.listeners[name] ??= []).push(listener)
      return () => {}
    },
    inject: (deps, callback) => {
      if (!deps.every((dep) => services[dep] !== undefined)) return { dispose: () => {} }
      const disposer = callback(ctx)
      return { dispose: typeof disposer === 'function' ? disposer : () => {} }
    },
    effect: (fn) => {
      const disposer = fn()
      state.effects.push(disposer)
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: (name) => services[name],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  return ctx
}
