import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stories from '../../tests/fixtures/continuity-stories.json'
import type { StoryHarness } from './memory-story-harness'

export const storyIds = stories.stories.map(story => story.id)
export function storyOracle(id: string) {
  const story = stories.stories.find(story => story.id === id); assert.ok(story)
  return { category: story.category, required: story.required, forbidden: story.forbidden }
}

/** Scenario descriptions are actions. Only authored speech enters chat; oracles stay with the reviewer. */
export async function executeStory(id: string, h: StoryHarness, repo: string) {
  const fixture = stories.stories.find(story => story.id === id); assert.ok(fixture)
  const { turns, question } = fixture
  const checks: Record<string, unknown> = {}, proofs: unknown[] = []
  const fact = (factId: string) => { const value = h.facts.factViews().find(item => item.id === factId); assert.ok(value); return value }
  const correct = async (factId: string, content: string) => h.remember(content, { kind: 'correct', targetId: factId, expectedRevision: fact(factId).revision })
  const node = `'${process.execPath.replaceAll("'", "''")}'`
  // Electron's node mode is scoped to this local command; it does not launch another GUI.
  const runNode = (args: string) => `$env:ELECTRON_RUN_AS_NODE='1'; & ${node} ${args}; exit $LASTEXITCODE`
  let useVectors = true, finalAssertions: (() => void) | undefined
  if (['S01', 'S02', 'S03', 'S04'].includes(id)) {
    await h.chat(turns[0]); await h.remember(turns[0]); await h.chat(turns[1])
    if (id === 'S04') {
      await h.remember(turns[1]); await h.chat('任务名“资料整理”：整理公开资料。')
      const work = h.start('A'); await h.plans.get(work)!.entered.promise; checks.activeWork = work
    } else if (id === 'S02' || id === 'S03') { checks.oldPage = await h.roll(1) }
    else await h.chat(turns[2])
  } else if (['S05', 'S06', 'S07', 'S08'].includes(id)) {
    await h.chat(turns[0]); const old = (await h.remember(turns[0]))!
    if (id === 'S05' || id === 'S08') {
      checks.oldPage = await h.roll(1)
      const summaries = h.store.history!().filter(row => row.type === 'memory/summary')
      assert.ok(summaries.some(row => row.type === 'memory/summary' && row.summary.text.includes(turns[0])), 'OLD_SUMMARY_NOT_CREATED')
      checks.oldSummaryExists = true
    }
    if (id === 'S08') {
      // Read the actual body three times across two reading sessions, then run the unchanged promotion SQL.
      const runtime = h.facts.runtime, scope = { userId: h.store.scope.userId, characterId: h.store.scope.characterId }
      for (let i = 0; i < 3; i++) {
        const context = { scope, sessionId: 'prior-read-' + i, turnId: 'read-' + i,
          sourceContext: { sessionId: 'prior-read-' + i, messageId: 'read-' + i, neighbors: [] }, isCurrent: () => true }
        const read = await runtime.readBodies(context, [{ id: old, revision: fact(old).revision }], [{ id: old, offset: 0 }])
        assert.ok(JSON.stringify(read).includes(turns[0]), 'PROMOTION_BODY_NOT_READ')
        await runtime.recordBodyReads(context, [old], new Set())
      }
      const repository = await runtime.initialize(); assert.ok(repository)
      const promoted = await repository.promoteEligible({ scope, minAccessCount: runtime.promotionAccessCount.value,
        minSessionCount: runtime.promotionSessionCount.value, halfLifeHours: runtime.longTermHalfLifeHours.value })
      assert.ok(promoted.includes(old), 'ORIGINAL_PROMOTION_FAILED')
      runtime.longTermSyncEnabled.value = true; await runtime.queueExistingLongTermMemories()
      assert.ok(runtime.longTermSyncOutbox.value.some(item => item.originId === old && item.kind === 'insert'), 'OLD_MIRROR_QUEUE_MISSING')
      checks.pendingMirrorBeforeForget = true; await h.facts.refresh()
      await h.chat(turns[1]); await h.remember('', { kind: 'forget', targetId: old, expectedRevision: fact(old).revision, content: undefined })
      assert.ok(!h.facts.factViews().some(item => item.id === old), 'FORGOTTEN_FACT_REMAINS')
      checks.forgottenBeforeQuestion = true
    } else {
      await h.chat(turns[1]); const replacement = await correct(old, turns[1]); assert.ok(replacement)
      assert.equal(fact(old).factStatus, 'superseded'); checks.superseded = old; checks.current = replacement
      if (id === 'S05') {
        const page = h.memory.experienceIndex().days.find(day => day.sessionId === checks.oldPage); assert.ok(page)
        const history = h.memory.expandExperience(page.sessionId, page.revision, 0, true)
        assert.ok(history.fragments.some(fragment => fragment.text === turns[0] && fragment.superseded), 'CORRECTED_ORIGINAL_NOT_EXPANDABLE')
        checks.originalStillExpandable = true
      }
      if (id === 'S06') {
        // A neutral capacity fixture creates a genuine compactable range; it contains no story answer.
        await h.chat('以下是公开的格式占位资料，不包含个人偏好或新决定。' + '段落用于检查换行和排版，阅读结束后无需执行操作。'.repeat(430))
        const before = h.store.history!().filter(row => row.type === 'user/message' || row.type === 'assistant/message').length
        await h.compact()
        assert.equal(h.store.history!().filter(row => row.type === 'user/message' || row.type === 'assistant/message').length, before)
        checks.actualCompaction = h.memory.view().compaction
      }
      if (id === 'S07') checks.oldPage = await h.roll(1)
    }
  } else if (['S09', 'S10', 'S11', 'S12'].includes(id)) {
    await h.chat(turns[0]); await h.remember(turns[0]); await h.chat(turns[1]); await h.remember(turns[1])
    if (id === 'S10') { await h.chat('晚饭吃什么？'); await h.chat('今天的课程结束了。') }
    else checks.oldPage = await h.roll(id === 'S09' ? 14 : id === 'S11' ? 31 : 7)
  } else if (['S13', 'S14', 'S15'].includes(id)) {
    const extractionBefore = h.extractionCalls()
    await h.chat(turns[0]); const work = h.start('A'); await h.plans.get(work)!.entered.promise
    await h.chat(turns[1]); h.supplement(work)
    if (id === 'S13') {
      await h.finish(work, { file: 'appearance.ts', content: 'export const settings = { appearance: { fontSize: 16, lineHeight: 1.5 } };\n',
        command: runNode(`'${join(repo, 'node_modules/typescript/bin/tsc').replaceAll("'", "''")}' --noEmit --strict --skipLibCheck --target ES2020 appearance.ts`),
        explanation: '字号与行距已接入原外观设置，类型检查通过。', unresolved: ['截图尚未验收。'] })
      proofs.push(h.fileProof('A', 'appearance.ts'))
    } else if (id === 'S14') {
      await h.finish(work, { file: 'artifact-14.md', content: '# 公开材料整理\n这是一份只保存在本地的测试资料。\n', explanation: '公开材料已整理到本地 artifact-14.md，没有发送。' })
      proofs.push(h.fileProof('A', 'artifact-14.md')); assert.equal(h.external.requests, 0)
    } else {
      writeFileSync(join(h.projects.A, 'test.cjs'), "const assert = require('node:assert/strict'); const { receive } = require('./toast.cjs'); assert.equal(receive('a'), true); assert.equal(receive('a'), false);\n")
      await h.finish(work, { file: 'toast.cjs', content: "const seen = new Set(); exports.receive = id => { if (seen.has(id)) return false; seen.add(id); return true };\n",
        command: runNode('--test test.cjs'), explanation: '去重逻辑和离线测试已完成。', unresolved: ['真实重启体验尚未执行。'] })
      proofs.push(h.fileProof('A', 'toast.cjs'))
    }
    assert.equal(h.extractionCalls(), extractionBefore); checks.extractionWithheld = true
    assert.ok(h.work(work).delivery); checks.publishedWork = h.work(work)
  } else if (id === 'S16' || id === 'S20') {
    await h.chat('任务名“work-' + (id === 'S16' ? '16' : '20') + '”：尝试导出测试日历，只使用本地测试服务。')
    writeFileSync(join(h.projects.A, 'risk-disposable.txt'), 'disposable synthetic fixture')
    const work = h.start('A', { mode: 'external', risky: id === 'S20' }); await h.externalReceived.promise
    assert.equal(h.external.requests, 1)
    if (id === 'S20') assert.ok(h.approvals.includes('允许这一次'), 'ONCE_ONLY_APPROVAL_NOT_OBSERVED')
    if (id === 'S16') await h.stop(work)
    else { await h.restartServices(); assert.equal(h.work(work).status, 'review_required'); assert.equal(h.work(work).waitingFor, 'recovery') }
    checks.externalOutcomeUnknown = true; checks.onceApprovalRecorded = h.approvals.includes('允许这一次'); checks.work = h.work(work)
    const projected = h.works().items.find(item => item.identity.workId === work)
    assert.equal(projected?.result?.completion, 'unverified', 'INTERRUPTED_WORK_MUST_NOT_CLAIM_COMPLETION')
    assert.equal(projected?.result?.interruption?.reason, id === 'S16' ? 'stopped' : 'restarted', 'INTERRUPTION_NOT_PROJECTED')
    finalAssertions = () => { assert.equal(h.external.requests, 1, 'UNKNOWN_WRITE_REPLAYED'); assert.equal(h.work(work).identity.generation, 1, 'UNAPPROVED_RESUME') }
  } else if (id === 'S17') {
    await h.chat(turns[0]); const work = h.start('A'); await h.plans.get(work)!.entered.promise
    await h.chat('晚饭吃什么？'); const page = h.store.scope.sessionId
    h.clock.advanceBy(86_400_000); await h.memory.maintenance()
    assert.equal(h.store.scope.sessionId, page, 'BUSY_DAY_ROLL_RULE_CHANGED'); assert.equal(h.work(work).status, 'running')
    checks.sameWorkAcrossDay = h.work(work)
    finalAssertions = () => { assert.equal(h.work(work).status, 'running'); assert.equal(h.work(work).identity.workId, work) }
  } else if (id === 'S18' || id === 'S19') {
    await h.chat(id === 'S18' ? '任务名 work-18：修改项目甲。' : '任务名 work-19a：准备报告甲。')
    const a = h.start('A'); await h.plans.get(a)!.entered.promise
    await h.chat(id === 'S18' ? '任务名 work-19：检查项目乙。' : '任务名 work-19b：准备报告乙。')
    const b = h.start('B'); await h.plans.get(b)!.entered.promise
    await h.chat(turns[1])
    if (id === 'S18') { await h.stop(a); assert.equal(h.work(b).status, 'running') }
    const before = [h.work(a).identity, h.work(b).identity]
    checks.works = [h.work(a), h.work(b)]
    finalAssertions = () => { assert.deepEqual([h.work(a).identity, h.work(b).identity], before, 'AMBIGUOUS_OR_QUERY_CHANGED_WORK'); assert.equal(h.work(b).status, 'running'); if (id === 'S18') assert.equal(h.work(a).status, 'stopped') }
  } else if (id === 'S21') {
    await h.chat(turns[0]); await h.remember(turns[0]); await h.chat(turns[1]); await h.remember(turns[1]); checks.birthdayNeverSupplied = true
  } else if (id === 'S22') {
    await h.chat('任务名项目甲报告：整理公开资料到本地文件。')
    const a = h.start('A'); await h.plans.get(a)!.entered.promise
    await h.finish(a, { file: 'report-a.md', content: '项目甲的本地报告。\n', explanation: '项目甲的报告文件已生成。' })
    proofs.push(h.fileProof('A', 'report-a.md'))
    await h.chat('任务名项目乙报告：整理公开资料。'); const b = h.start('B'); await h.plans.get(b)!.entered.promise
    assert.equal(h.work(a).status, 'completed'); assert.equal(h.work(b).status, 'running')
    checks.works = [h.work(a), h.work(b)]
    finalAssertions = () => { assert.equal(h.work(b).status, 'running'); assert.equal(h.work(b).checkpointId, null) }
  } else if (id === 'S23') {
    await h.seedOtherCharacter(); await h.facts.refresh()
    assert.equal(h.facts.factViews().length, 0); checks.otherOwnerFactExcluded = true
    finalAssertions = () => { assert.equal(h.facts.factViews().length, 0) }
  } else if (id === 'S24') {
    useVectors = false; assert.equal(h.facts.status().embedding.state, 'unconfigured'); assert.equal(h.facts.status().mirror.state, 'offline')
    assert.equal(h.facts.factViews().length, 0); checks.unconfiguredVectorOfflineMirror = true
  } else throw new Error('UNIMPLEMENTED_STORY')
  const result = await h.answer(question, useVectors); finalAssertions?.()
  // The original question remains unchanged. These predeclared probes exercise the historical and cross-project parts of its oracle without supplying their values.
  const followUpQuestion = id === 'S05' ? '那原先的交付安排是什么？请查一下当时的记录。'
    : id === 'S07' ? '项目乙的端口也需要跟着改吗？' : null
  const followUp = followUpQuestion ? { question: followUpQuestion, ...await h.answer(followUpQuestion, useVectors) } : null
  return { id, question, checks, proofs, ...result, followUp }
}
