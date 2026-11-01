import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { createContinuityHarness, journalRows, sha } from './probe-continuity-harness.mjs'

const h=await createContinuityHarness('memory','scripts/probe-memory-live.mjs')
const facts=s=>s.memory.facts??[], active=s=>facts(s).filter(f=>f.reviewStatus==='approved'&&f.factStatus==='active')
const originalHistory=async()=> (await journalRows(h.profile())).filter(r=>['user/message','assistant/message'].includes(r.type)).map(r=>Object.fromEntries(Object.entries(r).filter(([key])=>key!=='_file')))
const review=async kind=>{
  const s=await h.wait(s=>s.memory.operations?.some(o=>o.kind===kind&&o.status==='pending_review'),'MEMORY_PROPOSAL_MISSING:'+kind)
  const op=s.memory.operations.findLast(o=>o.kind===kind&&o.status==='pending_review')
  assert.equal((await h.send({type:'memory.review',operationId:op.operationId,approve:true})).status,'accepted')
  await h.wait(s=>s.memory.operations.some(o=>o.operationId===op.operationId&&o.status==='applied')&&s.memory.status==='idle','MEMORY_REVIEW_NOT_APPLIED:'+kind)
  return op.operationId
}
let failure
try{
  await h.chat('请记住我的饮料偏好：我平时喜欢喝茶。请提出记忆操作，等我审阅。','remember')
  assert.equal(active(await h.snapshot()).length,0,'UNREVIEWED_FACT_CURRENT')
  const remembered=await review('remember');const old=active(await h.snapshot()).find(f=>f.content.includes('喝茶'));assert.ok(old)
  await h.chat('请查询当前经过审阅的记忆：我的饮料偏好是什么？','recall-tea')
  h.checks.rememberReviewAndRecall=true
  await h.chat('请把我的饮料偏好纠正为：我现在喜欢喝咖啡，不再喝茶。查询最新记忆版本后提出更正，等我审阅。','correct')
  const corrected=await review('correct'),current=active(await h.snapshot()).find(f=>f.content.includes('咖啡'));assert.ok(current)
  assert.equal(facts(await h.snapshot()).find(f=>f.id===old.id).factStatus,'superseded')
  await h.chat('请按当前已审阅记忆再确认我的饮料偏好，旧说法不要当成当前事实。','recall-coffee')
  h.checks.correctionSupersedesOldFact=true
  // Ordinary input creates enough eligible DSH history for a real root compaction.
  await h.chat('这是一段无关的合成日常记录，不需要保存成偏好。'+ '今天整理书桌上的纸张，依次归类后放回抽屉。'.repeat(220),'filler')
  const originals=await originalHistory()
  await h.phase('compact');assert.equal((await h.send({type:'message.send',text:'/compact'})).status,'accepted')
  await h.wait(s=>s.memory.status==='idle'&&s.memory.compaction?.outcome==='compacted','DSH_COMPACTION_NOT_CONFIRMED')
  assert.deepEqual(await originalHistory(),originals)
  await h.chat('压缩之后，请查询当前已审阅记忆，确认饮料偏好。','after-compact')
  h.checks.actualCompactionPreservesHistoryAndCurrentFact=true
  await h.closeApp();await h.launch()
  await h.chat('重启之后，请查询当前已审阅记忆，确认饮料偏好。','after-restart')
  assert.ok(active(await h.snapshot()).some(f=>f.id===current.id&&f.content.includes('咖啡')))
  h.checks.correctedFactSurvivesRestart=true
  await h.phase('extract');assert.equal((await h.send({type:'memory.extract'})).status,'accepted')
  await h.wait(s=>s.memory.status==='idle','EXTRACTION_NOT_SETTLED')
  const captures=(await h.gateway()).captures.filter(c=>c.slot==='background'&&c.extractionInput)
  assert.ok(captures.length>0,'NO_SUCCESSFUL_INPUT_EXTRACTION')
  assert.equal(new Set(captures.map(c=>JSON.stringify(c.extractionInput))).size,captures.length,'DUPLICATE_EXTRACTION_INPUT')
  const originalsSeen=(await journalRows(h.profile())).filter(r=>r.type==='model/seen').flatMap(r=>r.messages.filter((_,i)=>r.eligibleIndexes.includes(i)&&!r.memoryExcludedIndexes?.includes(i))).filter(m=>m.role==='user').map(m=>m.content)
  assert.ok(captures.every(c=>c.extractionInput.userText&&originalsSeen.some(text=>text.startsWith(c.extractionInput.userText))&&!c.extractionInput.assistantText),'DERIVED_TEXT_EXTRACTED_AS_NEW_EXPERIENCE')
  h.checks.successfulInputsExtractedWithoutDuplicateCapture=true
  await h.chat('请忘记我的饮料偏好。查询最新记忆版本后提出忘记操作，等我审阅。','forget')
  const forgotten=await review('forget');assert.equal(active(await h.snapshot()).length,0)
  await h.chat('只查询当前已审阅记忆，还有我的饮料偏好吗？不要用旧聊天代替当前记忆。','after-forget')
  h.checks.forgottenFactUnavailable=true
  const save=join(h.root,'nonempty.lca-save')
  await h.app().evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file})},save)
  assert.equal((await h.send({type:'backup.export'})).status,'accepted')
  await h.wait(s=>s.backup.status==='exported','SAVE_NOT_EXPORTED')
  assert.ok((await readFile(save)).length>1000)
  const archive=await JSZip.loadAsync(await readFile(save))
  assert.ok(!Object.keys(archive.files).some(path=>/(^|\/)connections\/|providers\.json|secrets\//.test(path)),'CREDENTIALS_EXPORTED')
  await h.closeApp();const restoredProfile=join(h.root,'profiles/restored');await h.launch(restoredProfile)
  await h.app().evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},save)
  assert.equal((await h.send({type:'backup.import'})).status,'accepted')
  const pending=await h.wait(s=>s.backup.status==='awaiting-confirmation','SAVE_NOT_VALIDATED')
  // Suppress only automatic relaunch; the normal restore command and shutdown still run.
  await h.app().evaluate(({app})=>{app.relaunch=()=>{}})
  const closed=h.app().waitForEvent('close')
  assert.equal((await h.send({type:'backup.restore',restoreId:pending.backup.incoming?.id??pending.backup.restoreId})).status,'accepted')
  await closed;await h.launch(restoredProfile)
  const restored=await h.snapshot()
  assert.equal(restored.backup.status,'restored');assert.ok(restored.backup.incoming.messageCount>0)
  assert.ok(facts(restored).some(f=>f.id===old.id&&f.factStatus==='superseded'),'NONEMPTY_MEMORY_NOT_RESTORED')
  assert.equal(active(restored).length,0)
  await h.chat('恢复存档之后，只查询当前已审阅记忆：还有我的饮料偏好吗？','after-restore')
  assert.equal(active(await h.snapshot()).length,0)
  h.checks.nonemptyRestoreDoesNotResurrectForgottenFact=true
  h.report.memoryReceipts={remembered,corrected,forgotten,oldFact:old.id,currentFact:current.id,saveSha256:await sha(save),captures:captures.map(c=>({phase:c.phase,ticket:c.ticket,extractionInput:c.extractionInput}))}
  await h.review();h.report.ok=true
}catch(error){failure=error}
finally{await h.finalize(failure)}
