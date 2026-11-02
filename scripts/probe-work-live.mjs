import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContinuityHarness, workRecords, journalRows, sha } from './probe-continuity-harness.mjs'

const firstRequestOnly=process.argv.includes('--first-request-only')
const captureOnly=process.argv.includes('--capture-request')
const h=await createContinuityHarness('work','scripts/probe-work-live.mjs',{firstRequestOnly,captureOnly})
const present=async path=>access(path).then(()=>true,()=>false)
const barrier=`param([ValidatePattern('^[AB][12]$')][string]$Tag)
$ErrorActionPreference='Stop'
$taskDirectory=(Get-Location).Path
$gate=Join-Path $taskDirectory ('release-'+$Tag)
$watcher=[System.IO.FileSystemWatcher]::new($taskDirectory)
try {
  [System.IO.File]::WriteAllText((Join-Path $taskDirectory ('entered-'+$Tag)), ('{"pid":'+$PID+'}'))
  while(-not [System.IO.File]::Exists($gate)) {
    $change=$watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All,180000)
    if($change.TimedOut){throw 'BARRIER_DEADLINE'}
  }
  Write-Output ('BARRIER_RELEASED_'+$Tag)
} finally {$watcher.Dispose()}
`
const project=async name=>{const path=join(h.root,'projects',name);await mkdir(path,{recursive:true});await writeFile(join(path,'barrier.ps1'),barrier,{flag:'wx'});return path}
const target=w=>({identity:w.identity,expectedRevision:w.revision})
const startInput=label=>`请启动独立工作 WORK_${label}，保持前台能聊天。在当前项目的 PowerShell 进程里先执行 & .\\barrier.ps1 ${label}1，等这个命令真正结束后再写 result.txt，最初内容是 TEA。以后以我补充的新要求为准。恢复时用新运行代次作为屏障编号。写完后用实际文件证据提交工作检查点。`
const controls=async(id,type)=>{const w=(await h.snapshot()).continuousWorks.items.find(w=>w.identity.workId===id);assert.ok(w);assert.equal((await h.send({type,target:target(w)})).status,'accepted')}
const start=async(path,label,step)=>{
  await h.chooseProject(path)
  const before=new Set((await h.snapshot()).continuousWorks.items.map(w=>w.identity.workId))
  await h.chat(startInput(label),step,{approvals:true})
  const s=await h.wait(async s=>s.continuousWorks.items.some(w=>!before.has(w.identity.workId))&&await present(join(path,'entered-'+label+'1')),'WORK_TOOL_BARRIER_NOT_ENTERED',{approvals:true})
  return s.continuousWorks.items.find(w=>!before.has(w.identity.workId))
}
let failure
try{
  if(firstRequestOnly){
    await h.chooseProject(await project('first'));await h.phase('work-create-a')
    assert.equal((await h.send({type:'message.send',text:startInput('A')})).status,'accepted')
    await h.wait((s,g)=>g.samples.length===1&&typeof g.samples[0].elapsedMs==='number','FIRST_RESPONSE_NOT_FINISHED')
    const g=await h.gateway();assert.equal(g.samples[0].ok,true);assert.equal(g.modelRequests,1);assert.equal(g.autonomousUnits,0);assert.equal(g.embeddingRequests,0)
    h.checks[captureOnly?'offlineRequestCaptured':'providerFirstResponseComplete']=true;h.checks.singleRequestOnly=true
    if(captureOnly)assert.equal(g.upstreamRequests,0)
    h.report.scope=captureOnly?'offline request capture; no upstream request':'provider-first-response-only; work execution is not assessed';h.report.ok=true
  }else{
  const first=await project('first'),a=await start(first,'A','work-create-a')
  assert.equal(await present(join(first,'result.txt')),false)
  const workerBefore=(await h.gateway()).samples.filter(s=>s.slot==='work').length
  await h.chat('等你工作时，我们先聊一句：今天想喝点什么？','work-chat')
  assert.equal(await present(join(first,'release-A1')),false);assert.equal(await present(join(first,'result.txt')),false)
  assert.equal((await h.gateway()).samples.filter(s=>s.slot==='work').length,workerBefore,'WORK_TOOL_NOT_STILL_BLOCKED')
  h.checks.foregroundCompletesWhileWorkerToolBlocked=true
  await h.chat(`补充刚才的工作 ${a.identity.workId}：result.txt 的内容改成 COFFEE，不要 TEA，仍然等原来的阻塞命令结束后再写。`,'work-amend')
  let latest=(await workRecords(h.profile())).find(w=>w.identity.workId===a.identity.workId)
  assert.ok(latest&&latest.identity.generation===a.identity.generation&&latest.identity.objectiveRevision>a.identity.objectiveRevision)
  assert.ok(latest.inputs.some(i=>i.kind==='supplement'&&['accepted','consumed'].includes(i.state)))
  assert.equal((await h.snapshot()).continuousWorks.items.length,1,'SUPPLEMENT_CREATED_NEW_WORK')
  h.checks.supplementDurableInOriginalWork=true
  await writeFile(join(first,'release-A1'),'release',{flag:'wx'})
  await h.wait(s=>s.continuousWorks.items.some(w=>w.identity.workId===a.identity.workId&&w.status==='completed')&&s.task?.status==='completed','WORK_NOT_COMPLETED',{approvals:true})
  assert.equal((await readFile(join(first,'result.txt'),'utf8')).trim(),'COFFEE')
  latest=(await workRecords(h.profile())).find(w=>w.identity.workId===a.identity.workId)
  const cp=latest.checkpoints.find(c=>c.id===latest.checkpointId),proof=latest.evidence.find(e=>cp.evidenceIds.includes(e.id)&&e.kind==='artifact')
  assert.equal(proof.afterHash,await sha(join(first,'result.txt')));assert.ok(latest.inputs.every(i=>i.state==='consumed'))
  h.checks.currentRevisionFileAndCheckpoint=true
  await h.chat('刚刚的工作最后写了什么？为什么改变了内容？','work-followup')
  assert.ok((await h.gateway()).captures.some(c=>c.phase==='work-followup'&&JSON.stringify(c.references).includes(proof.afterHash)))
  h.checks.immediateDeliveryContextHasVerifiedEvidence=true
  const pa=await project('parallel-a'),pb=await project('parallel-b')
  const wa=await start(pa,'A','work-create-a-second'),wb=await start(pb,'B','work-create-b')
  const revisions=()=>h.snapshot().then(s=>s.continuousWorks.items.filter(w=>[wa.identity.workId,wb.identity.workId].includes(w.identity.workId)).map(w=>({id:w.identity.workId,revision:w.identity.objectiveRevision})))
  const before=await revisions();await h.chat('把那个任务改一下。','work-ambiguous',{clarification:true});assert.deepEqual(await revisions(),before)
  h.checks.ambiguousAmendmentDoesNotChangeEitherWork=true
  await controls(wa.identity.workId,'work.stop')
  await h.wait(s=>s.continuousWorks.items.find(w=>w.identity.workId===wa.identity.workId)?.status==='stopped','STOP_NOT_SETTLED')
  assert.ok(['running','waiting'].includes((await h.snapshot()).continuousWorks.items.find(w=>w.identity.workId===wb.identity.workId).status))
  assert.equal(await present(join(pb,'result.txt')),false);h.checks.stopIsolatedToOneRoot=true
  const oldApprovalIds=new Set(h.report.approvals.map(a=>a.id));await h.closeApp();await h.launch()
  await h.wait(s=>s.continuousWorks.items.find(w=>w.identity.workId===wb.identity.workId)?.status==='review_required','RESTART_DID_NOT_REQUIRE_RECONCILIATION')
  for(const id of oldApprovalIds)assert.equal((await h.send({type:'question.answer',questionId:id,answer:'信任这个项目'})).status,'rejected','OLD_APPROVAL_REPLAYED')
  await h.phase('work-resume');await controls(wb.identity.workId,'work.resume')
  const resumed=await h.wait(async s=>s.continuousWorks.items.find(w=>w.identity.workId===wb.identity.workId)?.identity.generation===wb.identity.generation+1&&await present(join(pb,'entered-B2')),'NEW_GENERATION_NOT_STARTED',{approvals:true})
  assert.equal(resumed.continuousWorks.items.find(w=>w.identity.workId===wa.identity.workId).status,'stopped')
  await writeFile(join(pb,'release-B2'),'release',{flag:'wx'})
  await h.wait(s=>s.continuousWorks.items.find(w=>w.identity.workId===wb.identity.workId)?.status==='completed'&&s.task?.status==='completed','RESUMED_WORK_NOT_COMPLETED',{approvals:true})
  assert.equal((await readFile(join(pb,'result.txt'),'utf8')).trim(),'TEA')
  assert.equal(new Set(h.report.approvals.map(a=>a.id)).size,h.report.approvals.length)
  h.checks.recoveryUsesNewGenerationWithoutApprovalReplay=true
  h.report.approvalsBeforeRestart=[...oldApprovalIds]
  await h.wait(async s=>s.task?.status==='completed'&&(await workRecords(h.profile())).filter(w=>w.status==='completed').every(w=>w.deliveries?.length===1&&w.deliveries[0].state==='consumed'),'DELIVERY_NOT_CONSUMED',{approvals:true})
  const records=await workRecords(h.profile()),rows=await journalRows(h.profile())
  for(const work of records.filter(w=>w.status==='completed')){assert.equal(work.deliveries.length,1);assert.equal(work.deliveries[0].state,'consumed');assert.equal(rows.filter(r=>r.type==='inbox/event'&&r.id===work.deliveries[0].eventId).length,1)}
  h.checks.noDuplicateDelivery=true
  h.report.workReceipts=records.map(w=>({identity:w.identity,status:w.status,inputs:w.inputs,deliveries:w.deliveries,checkpoints:w.checkpoints,evidence:w.evidence}))
  await h.review();h.report.ok=true
  }
}catch(error){failure=error}
finally{await h.finalize(failure)}
