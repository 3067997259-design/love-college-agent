// DeepTech 跨产物一致性实验装置（2026-10-17）。
// 目的：在冻结的合成经历集上，对照"旧选择规则"与"依赖新鲜性守卫（F1）"，
// 回答：上层摘要依赖的子摘要被纠正后，过期的上层摘要还会不会进入可见上下文，代价是什么。
//
// 三种情形都要覆盖，否则结论会偏：
//   pending  纠正已发生、上层摘要尚未重建（只有过期版本）
//   rebuilt  纠正已发生、上层摘要已按新子摘要重建（新旧版本共存）
//   control  没有任何纠正（守卫精度：不得误伤）
//
// 做法：真实 projectMemory 从日志投影摘要 → 真实 summaryReferences / validSummaries 选择
// → 真实 createMemoryService().prepareContext 端到端确认（fake 模型、统一时钟、临时数据根）。
// 不调真实模型、不发网络、不读 secrets。
//
// 冻结纪律：开发集可逐条查看；留出集需要 --holdout 显式打开，装置冻结后只跑一次。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(s, c, n) {
    try { return n(s, c) } catch (e) {
      if (s.startsWith('.')) for (const x of [s + '.ts', s + '/index.ts']) { try { return n(x, c) } catch { /* 试下一个后缀 */ } }
      throw e
    }
  },
  load(u, c, n) {
    if (u.endsWith('.json')) {
      const r = n(u, { ...c, importAttributes: { type: 'json' } })
      return { format: 'module', source: 'export default ' + Buffer.from(r.source).toString('utf8'), shortCircuit: true }
    }
    return n(u, c)
  },
})

const { createManualClock } = await import('../src/main/clock/index.ts')
const { openJournal } = await import('../src/main/journal/file.ts')
const { projectJournal } = await import('../src/main/journal/projection.ts')
const { projectMemory } = await import('../src/main/memory/projection.ts')
const { createScheduler } = await import('../src/main/scheduler/index.ts')
const { createMemoryService } = await import('../src/main/memory/service.ts')
const { createFakeMemoryModel } = await import('../src/main/memory/model.ts')
const { summaryReferences, validSummaries } = await import('../src/main/memory/hierarchy.ts')

const OWNER = { userId: 'u:exp', characterId: 'c:exp' }
const STALE_DAY = '2026-08-10'
// 纠正后重新生成的日摘要属于同一个 dayKey，只是 id 带版本后缀——这正是真实机制：
// 同一天重新摘要后同周期出现新版本，旧版本不再是该周期的 head。
const LIVE_DAY = STALE_DAY
const STALE_TEXT = '活动在周五'
const LIVE_TEXT = '活动改到周六'
const OTHER_TEXT = '活动在工作日'
const WIDER = { month: { level: 'month', period: '2026-08' }, week: { level: 'week', period: '2026-08-10' } }

/**
 * 冻结经历集。scenario 决定状态构造：
 *   pending  有 live 日摘要、无重建的上层摘要
 *   rebuilt  有 live 日摘要、且上层摘要已按它重建
 *   control  无纠正；可选 unrelated（另一主题换版本）或 planOnly（只加计划）
 */
const ep = (id, wider, scenario, desc, extra = {}) => ({ id, partition: id.startsWith('dev') ? 'dev' : 'holdout', wider, scenario, desc, ...extra })
const EPISODES = [
  // ---------------- 开发集 ----------------
  ep('dev-n1', 'month', 'rebuilt', '近期回看、月摘要已重建', { window: 'near' }),
  ep('dev-n2', 'month', 'pending', '近期回看、月摘要尚未重建', { window: 'near' }),
  ep('dev-n3', 'week', 'rebuilt', '近期回看、周摘要已重建', { window: 'near' }),
  ep('dev-n4', 'week', 'pending', '近期回看、周摘要尚未重建', { window: 'near' }),
  ep('dev-f1', 'month', 'rebuilt', '久远回看、月摘要已重建', { window: 'far' }),
  ep('dev-f2', 'month', 'pending', '久远回看、月摘要尚未重建', { window: 'far', staleText: '地点在一号楼', liveText: '地点改到三号楼' }),
  ep('dev-f3', 'week', 'rebuilt', '久远回看、周摘要已重建', { window: 'far' }),
  ep('dev-f4', 'week', 'pending', '久远回看、周摘要尚未重建', { window: 'far', staleText: '提交在下周二', liveText: '提交改到下周三' }),
  ep('dev-c1', 'month', 'control', '无纠正：月摘要必须保持有效', { window: 'near' }),
  ep('dev-c2', 'week', 'control', '无纠正：周摘要必须保持有效', { window: 'near' }),
  ep('dev-c3', 'month', 'control', '只新增计划：月摘要必须保持有效', { window: 'near', planOnly: true }),
  ep('dev-c4', 'month', 'control', '无关主题追加：月摘要必须保持有效', { window: 'near', unrelated: true }),
  // ---------------- 留出集（装置冻结后只跑一次）----------------
  ep('hold-n1', 'month', 'rebuilt', '近期／月／已重建', { window: 'near', staleText: '集合地点在东门', liveText: '集合地点改到西门' }),
  ep('hold-n2', 'week', 'pending', '近期／周／未重建', { window: 'near', staleText: '教室在三楼', liveText: '教室改到五楼' }),
  ep('hold-f1', 'month', 'rebuilt', '久远／月／已重建', { window: 'far', staleText: '值班每周一次', liveText: '值班改成双周一次' }),
  ep('hold-f2', 'month', 'pending', '久远／月／未重建', { window: 'far', staleText: '导师是李老师', liveText: '导师改成王老师' }),
  ep('hold-f3', 'week', 'rebuilt', '久远／周／已重建', { window: 'far', staleText: '小组是四人一组', liveText: '小组改成三人一组' }),
  ep('hold-f4', 'week', 'pending', '久远／周／未重建', { window: 'far', staleText: '实验课需要预习报告', liveText: '实验课不再需要预习报告' }),
  ep('hold-f5', 'month', 'pending', '久远／月／未重建（另一条事实）', { window: 'far', staleText: '答辩在十四号上午', liveText: '答辩改到十五号下午' }),
  ep('hold-f6', 'month', 'pending', '久远／月／未重建（人名）', { window: 'far', staleText: '负责人是小林', liveText: '负责人改成小周' }),
  ep('hold-c1', 'month', 'control', '无纠正', { window: 'near' }),
  ep('hold-c2', 'week', 'control', '无纠正', { window: 'near' }),
  ep('hold-c3', 'month', 'control', '只新增计划', { window: 'near', planOnly: true }),
  ep('hold-c4', 'week', 'control', '无关主题追加', { window: 'near', unrelated: true }),
]

const seen = (day, suffix = '') => ({ id: 'seen-' + day + suffix, sessionId: 's:' + day + suffix, frameSeq: 2, index: 0, offset: 0, atMs: Date.parse(day + 'T12:00:00+08:00') })
/** 同一天重新生成的日摘要共用同一个 sessionId（那是同一页），只有 id 带版本后缀。 */
const dayRow = (day, text, suffix = '', session = 's:' + day + suffix) => ({ id: 'day-' + day + suffix, level: 'day', period: day, text, sources: [seen(day, suffix)], sourceSessionIds: [session], source: 'fake' })
const widerRow = (level, period, text, parentIds, sources, id) => ({ id, level, period, text, sources, sourceSessionIds: [...new Set(sources.map((item) => item.sessionId))], parentSummaryIds: parentIds, source: 'fake' })

/** 构造一条经历在某一天被回看时的摘要状态。返回的 rows 会被真实 projectMemory 重新投影。 */
function stateOf(episode) {
  const wider = WIDER[episode.wider]
  const staleText = episode.staleText ?? STALE_TEXT
  const liveText = episode.liveText ?? LIVE_TEXT
  const staleSession = 's:' + STALE_DAY
  const rows = []
  const staleDay = dayRow(STALE_DAY, staleText)
  const staleWider = widerRow(wider.level, wider.period, staleText, [staleDay.id], staleDay.sources, wider.level + '-v1')
  rows.push(staleDay, staleWider)
  const oldSession = staleSession
  if (episode.scenario === 'control') {
    // 控制：该来源日没有被重新摘要，上层摘要的依赖仍然新鲜。
    if (episode.unrelated) rows.push(dayRow('2026-08-20', OTHER_TEXT + '（无关主题）'))
    else if (episode.planOnly) rows.push(dayRow('2026-08-20', '计划：周六去图书馆'))
    return { rows, wider, staleText, expectedText: staleText, oldSession, today: later('2026-08-10', 3) }
  }
  // 纠正：同一天重新摘要，同一 sessionId 出现新版本，旧版本不再是该周期的 head。
  const liveDay = dayRow(LIVE_DAY, liveText, '-v2', staleSession)
  rows.push(liveDay)
  if (episode.scenario === 'rebuilt') rows.push(widerRow(wider.level, wider.period, liveText, [liveDay.id], liveDay.sources, wider.level + '-v2'))
  // near：纠正就在几天内，日摘要仍在 7 天窗口内（近期经历）。far：几周后回看（久远经历），
  // 日摘要滑出窗口，更宽的摘要成为该会话唯一代表——这正是审计发现问题的场景。
  return { rows, wider, staleText, expectedText: liveText, oldSession, today: episode.window === 'far' ? later(LIVE_DAY, 31) : later(LIVE_DAY, 3) }
}

const describe = (list) => list.length ? list.map((summary) => summary.id + '(' + summary.text + ')').join(' + ') : '(空)'
let CLOCK
const later = (day, days) => CLOCK.iso(CLOCK.parse(day + 'T12:00:00+08:00') + days * 86400000).slice(0, 10)

/** 端到端：真实服务在同样摘要状态下准备上下文，取上一段经历那一条。 */
async function confirmThroughService(state, today) {
  const root = mkdtempSync(join(tmpdir(), 'lca-exp-'))
  const clock = createManualClock(0)
  clock.advanceBy(clock.parse(today + 'T12:00:00+08:00'))
  const journal = openJournal(root, OWNER, clock)
  try {
    const store = { scope: journal.scope, records: journal.records, projection: () => projectJournal(journal.records()), append: journal.append, close: journal.close }
    const repository = { view: () => projectMemory(journal.records()), append: journal.append, refresh: () => {}, close: () => {} }
    for (const summary of state.rows) {
      try { repository.append({ type: 'memory/summary', summary }) }
      catch (cause) { throw new Error('装置构造的状态行被日志拒绝: ' + JSON.stringify(summary), { cause }) }
    }
    const turn = (id, text) => {
      store.append({ type: 'user/message', id, text, requestId: id, commandHash: 'exp' })
      store.append({ type: 'turn/start', turnId: id, trigger: 'user' })
      store.append({ type: 'inbox/drain', ids: [id] })
      const messages = store.projection().context
      store.append({ type: 'model/seen', turnId: id, source: 'fake', messages, eligibleIndexes: messages.flatMap((message, index) => message.role === 'system' ? [] : [index]) })
      store.append({ type: 'assistant/message', turnId: id, id: 'r-' + id, text: 'SYNTHETIC', status: 'complete' })
      store.append({ type: 'turn/end', turnId: id, reason: 'completed' })
    }
    const scheduler = createScheduler(clock); const fake = createFakeMemoryModel()
    const memory = createMemoryService({ clock, scheduler, store, repository, model: fake.model, development: fake, isBusy: () => false, rolled: () => {}, changed: () => {} })
    scheduler.cancel('memory.maintenance')
    turn('t1', '今天把这件事记一下。')
    const prepared = await memory.prepareContext('t2', new AbortController().signal)
    const reference = prepared.messages.filter((message) => message.content.includes('previousDaysReference')).map((message) => message.content).join('\n')
    const projected = repository.view().summaries.length
    await memory.close(); scheduler.dispose()
    return { projected, hasStale: reference.includes(state.staleText), hasExpected: reference.includes(state.expectedText), reference }
  } finally {
    journal.close()
    if (resolve(root).startsWith(join(resolve(tmpdir()), 'lca-exp-'))) rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const wantHoldout = process.argv.includes('--holdout')
  const asJson = process.argv.includes('--json')
  CLOCK = createManualClock(0)
  const episodes = wantHoldout ? EPISODES : EPISODES.filter((episode) => episode.partition === 'dev')
  const results = []
  for (const episode of episodes) {
    const state = stateOf(episode)
    const valid = validSummaries(state.rows)
    const oldRule = summaryReferences(state.rows, 's:today', state.today, CLOCK)
    const newRule = summaryReferences(valid, 's:today', state.today, CLOCK)
    const service = await confirmThroughService(state, state.today)
    results.push({
      id: episode.id, partition: episode.partition, scenario: episode.scenario, wider: episode.wider,
      desc: episode.desc, today: state.today, summaries: state.rows.length,
      oldSelection: describe(oldRule), newSelection: describe(newRule),
      oldStale: oldRule.some((summary) => summary.text.includes(state.staleText)),
      newStale: newRule.some((summary) => summary.text.includes(state.staleText)),
      oldCovers: oldRule.some((summary) => summary.sourceSessionIds.includes(state.oldSession)),
      newCovers: newRule.some((summary) => summary.sourceSessionIds.includes(state.oldSession)),
      oldCurrent: oldRule.some((summary) => summary.text.includes(state.expectedText)),
      newCurrent: newRule.some((summary) => summary.text.includes(state.expectedText)),
      invalidated: state.rows.filter((row) => !valid.some((kept) => kept.id === row.id)).map((row) => row.id),
      oldRebuilds: state.rows.length,
      newRebuilds: valid.filter((row) => row.parentSummaryIds && !row.parentSummaryIds.every((parentId) => state.rows.some((other) => other.id === parentId))).length,
      serviceStale: service.hasStale, serviceExpected: service.hasExpected, serviceProjected: service.projected,
    })
  }
  const tally = (pick) => results.reduce((total, item) => total + (pick(item) ? 1 : 0), 0)
  const corrected = results.filter((r) => r.scenario !== 'control')
  const controls = results.filter((r) => r.scenario === 'control')
  const unrelatedOrPlan = results.filter((r) => r.scenario === 'control' && r.id.includes('m3') || r.id.includes('m4') || r.id.includes('w3') || r.id.includes('m4') || r.desc.includes('无关') || r.desc.includes('计划'))
  const agree = tally((r) => r.serviceStale === r.newStale)
  const change = results.filter((r) => r.oldSelection !== r.newSelection)

  console.log('=== 逐条 ===')
  for (const r of results) {
    console.log(r.id.padEnd(8) + ' ' + r.scenario.padEnd(8) + ' 摘要' + r.summaries +
      '  旧规则[' + (r.oldStale ? '过期' : '干净') + (r.oldCovers ? ' 有代表' : ' 缺代表') + ']' +
      '  新规则[' + (r.newStale ? '过期' : '干净') + (r.newCovers ? ' 有代表' : ' 缺代表') + ']' +
      '  失效=' + (r.invalidated.join(',') || '-') + '  服务一致=' + (r.serviceStale === r.newStale ? 'Y' : 'N'))
  }
  console.log('\n=== 汇总（' + (wantHoldout ? '开发集+留出集' : '仅开发集') + '，' + results.length + ' 条）===')
  console.log('过期事实进入可见上下文：旧规则 ' + tally((r) => r.oldStale) + '，新规则 ' + tally((r) => r.newStale))
  console.log('旧会话仍有摘要代表：   旧规则 ' + tally((r) => r.oldCovers) + '，新规则 ' + tally((r) => r.newCovers))
  console.log('内容是当前说法：       旧规则 ' + tally((r) => r.oldCurrent) + '，新规则 ' + tally((r) => r.newCurrent))
  console.log('纠正类条目（' + corrected.length + '）中：旧规则过期 ' + corrected.filter((r) => r.oldStale).length + '，新规则过期 ' + corrected.filter((r) => r.newStale).length)
  console.log('pending 情形（' + corrected.filter((r) => r.scenario === 'pending').length + '）缺代表：旧 ' + corrected.filter((r) => r.scenario === 'pending' && !r.oldCovers).length + '，新 ' + corrected.filter((r) => r.scenario === 'pending' && !r.newCovers).length)
  console.log('rebuilt 情形（' + corrected.filter((r) => r.scenario === 'rebuilt').length + '）缺代表：旧 ' + corrected.filter((r) => r.scenario === 'rebuilt' && !r.oldCovers).length + '，新 ' + corrected.filter((r) => r.scenario === 'rebuilt' && !r.newCovers).length)
  console.log('守卫精度：控制组 ' + controls.length + ' 条中选择发生变化 ' + controls.filter((r) => r.oldSelection !== r.newSelection).length + ' 条；含无关更新/计划条目被误伤 ' + unrelatedOrPlan.filter((r) => r.invalidated.length > 0).length + '/' + unrelatedOrPlan.length)
  console.log('真实 prepareContext 与选择规则一致：' + agree + '/' + results.length)
  console.log('\n配对变化（旧 → 新）：')
  for (const r of change) console.log('  ' + r.id + '  ' + r.oldSelection + '  →  ' + r.newSelection)
  if (asJson) console.log('\nJSON ' + JSON.stringify({ episodes: results.length, staleOld: tally((r) => r.oldStale), staleNew: tally((r) => r.newStale), coverOld: tally((r) => r.oldCovers), coverNew: tally((r) => r.newCovers), currentOld: tally((r) => r.oldCurrent), currentNew: tally((r) => r.newCurrent), controlChanges: controls.filter((r) => r.oldSelection !== r.newSelection).length, serviceAgrees: agree }))
  assert.equal(agree, results.length, '服务端实际上下文必须与选择规则一致')
  assert.equal(results.length, wantHoldout ? 24 : 12, '条目数必须等于冻结集大小')
}

await main()
