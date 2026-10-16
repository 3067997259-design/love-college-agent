// 心流沙箱「选择性回滚」实验装置（2026-10-17）。
//
// 问题：`desk/change` 记录完整 before/after 快照，而生产里的撤销要求磁盘内容哈希等于该 change 的 after
// （heart-flow/service.ts 的 flow.undo），于是只要同一文件之后被改过，撤销早期修改就会被拒——
// 哪怕后面的修改在完全不同的区域。
//
// 四组对照，全部确定性纯文本运算，零模型、零网络：
//   B0 现有哈希锁   ：只有目标恰为最后一次修改时才能撤销
//   B1 全栈连坐回滚 ：撤销目标及其之后的所有修改
//   B2 朴素行号补丁 ：在记录的原始行号位置反向应用差量，不考虑行号漂移
//   OURS 锚定补丁代数：带上下文的补丁，撤销目标后保留仍能定位的后续补丁
//
// **脚本自带参照实现，不依赖生产模块。** 本轮曾把锚定补丁代数接进 `flow.undo`，但内核在同一批用例上
// 仍不稳定（被反例反复击穿），集成已撤回，只保留可复跑的测量与结论。见
// docs/research/deeptech-flow-undo-experiment-20261017.md。
//
// 指标：选择性撤销成功率（撤销目标且保留全部后续修改）、保留的后续修改比例、
//       以及安全判定（错值 = 不该写入的结果）。
// 开发集可逐条查看；留出集需 --holdout。
import assert from 'node:assert/strict'

/** 参照实现：两个快照之间的单个替换区间，带上下文用于在行号漂移后重新定位。 */
const CONTEXT = 2
const split = (text) => text.length ? text.split('\n') : []
const sameLines = (lines, at, want) => {
  if (!want.length) return true
  if (at < 0 || at + want.length > lines.length) return false
  for (let index = 0; index < want.length; index++) if (lines[at + index] !== want[index]) return false
  return true
}
const splice = (lines, at, removeCount, insert) => [...lines.slice(0, at), ...insert, ...lines.slice(at + removeCount)]
function patchOf(key, before, after) {
  const oldLines = split(before); const newLines = split(after)
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++
  let tail = 0
  while (tail < oldLines.length - head && tail < newLines.length - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++
  return { key, at: head, before: oldLines.slice(head, oldLines.length - tail), after: newLines.slice(head, newLines.length - tail),
    contextBefore: oldLines.slice(Math.max(0, head - CONTEXT), head), contextAfter: oldLines.slice(oldLines.length - tail, oldLines.length - tail + CONTEXT) }
}
const spanMatches = (lines, patch, at, region) => at >= 0 && at + region.length <= lines.length
  && sameLines(lines, at - patch.contextBefore.length, patch.contextBefore)
  && sameLines(lines, at, region)
  && sameLines(lines, at + region.length, patch.contextAfter)
const insertionMatches = (lines, patch, at) => {
  if (at < 0 || at > lines.length) return false
  const before = sameLines(lines, at - patch.contextBefore.length, patch.contextBefore)
  const after = patch.contextAfter.length ? sameLines(lines, at, patch.contextAfter) : at === lines.length
  if (patch.contextBefore.length && patch.contextAfter.length) return before || after
  return before && after
}
function find(lines, patch, region, window = 500) {
  const scan = (matches) => {
    if (matches(patch.at)) return patch.at
    for (let shift = 1; shift <= window; shift++) {
      if (matches(patch.at + shift)) return patch.at + shift
      if (matches(patch.at - shift)) return patch.at - shift
    }
    return undefined
  }
  return region.length ? scan((at) => spanMatches(lines, patch, at, region)) : scan((at) => insertionMatches(lines, patch, at))
}
const applyPatch = (text, patch) => {
  const lines = split(text); const at = find(lines, patch, patch.before)
  return at === undefined ? undefined : splice(lines, at, patch.before.length, patch.after).join('\n')
}
const revertPatch = (text, patch) => {
  const lines = split(text); const at = find(lines, patch, patch.after)
  return at === undefined ? undefined : splice(lines, at, patch.after.length, patch.before).join('\n')
}
const isApplied = (text, patch) => find(split(text), patch, patch.after) !== undefined
/** 失败关闭：只要有一个后续补丁保不住就整体拒绝，绝不写回丢失用户后续工作的文件。 */
function undoPatch(text, target, later) {
  const undone = revertPatch(text, target)
  if (undone === undefined) return undefined
  let current = undone
  for (const patch of later) {
    if (isApplied(current, patch)) continue
    const restored = applyPatch(current, patch)
    if (restored === undefined) return undefined
    current = restored
  }
  return { text: current, cascaded: [] }
}

const text = (...lines) => lines.join('\n')

/**
 * 冻结轨迹。每条：`states` 依次施加的修改后的内容，`target` 要撤销的修改下标。
 * 真值由构造决定：撤销 target 且保留其后的全部修改后，文件应当是什么。
 */
const TRAJECTORIES = [
  // ---------------- 开发集 ----------------
  { id: 'dev-tail', partition: 'dev', desc: '末尾追加（控制组）', target: 0,
    states: [text('一', '二', '三'), text('一', '二', '三', '四')] },
  { id: 'dev-disjoint-after', partition: 'dev', desc: '改开头，随后在末尾追加独立区块', target: 0,
    states: [text('标题', '正文一', '正文二', '正文三'), text('新标题', '正文一', '正文二', '正文三'), text('新标题', '正文一', '正文二', '正文三', '落款')] },
  { id: 'dev-disjoint-mid', partition: 'dev', desc: '改中间一行，随后改末尾一行', target: 0,
    states: [text('A', 'B', 'C', 'D', 'E'), text('A', 'B', 'C2', 'D', 'E'), text('A', 'B', 'C2', 'D', 'E2')] },
  { id: 'dev-insert-then-delete', partition: 'dev', desc: '开头插入一行，随后删除末尾一行', target: 0,
    states: [text('P', 'Q', 'R'), text('P0', 'P', 'Q', 'R'), text('P0', 'P', 'Q')] },
  { id: 'dev-replace-len', partition: 'dev', desc: '一行换两行，随后替换最后一行', target: 0,
    states: [text('1', '2', '3'), text('1', '2a', '2b', '3'), text('1', '2a', '2b', '3z')] },
  { id: 'dev-overlap', partition: 'dev', desc: '目标与后续修改相邻', target: 0,
    states: [text('X', 'Y', 'Z', 'W'), text('X2', 'Y', 'Z', 'W'), text('X2', 'Y2', 'Z', 'W')] },
  { id: 'dev-cross-file', partition: 'dev', desc: '同文件改两处后追加新文件', target: 0,
    states: [text('日志一', '日志二'), text('日志一改', '日志二'), text('日志一改', '日志二', '新增')] },
  // ---------------- 留出集 ----------------
  { id: 'hold-01', partition: 'holdout', desc: '头部插入，随后尾部插入另一段', target: 0,
    states: [text('第一段', '第二段'), text('前言', '第一段', '第二段'), text('前言', '第一段', '第二段', '尾注')] },
  { id: 'hold-02', partition: 'holdout', desc: '删除首行，随后替换尾行', target: 0,
    states: [text('弃用行', '保留1', '保留2', '尾行'), text('保留1', '保留2', '尾行'), text('保留1', '保留2', '新尾行')] },
  { id: 'hold-03', partition: 'holdout', desc: '一行改三行，随后追加一行', target: 0,
    states: [text('摘要行', '细节A', '细节B'), text('摘要行一', '摘要行二', '摘要行三', '细节A', '细节B'), text('摘要行一', '摘要行二', '摘要行三', '细节A', '细节B', '补充')] },
  { id: 'hold-04', partition: 'holdout', desc: '中间行替换，随后相邻行替换', target: 0,
    states: [text('l1', 'l2', 'l3', 'l4', 'l5'), text('l1', 'l2x', 'l3', 'l4', 'l5'), text('l1', 'l2x', 'l3', 'l4x', 'l5')] },
  { id: 'hold-05', partition: 'holdout', desc: '撤销目标是最后一次修改（控制组）', target: 1,
    states: [text('甲', '乙'), text('甲', '乙丙'), text('甲', '乙丙丁')] },
  { id: 'hold-06', partition: 'holdout', desc: '目标与后续修改同区域', target: 0,
    states: [text('共同行一', '共同行二', '末尾'), text('共同行一改', '共同行二改', '末尾'), text('共同行一改', '共同行二改', '末尾改')] },
]

const prepared = TRAJECTORIES.map((trajectory) => {
  const patches = trajectory.states.slice(1).map((after, index) => patchOf('c' + index, trajectory.states[index], after))
  return { ...trajectory, patches, final: trajectory.states[trajectory.states.length - 1] }
})

const lastIndex = (entry) => entry.patches.length - 1
const laterCount = (entry) => entry.patches.length - entry.target - 1
/** 选择性撤销的真值：撤销 target 且保留全部后续修改；参照实现判定其是否可行。 */
function selectiveTruth(entry) {
  const result = undoPatch(entry.final, entry.patches[entry.target], entry.patches.slice(entry.target + 1))
  return result && result.cascaded.length === 0 ? result.text : undefined
}
/** 合法状态集合：撤销 target..k 这一段后缀所能到达的状态（用于判断保守结果是否安全）。 */
function legalStates(entry) {
  const states = new Set()
  for (let start = entry.target; start < entry.patches.length; start++) {
    let current = entry.final; let ok = true
    for (let index = lastIndex(entry); index >= start; index--) {
      const next = revertPatch(current, entry.patches[index])
      if (next === undefined) { ok = false; break }
      current = next
    }
    if (ok) states.add(current)
  }
  return states
}

const b0 = (entry) => entry.target === lastIndex(entry) ? { text: applyPatch(entry.final, entry.patches[entry.target]), kept: 0 } : { refused: true, kept: 0 }
const b1 = (entry) => {
  let current = entry.final
  for (let index = lastIndex(entry); index >= entry.target; index--) {
    const next = revertPatch(current, entry.patches[index])
    if (next === undefined) return { refused: true, kept: 0 }
    current = next
  }
  return { text: current, kept: 0 }
}
/** 朴素行号补丁：在记录的原始行号处反向应用差量，不考虑行号漂移。 */
const b2 = (entry) => {
  const patch = entry.patches[entry.target]
  const lines = entry.final.split('\n')
  const region = patch.after
  if (!sameAt(lines, region, patch.at)) return { refused: true, kept: 0 }
  let current = [...lines.slice(0, patch.at), ...patch.before, ...lines.slice(patch.at + region.length)].join('\n')
  let kept = 0
  for (const later of entry.patches.slice(entry.target + 1)) {
    const applied = naiveReapply(current, later)
    if (applied === undefined) return { refused: true, kept }
    current = applied; kept += 1
  }
  return { text: current, kept }
}
const ours = (entry) => {
  const result = undoPatch(entry.final, entry.patches[entry.target], entry.patches.slice(entry.target + 1))
  return result ? { text: result.text, kept: laterCount(entry) } : { refused: true, kept: 0 }
}
const sameAt = (lines, want, at) => want.every((line, index) => lines[at + index] === line)
const naiveReapply = (text, patch) => {
  const lines = text.split('\n')
  if (!sameAt(lines, patch.before, patch.at)) return undefined
  return [...lines.slice(0, patch.at), ...patch.after, ...lines.slice(patch.at + patch.before.length)].join('\n')
}

const GROUPS = [['B0 哈希锁', b0], ['B1 全栈连坐', b1], ['B2 行号补丁', b2], ['OURS 锚定补丁', ours]]
const holdout = process.argv.includes('--holdout')
const asJson = process.argv.includes('--json')
const entries = holdout ? prepared : prepared.filter((entry) => entry.partition === 'dev')

console.log('=== 逐条（' + (holdout ? '开发集+留出集' : '仅开发集') + '，' + entries.length + ' 条）===')
const rows = []
for (const entry of entries) {
  const selective = selectiveTruth(entry)
  const legal = legalStates(entry)
  const marks = GROUPS.map(([name, run]) => {
    const result = run(entry)
    // 保守但有依据：结果等于参照实现在同一条目上给出的任一合法状态。
    const conservative = result.text !== undefined && legal.has(result.text)
    const selectiveOk = selective !== undefined && result.text === selective
    return { name, ...result, selectiveOk, conservative, safe: selectiveOk || result.refused === true || conservative }
  })
  rows.push({ entry, selective: selective !== undefined, marks })
  const label = (mark) => mark.refused ? '拒绝' : mark.selectiveOk ? '选择性' : mark.conservative ? '保守' : '错值'
  console.log(entry.id.padEnd(24) + '后续' + laterCount(entry) + '  ' + marks.map((mark) => mark.name.split(' ')[0] + '=' + label(mark)).join(' ') + '  ' + entry.desc)
}
const laterTotal = rows.reduce((sum, row) => sum + laterCount(row.entry), 0)
console.log('\n=== 汇总 ===')
for (const [name] of GROUPS) {
  const marks = rows.map((row) => row.marks.find((mark) => mark.name === name))
  const kept = marks.reduce((sum, mark) => sum + (mark.selectiveOk ? mark.kept : 0), 0)
  console.log(name.padEnd(16) + '选择性撤销成功 ' + marks.filter((mark) => mark.selectiveOk).length + '/' + rows.length
    + '  安全拒绝 ' + marks.filter((mark) => mark.refused).length
    + '  不安全错值 ' + marks.filter((mark) => !mark.safe).length
    + '  保留后续修改 ' + kept + '/' + laterTotal)
}
const oursMarks = rows.map((row) => row.marks.find((mark) => mark.name.startsWith('OURS')))
console.log('\n自动检查：')
console.log('  OURS 没有不安全结果：' + oursMarks.every((mark) => mark.safe))
console.log('  OURS 安全拒绝：' + oursMarks.filter((mark) => mark.refused).length + '/' + rows.filter((row) => !row.selective).length + '（选择性不可行的条目）')
if (asJson) {
  console.log('\nJSON ' + JSON.stringify({ cases: rows.length, laterTotal, summary: Object.fromEntries(GROUPS.map(([name]) => {
    const marks = rows.map((row) => row.marks.find((mark) => mark.name === name))
    return [name, { selective: marks.filter((mark) => mark.selectiveOk).length, refused: marks.filter((mark) => mark.refused).length, unsafe: marks.filter((mark) => !mark.safe).length, kept: marks.reduce((sum, mark) => sum + (mark.selectiveOk ? mark.kept : 0), 0) }]
  })) }))
}
assert.equal(rows.length, holdout ? 13 : 7, '冻结集大小不符')
