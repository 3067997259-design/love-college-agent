// Fresh, archive-bound restore/final-answer check. Never resumes a closed probe ledger.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { createContinuityHarness, journalRows, sha } from './probe-continuity-harness.mjs'
import { continuityProbeLimits } from './fixtures/continuity-live-budget.ts'

const repo=resolve(import.meta.dirname,'..'),prepareIndex=process.argv.indexOf('--prepare')
const read=async file=>JSON.parse(await readFile(file,'utf8'))
const plan=await read(join(repo,'scripts/continuity-live-plan.json'))
if(prepareIndex>=0){
  const [preflightPath,outputPath]=process.argv.slice(prepareIndex+1)
  assert.ok(preflightPath&&outputPath,'PREFLIGHT_AND_OUTPUT_REQUIRED')
  const root=resolve(preflightPath),report=await read(join(root,'report.json')),manifest=await read(join(root,'source-manifest.json'))
  const limits=continuityProbeLimits(plan,'memory',{restoreOnly:true})
  assert.ok(report.ok&&report.selfTest&&!report.receipt.selfTestModelFault&&report.restoreOnly&&report.receipt.restoreOnly&&!report.receipt.source,'PACKAGED_RESTORE_PREFLIGHT_REQUIRED')
  assert.ok(Object.values(report.checks).every(Boolean)&&report.gateway.upstreamRequests===0&&!report.gateway.halted&&!report.gateway.denials.length&&!report.cleanupUncertain,'PREFLIGHT_NOT_PASSED')
  assert.ok(report.gateway.samples.every(sample=>sample.ok),'PREFLIGHT_HAS_FAILED_REQUESTS')
  assert.deepEqual(report.receipt.limits,limits,'LIMITS_CHANGED')
  for(const [file,hash] of Object.entries(manifest))if(!file.startsWith('bundle/'))assert.equal(await sha(join(repo,file)),hash,'SOURCE_CHANGED:'+file)
  const grant={authorized:false,authorizationId:null,batch:'memory',restoreOnly:true,restoreArchiveSha256:report.receipt.restoreArchiveSha256,
    asarSha256:report.receipt.asarSha256,packageBridge:report.receipt.packageBridge,probeManifest:manifest,
    preflight:{root,reportSha256:await sha(join(root,'report.json'))},
    ...Object.fromEntries(Object.entries(limits).filter(([name])=>name.startsWith('maximum'))),
    embeddingAuthorized:false,firstFailureStops:true,unitDefinition:'Admission estimates, not money; autonomous is included in total.',
    modelPolicy:'Use the saved chat model and saved embedding connection; no changes to daily configuration.'}
  const output=resolve(outputPath);await mkdir(dirname(output),{recursive:true})
  await writeFile(output,JSON.stringify(grant,null,2),{flag:'wx'})
  console.log(JSON.stringify({output,authorized:false,restoreOnly:true,restoreArchiveSha256:grant.restoreArchiveSha256}))
}else{
  assert.ok(process.env.LCA_MEMORY_RESTORE_ARCHIVE,'RESTORE_ARCHIVE_REQUIRED')
  const bytes=await readFile(resolve(process.env.LCA_MEMORY_RESTORE_ARCHIVE))
  assert.ok(bytes.length>1000,'NONEMPTY_ARCHIVE_REQUIRED')
  const restoreArchiveSha256=createHash('sha256').update(bytes).digest('hex')
  const archive=await JSZip.loadAsync(bytes)
  assert.ok(!Object.keys(archive.files).some(path=>/(^|\/)connections\/|providers\.json|secrets\//.test(path)),'CREDENTIALS_EXPORTED')
  const h=await createContinuityHarness('memory','scripts/probe-memory-restore.mjs',{restoreOnly:true,restoreArchiveSha256})
  const active=state=>(state.memory.facts??[]).filter(fact=>fact.reviewStatus==='approved'&&fact.factStatus==='active')
  const originalRows=async()=> (await journalRows(h.profile())).filter(row=>['user/message','assistant/message'].includes(row.type)).map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='_file')))
  const operations=state=>(state.memory.operations??[]).map(({operationId,kind,status})=>({operationId,kind,status})).sort((a,b)=>a.operationId.localeCompare(b.operationId))
  let failure
  try{
    const save=join(h.root,'source-nonempty.lca-save')
    await writeFile(save,bytes,{flag:'wx'});assert.equal(await sha(save),restoreArchiveSha256)
    await h.app().evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},save)
    assert.equal((await h.send({type:'backup.import'})).status,'accepted')
    const pending=await h.wait(state=>state.backup.status==='awaiting-confirmation','SAVE_NOT_VALIDATED')
    await h.app().evaluate(({app})=>{app.relaunch=()=>{}})
    const closed=h.app().waitForEvent('close')
    assert.equal((await h.send({type:'backup.restore',restoreId:pending.backup.incoming?.id??pending.backup.restoreId})).status,'accepted')
    await closed;await h.launch()
    const restored=await h.snapshot()
    assert.equal(restored.backup.status,'restored');assert.ok(restored.backup.incoming.messageCount>0)
    h.checks.nonemptyArchiveRestored=true
    const retired=(restored.memory.facts??[]).filter(fact=>fact.factStatus==='superseded')
    assert.ok(retired.some(fact=>fact.content.includes('喝茶')),'SUPERSEDED_HISTORY_MISSING')
    assert.equal(active(restored).length,0,'FORGOTTEN_FACT_RESURRECTED')
    const beforeOperations=operations(restored)
    for(const kind of ['remember','correct','forget'])assert.ok(beforeOperations.some(operation=>operation.kind===kind&&operation.status==='applied'),'OPERATION_NOT_RESTORED:'+kind)
    h.checks.retiredHistoryAndAppliedForgetRestored=true
    const beforeHistory=await originalRows()
    await h.chat('恢复存档之后，只查询当前已审阅记忆：还有我的饮料偏好吗？','after-restore')
    const answer=h.answers.at(-1),after=await h.snapshot()
    const reads=(await journalRows(h.profile())).filter(row=>row.turnId===answer.turnId&&row.type==='work/activity'&&row.status==='completed'&&['memory.search','memory.read'].includes(row.templateId))
    assert.ok(reads.length,'CURRENT_MEMORY_NOT_READ')
    h.checks.currentMemoryReadAndAnswerDelivered=true
    assert.equal(active(after).length,0,'FORGOTTEN_FACT_RESURRECTED_AFTER_QUERY')
    assert.deepEqual(operations(after),beforeOperations)
    h.checks.noFactOrOperationResurrection=true
    const originalIds=new Set(beforeHistory.map(row=>row.id))
    assert.deepEqual((await originalRows()).filter(row=>originalIds.has(row.id)),beforeHistory)
    h.checks.originalHistoryPreserved=true
    h.report.restoreReceipts={restoreArchiveSha256,restoredMessages:restored.backup.incoming.messageCount,
      originalRows:beforeHistory.length,currentReviewedFacts:active(after).length,
      retiredFacts:retired.map(({id,revision,content,factStatus})=>({id,revision,content,factStatus})),
      operations:beforeOperations,memoryReads:reads.map(({turnId,callId,templateId,status})=>({turnId,callId,templateId,status}))}
    await h.review();h.report.ok=true
  }catch(error){failure=error}
  finally{await h.finalize(failure)}
}
