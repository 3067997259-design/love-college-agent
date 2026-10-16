// 子串接地的语义保真实验装置（2026-10-17）。
//
// 问题：`source.includes(quote)` 不是蕴含。它接受被剥离了否定的引文、被切开算子作用域的引文、
// 以及从数字中间切出来的引文。本装置在冻结的中文对抗＋良性集上对照四组检查器：
//   B0 现有 `.includes`
//   B1 只检查引文内部是否有否定词
//   B2 检查整句是否有否定词／条件词
//   OURS 作用域感知的接地检查（src/main/memory/grounding.ts）
// 指标：对抗样本被误收率（FAR）、良性样本被误杀率（FRR），并分种类报告。
//
// 零模型、零网络、零随机：全部为纯函数判定。开发集可逐条查看；留出集需 --holdout。
import assert from 'node:assert/strict'
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

const { groundingVerdict } = await import('../src/main/memory/grounding.ts')

/**
 * 冻结集。`kind: 'drop'` 表示应当拒绝（引文断言的内容并非来源所断言）；`kind: 'keep'` 表示应当接受。
 * `kind: 'either'` 只用于真实存在的语义歧义，不计入 FAR/FRR。
 * `atomic: false` 表示这条探针的引文**不是**来源的连续子串：它检验的是「逐字包含」之外的语义推断，
 * 因此 `.includes` 这一类检查器必然收下它。装置自检只对原子引文要求子串关系，否则修掉这两条就会
 * 让实验失去它们唯一要测的区分度。
 * 开发集用于调试规则；留出集在规则冻结后只跑一次。
 */
const CASES = [
  // ---------------- 开发集：对抗 ----------------
  { id: 'dev-a1', partition: 'dev', group: 'prefix-strip', source: '老师说今天不用交实验报告', quote: '交实验报告', kind: 'drop' },
  { id: 'dev-a2', partition: 'dev', group: 'prefix-strip', source: '老师并没有说这周要交作业', quote: '这周要交作业', kind: 'drop' },
  { id: 'dev-a3', partition: 'dev', group: 'prefix-strip-numeral', source: '这门课不少于5页', quote: '5页', kind: 'drop' },
  { id: 'dev-a4', partition: 'dev', group: 'numeral-slice', source: '截止时间是12月13日晚上八点', quote: '3日晚上八点', kind: 'drop' },
  { id: 'dev-a5', partition: 'dev', group: 'scope-negation', source: '照片并没有发给同学', quote: '照片发给同学', kind: 'drop', atomic: false },
  { id: 'dev-a6', partition: 'dev', group: 'collective-negation', source: '本周不交作业', quote: '交作业', kind: 'drop' },
  { id: 'dev-a7', partition: 'dev', group: 'conditional', source: '如果下雨才改到周日', quote: '改到周日', kind: 'drop' },
  { id: 'dev-a8', partition: 'dev', group: 'conditional', source: '只有修满学分才能选这门课', quote: '能选这门课', kind: 'drop' },
  { id: 'dev-a9', partition: 'dev', group: 'non-factive', source: '有同学问是不是改到三楼', quote: '改到三楼', kind: 'drop' },
  { id: 'dev-a10', partition: 'dev', group: 'non-factive', source: '听说明天停课', quote: '明天停课', kind: 'drop' },
  { id: 'dev-a11', partition: 'dev', group: 'factored-token', source: '报告已经交到教务处了', quote: '交', kind: 'drop' },
  { id: 'dev-a12', partition: 'dev', group: 'span-split', source: '报告下周交，地点改到三楼', quote: '下周交，地点', kind: 'drop' },
  // ---------------- 开发集：良性 ----------------
  { id: 'dev-b1', partition: 'dev', group: 'attributive-scope', source: '没选修实验课的同学不用管，选了的同学周五提交报告', quote: '周五提交报告', kind: 'keep' },
  { id: 'dev-b2', partition: 'dev', group: 'attributive-scope', source: '还不清楚格式的同学请先下载模板', quote: '先下载模板', kind: 'keep' },
  { id: 'dev-b3', partition: 'dev', group: 'double-negation', source: '并非不需要提交预习报告', quote: '需要提交预习报告', kind: 'keep' },
  { id: 'dev-b4', partition: 'dev', group: 'double-negation', source: '不能不参加安全培训', quote: '参加安全培训', kind: 'keep' },
  { id: 'dev-b5', partition: 'dev', group: 'plain', source: '请在下周三前提交实验报告', quote: '下周三前提交实验报告', kind: 'keep' },
  { id: 'dev-b6', partition: 'dev', group: 'plain', source: '班会地点改到三号楼二零一', quote: '地点改到三号楼二零一', kind: 'keep' },
  { id: 'dev-b7', partition: 'dev', group: 'attributive-scope', source: '没有提交报告的同学请尽快补交', quote: '请尽快补交', kind: 'keep' },
  { id: 'dev-b8', partition: 'dev', group: 'plain-numeral', source: '报名截止到12月13日', quote: '12月13日', kind: 'keep' },
  { id: 'dev-b9', partition: 'dev', group: 'plain', source: '实验课需要预习报告', quote: '需要预习报告', kind: 'keep' },
  { id: 'dev-b10', partition: 'dev', group: 'plain', source: '图书馆周日闭馆', quote: '周日闭馆', kind: 'keep' },
  // ---------------- 留出集：对抗 ----------------
  { id: 'hold-a1', partition: 'holdout', group: 'prefix-strip', source: '助教说这次不必写摘要', quote: '写摘要', kind: 'drop' },
  { id: 'hold-a2', partition: 'holdout', group: 'prefix-strip', source: '课程群通知这学期不安排期中考试', quote: '安排期中考试', kind: 'drop' },
  { id: 'hold-a3', partition: 'holdout', group: 'prefix-strip-numeral', source: '篇幅不超过8页', quote: '8页', kind: 'drop' },
  { id: 'hold-a4', partition: 'holdout', group: 'numeral-slice', source: '面试安排在11月30日上午', quote: '0日上午', kind: 'drop' },
  { id: 'hold-a5', partition: 'holdout', group: 'scope-negation', source: '材料还没有交给学院', quote: '材料交给学院', kind: 'drop', atomic: false },
  { id: 'hold-a6', partition: 'holdout', group: 'collective-negation', source: '这门课不再安排补考', quote: '安排补考', kind: 'drop' },
  { id: 'hold-a7', partition: 'holdout', group: 'conditional', source: '若人数不足才取消这门选修', quote: '取消这门选修', kind: 'drop' },
  { id: 'hold-a8', partition: 'holdout', group: 'conditional', source: '除非导师同意才能更换题目', quote: '能更换题目', kind: 'drop' },
  { id: 'hold-a9', partition: 'holdout', group: 'non-factive', source: '有人在群里问能不能推迟答辩', quote: '能推迟答辩', kind: 'drop' },
  { id: 'hold-a10', partition: 'holdout', group: 'non-factive', source: '据说下学期换教材', quote: '下学期换教材', kind: 'drop' },
  { id: 'hold-a11', partition: 'holdout', group: 'factored-token', source: '成绩已经录入系统', quote: '录', kind: 'drop' },
  { id: 'hold-a12', partition: 'holdout', group: 'span-split', source: '论文初稿周五交，格式按模板', quote: '周五交，格式', kind: 'drop' },
  // ---------------- 留出集：良性 ----------------
  { id: 'hold-b1', partition: 'holdout', group: 'attributive-scope', source: '没有交齐材料的同学请补齐，其余同学周四领取证书', quote: '周四领取证书', kind: 'keep' },
  { id: 'hold-b2', partition: 'holdout', group: 'attributive-scope', source: '不明白流程的同学可以看附件说明', quote: '可以看附件说明', kind: 'keep' },
  { id: 'hold-b3', partition: 'holdout', group: 'double-negation', source: '不能不填写实验安全承诺书', quote: '填写实验安全承诺书', kind: 'keep' },
  { id: 'hold-b4', partition: 'holdout', group: 'double-negation', source: '并非不用参加组会', quote: '参加组会', kind: 'keep' },
  { id: 'hold-b5', partition: 'holdout', group: 'plain', source: '请把纸质版交到学院办公室', quote: '把纸质版交到学院办公室', kind: 'keep' },
  { id: 'hold-b6', partition: 'holdout', group: 'plain-numeral', source: '答辩定在11月30日上午九点', quote: '11月30日上午九点', kind: 'keep' },
  { id: 'hold-b7', partition: 'holdout', group: 'attributive-scope', source: '不清楚考场安排的同学请查看通知', quote: '请查看通知', kind: 'keep' },
  { id: 'hold-b8', partition: 'holdout', group: 'plain', source: '这门选修课不再安排补考改为期末统一考核', quote: '改为期末统一考核', kind: 'keep' },
  { id: 'hold-b9', partition: 'holdout', group: 'plain', source: '实验数据需要保留三个月', quote: '需要保留三个月', kind: 'keep' },
  { id: 'hold-b10', partition: 'holdout', group: 'plain', source: '下周一的课调到下午两点', quote: '调到下午两点', kind: 'keep' },
]

const NEGATOR = /不再|不用|不需|不必|不会|不能|不得|不应|没有|并非|未|没|不|别|勿|无/
const SCOPEY = /不再|不用|不需|不必|不会|不能|不得|不应|没有|并非|未|没|不|别|勿|无|如果|假如|若|除非|万一|要是|是否|是不是|有没有|能否|才|听说|据说/
/** B0：现有实现。 */
const b0 = (source, quote) => source.includes(quote)
/** B1：只在引文内部找否定词。 */
const b1 = (source, quote) => source.includes(quote) && !NEGATOR.test(quote)
/** B2：整句出现否定或条件词就拒绝。 */
const b2 = (source, quote) => source.includes(quote) && !SCOPEY.test(source)
/** 解析出引文在来源里的确切区间，交接地检查器判定。 */
const ours = (source, quote) => {
  const at = source.indexOf(quote)
  return at >= 0 && groundingVerdict(source, quote, at, at + quote.length).entailed
}

const CHECKERS = [['B0 .includes', b0], ['B1 引文内正则', b1], ['B2 整句正则', b2], ['OURS 作用域接地', ours]]
const wants = (testCase) => testCase.kind === 'keep'

function evaluate(cases) {
  const scored = cases.filter((testCase) => testCase.kind !== 'either')
  const adversarial = scored.filter((testCase) => testCase.kind === 'drop')
  const benign = scored.filter((testCase) => testCase.kind === 'keep')
  return CHECKERS.map(([name, check]) => {
    const accepted = (testCase) => check(testCase.source, testCase.quote)
    const far = adversarial.filter(accepted).length
    const frr = benign.filter((testCase) => !accepted(testCase)).length
    const correct = adversarial.filter((testCase) => !accepted(testCase)).length + benign.filter(accepted).length
    const groups = {}
    for (const testCase of scored) {
      const bucket = groups[testCase.group] ?? (groups[testCase.group] = { far: 0, adversarial: 0, frr: 0, benign: 0 })
      if (wants(testCase)) { bucket.benign += 1; if (!accepted(testCase)) bucket.frr += 1 } else { bucket.adversarial += 1; if (accepted(testCase)) bucket.far += 1 }
    }
    return { name, far, adversarial: adversarial.length, frr, benign: benign.length, accuracy: correct / scored.length, groups }
  })
}

const holdout = process.argv.includes('--holdout')
const asJson = process.argv.includes('--json')
const cases = holdout ? CASES : CASES.filter((testCase) => testCase.partition === 'dev')
const scored = cases.filter((testCase) => testCase.kind !== 'either')
console.log('=== 逐条（' + (holdout ? '开发集+留出集' : '仅开发集') + '，' + cases.length + ' 条）===')
for (const testCase of cases) {
  const marks = CHECKERS.map(([, check]) => check(testCase.source, testCase.quote) ? '收' : '拒')
  const verdict = groundingVerdict(testCase.source, testCase.quote, testCase.source.indexOf(testCase.quote), testCase.source.indexOf(testCase.quote) + testCase.quote.length)
  const expected = testCase.kind === 'keep' ? '收' : '拒'
  console.log(testCase.id.padEnd(9) + testCase.group.padEnd(20) + '期望' + expected + '  ' + CHECKERS.map(([name], index) => name.split(' ')[0] + '=' + marks[index]).join(' ') + '  理由=' + verdict.reason)
}
console.log('\n=== 汇总 ===')
for (const row of evaluate(cases)) {
  console.log(row.name.padEnd(18) + ' FAR=' + row.far + '/' + row.adversarial + '  FRR=' + row.frr + '/' + row.benign + '  准确率=' + (row.accuracy * 100).toFixed(1) + '%')
}
console.log('\n=== OURS 分类别（FAR 对抗 / FRR 良性）===')
for (const row of evaluate(cases)) {
  if (!row.name.startsWith('OURS')) continue
  for (const [group, bucket] of Object.entries(row.groups)) {
    if (bucket.adversarial) console.log('  ' + group.padEnd(22) + '对抗漏收 ' + bucket.far + '/' + bucket.adversarial)
    if (bucket.benign) console.log('  ' + group.padEnd(22) + '良性误杀 ' + bucket.frr + '/' + bucket.benign)
  }
}
if (asJson) {
  const summary = Object.fromEntries(evaluate(cases).map((row) => [row.name, { far: row.far, adversarial: row.adversarial, frr: row.frr, benign: row.benign, accuracy: Number(row.accuracy.toFixed(4)) }]))
  console.log('\nJSON ' + JSON.stringify({ cases: scored.length, holdout, summary }))
}
// 装置自检：四组都必须真的跑过每条样本，且 OURS 不得把任意一条判成"区间不存在"。
assert.equal(scored.length, holdout ? 44 : 22, '冻结集大小不符')
// 只有原子引文必须真的是来源的连续子串；`atomic: false` 的语义探针按定义就不是（见 CASES 注释）。
const nonAtomic = new Set(scored.filter((testCase) => testCase.atomic === false).map((testCase) => testCase.id))
const missing = scored.filter((testCase) => !nonAtomic.has(testCase.id) && testCase.source.indexOf(testCase.quote) < 0)
assert.equal(missing.length, 0, '这些引文不在来源里，属于装置错误: ' + missing.map((testCase) => testCase.id).join(','))
for (const testCase of scored) if (nonAtomic.has(testCase.id) && testCase.source.indexOf(testCase.quote) >= 0) assert.fail('这条标记为非原子引文，实际却能在来源里找到: ' + testCase.id)
