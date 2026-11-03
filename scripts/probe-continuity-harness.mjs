import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import electron from 'electron'
import { runtimeEnv, initializeTestBook, electronLaunchTarget } from './runtime-env.mjs'
import { continuityProbeLimits } from './fixtures/continuity-live-budget.ts'

export const sha = async file => createHash('sha256').update(await readFile(file)).digest('hex')
export const walk = async dir => { try { return (await Promise.all((await readdir(dir, { withFileTypes: true })).flatMap(e => e.isDirectory() && !['chromium','dsh-home','artifacts','rooms'].includes(e.name) ? [walk(join(dir,e.name))] : e.isFile() ? [[join(dir,e.name)]] : []))).flat() } catch(error) { if(error.code==='ENOENT') return []; throw error } }
export async function journalRows(profile) {
  return (await Promise.all((await Promise.all([walk(join(profile,'journals')),walk(join(profile,'continuous-work'))])).flat().filter(f => /[\\/]journals[\\/]/.test(f) && f.endsWith('.jsonl')).map(async file => {
    const text = await readFile(file,'utf8'); return text.slice(0,text.lastIndexOf('\n')).split('\n').filter(Boolean).map(line=>({...JSON.parse(line),_file:file}))
  }))).flat()
}
export async function workRecords(profile) {
  const current=new Map()
  for(const file of (await walk(profile)).filter(f=>f.endsWith('events.log') && /[\\/]continuous-work[\\/]/.test(f))) {
    const text=await readFile(file,'utf8')
    for(const line of text.slice(0,text.lastIndexOf('\n')).split('\x1e').filter(v=>v.trim())) { const value=JSON.parse(line);if(value.row?.work)current.set(value.row.work.identity.workId,value.row.work) }
  }
  return [...current.values()]
}
export async function createContinuityHarness(batch, entry, { firstRequestOnly = false, captureOnly = false, restoreOnly = false, restoreArchiveSha256 = null } = {}) {
  const repo=resolve(import.meta.dirname,'..'), selfTest=process.argv.includes('--self-test')
  const selfTestModelFault=process.env.LCA_CONTINUITY_SELF_TEST_MODEL_FAULT??null
  assert.ok(selfTestModelFault===null||selfTest&&['empty-stream','error-stream'].includes(selfTestModelFault),'SELF_TEST_FAULT_SCOPE_REQUIRED')
  assert.ok(process.env.LCA_CONTINUITY_PROBE_RUN && (selfTest || process.env.LCA_TEST_EXECUTABLE),'ISOLATED_RUN_AND_PACKAGE_REQUIRED')
  assert.ok(selfTest || process.env.LCA_REAL_MODEL==='1','LIVE_OPT_IN_REQUIRED')
  const root=resolve(process.env.LCA_CONTINUITY_PROBE_RUN),target=electronLaunchTarget(repo,electron),source=!process.env.LCA_TEST_EXECUTABLE
  const plan=JSON.parse(await readFile(join(repo,'scripts/continuity-live-plan.json'),'utf8'))
  assert.ok(!captureOnly||firstRequestOnly&&!selfTest,'CAPTURE_SCOPE_REQUIRED')
  const limits=continuityProbeLimits(plan,batch,{firstRequestOnly,restoreOnly})
  if(restoreOnly)assert.match(restoreArchiveSha256??'',/^[a-f0-9]{64}$/,'RESTORE_ARCHIVE_REQUIRED')
  let grant
  if(!selfTest){
    assert.ok(process.env.LCA_CONTINUITY_AUTH_FILE && process.env.LCA_PROVIDERS_FILE,'BATCH_AUTHORIZATION_REQUIRED')
    grant=JSON.parse(await readFile(process.env.LCA_CONTINUITY_AUTH_FILE,'utf8'))
    assert.ok(grant.authorized===true && grant.batch===batch && grant.authorizationId,'BATCH_AUTHORIZATION_REQUIRED')
    assert.equal(grant.firstRequestOnly===true,firstRequestOnly,'AUTHORIZATION_SCOPE_MISMATCH')
    assert.equal(grant.captureOnly===true,captureOnly,'CAPTURE_AUTHORIZATION_MISMATCH')
    assert.equal(grant.restoreOnly===true,restoreOnly,'RESTORE_AUTHORIZATION_MISMATCH')
    if(restoreOnly){
      assert.equal(grant.restoreArchiveSha256,restoreArchiveSha256,'AUTHORIZED_ARCHIVE_CHANGED')
      assert.equal(grant.firstFailureStops,true,'FIRST_FAILURE_POLICY_REQUIRED')
      assert.equal(await sha(join(grant.preflight.root,'report.json')),grant.preflight.reportSha256,'PREFLIGHT_CHANGED')
    }
    for(const field of ['maximumModelRequests','maximumReservedUnits','maximumAutonomousUnits','maximumEmbeddingRequests','maximumEmbeddingInputCharacters'])assert.equal(grant[field],limits[field],'BATCH_AUTHORIZATION_MISMATCH:'+field)
    if(batch==='memory')assert.ok(grant.embeddingAuthorized===true&&process.env.LCA_MEMORY_CONNECTION_FILE,'EMBEDDING_AUTHORIZATION_REQUIRED')
  }
  await mkdir(root,{recursive:true})
  const packageBridge={}
  const resources=join(dirname(target.executablePath),'resources'),bridgeRoot=source?join(repo,'dsh/lca-bridge'):join(resources,'lca-bridge')
  for(const file of await walk(bridgeRoot))packageBridge['lca-bridge/'+file.slice(bridgeRoot.length+1).replaceAll('\\','/')]=await sha(file)
  const sourceBuild={}
  if(source)for(const file of await walk(join(repo,'out')))sourceBuild[file.slice(repo.length+1).replaceAll('\\','/')]=await sha(file)
  if(source)assert.ok(sourceBuild['out/main/index.cjs']&&sourceBuild['out/renderer/index.html'],'SOURCE_BUILD_REQUIRED')
  const receipt={batch,selfTest,selfTestModelFault,source,firstRequestOnly,captureOnly,restoreOnly,restoreArchiveSha256,limits,responseTimeouts:plan.defaults.responseTimeouts,turnTimeoutMs:plan.defaults.turnTimeoutMs,barrierTimeoutMs:plan.defaults.barrierTimeoutMs,asarSha256:source?null:await sha(join(resources,'app.asar')),sourceBuild,packageBridge,probeManifest:'source-manifest.json'}
  await writeFile(join(root,'run.json'),JSON.stringify(receipt,null,2),{flag:'wx'})
  if(grant){
    assert.equal(grant.asarSha256,receipt.asarSha256,'AUTHORIZED_PACKAGE_CHANGED')
    assert.deepEqual(grant.packageBridge,packageBridge,'AUTHORIZED_BRIDGE_CHANGED')
    await writeFile(resolve(process.env.LCA_CONTINUITY_AUTH_FILE)+'.used',JSON.stringify({authorizationId:grant.authorizationId,root}),{flag:'wx'})
    await writeFile(join(root,'authorization.json'),JSON.stringify(grant,null,2),{flag:'wx'})
  }
  const compiled=join(repo,'.cache','continuity-live',randomUUID(),'gateway.cjs')
  await build({configFile:false,logLevel:'error',build:{ssr:join(repo,'scripts/fixtures/continuity-live-gateway.ts'),outDir:dirname(compiled),emptyOutDir:false,minify:false,rollupOptions:{external:['electron'],output:{format:'cjs',entryFileNames:'gateway.cjs'}}}})
  await mkdir(join(root,'source'))
  const names=[entry,'scripts/probe-continuity-harness.mjs','scripts/fixtures/continuity-live-gateway.ts','scripts/fixtures/continuity-scripted-model.ts','scripts/fixtures/continuity-live-budget.ts','scripts/fixtures/probe-transport.ts','scripts/fixtures/probe-response-deadline.ts','scripts/fixtures/world-probe-stream.ts','scripts/fixtures/world-probe-admission.ts','scripts/continuity-live-plan.json']
  const manifest={}
  for(const file of names){const target=file.replaceAll('/','__');await writeFile(join(root,'source',target),await readFile(join(repo,file)),{flag:'wx'});manifest[file]=await sha(join(repo,file))}
  manifest['bundle/gateway.cjs']=await sha(compiled)
  if(grant&&restoreOnly)assert.deepEqual(manifest,grant.probeManifest,'AUTHORIZED_PROBE_CHANGED')
  await mkdir(join(root,'bundle'));await writeFile(join(root,'bundle/gateway.cjs'),await readFile(compiled),{flag:'wx'})
  await writeFile(join(root,'source-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'})
  const env={...runtimeEnv(repo),LCA_TEST_SILENT:'1',LCA_MCP_PORT:'0',LCA_CDP_PORT:'0'}
  delete env.ELECTRON_RENDERER_URL;delete env.DSH_ROOT;delete env.LCA_BOOTH
  let helper,instance,page,profile=join(root,'profiles/main'),providers
  const approvals=[],answers=[],checks={},report={ok:false,batch,selfTest,firstRequestOnly,captureOnly,restoreOnly,receipt,checks,approvals,answers,error:null}
  const snapshot=()=>page.evaluate(()=>window.lca.getSnapshot())
  const send=body=>page.evaluate(async body=>{const state=await window.lca.getSnapshot();return window.lca.dispatch({...body,protocolVersion:1,epoch:state.epoch,requestId:crypto.randomUUID()})},body)
  const gateway=()=>helper.evaluate(()=>globalThis.continuityProbe.state())
  const phase=value=>helper.evaluate((_,value)=>globalThis.continuityProbe.phase(value),value)
  const approve=async state=>{
    const q=state.question
    if(q?.status!=='waiting'||q.kind!=='approval'||approvals.some(a=>a.id===q.id))return
    assert.ok(/^她想在「(?:first|parallel-a|parallel-b)」里运行命令：& \.\\barrier\.ps1 [AB][12]，可这台电脑的系统沙箱在这个文件夹里用不了。/.test(q.question),'UNEXPECTED_APPROVAL')
    const choice=q.choices.find(c=>/允许这一次|allow once/i.test(c))??q.choices.find(c=>/信任.*项目|trust.*project|trust.*workspace/i.test(c))
    assert.ok(choice,'UNEXPECTED_APPROVAL_CHOICES')
    approvals.push({id:q.id,question:q.question,choice,at:state.clock.nowMs})
    assert.equal((await send({type:'question.answer',questionId:q.id,answer:choice})).status,'accepted')
  }
  const wait=async(predicate,code,options={})=>{
    const deadline=Date.now()+plan.defaults.turnTimeoutMs
    while(Date.now()<deadline){
      const s=await snapshot(),g=await gateway();assert.equal(g.halted,false,'GATEWAY_HALTED:'+code)
      if(options.approvals)await approve(s)
      if(await predicate(s,g))return s
      await new Promise(done=>setTimeout(done,100))
    }
    report.lastState=await snapshot()
    throw new Error(code)
  }
  const closeApp=async()=>{await instance?.close();instance=undefined;page=undefined}
  const launch=async(next=profile)=>{
    profile=next;await mkdir(profile,{recursive:true})
    if(batch==='memory')await helper.evaluate((_,profile)=>globalThis.continuityProbe.installEmbedding(profile),profile)
    await helper.evaluate((_,profile)=>globalThis.continuityProbe.activate(profile),profile)
    instance=await _electron.launch({...target,env:{...env,LCA_DATA_DIR:profile,LCA_PROVIDERS_FILE:providers},timeout:30000})
    if(selfTest)await instance.evaluate(()=>{
      const cp=process.mainModule.require('node:child_process'),spawn=cp.spawn
      globalThis.probeDshErrors=[]
      cp.spawn=function(...args){const child=spawn.apply(this,args);if(args[1]?.includes('--profile'))child.on('message',message=>{if(message?.t==='error')globalThis.probeDshErrors.push(message)});return child}
    })
    page=await instance.firstWindow();await initializeTestBook(page)
    if((await snapshot()).backup.status==='restored')await helper.evaluate(()=>globalThis.continuityProbe.reconcileRestoredAdmissions())
    assert.equal((await snapshot()).runtime.developer.mode,'normal')
    assert.equal((await snapshot()).resources.model.totalLimitUnits,limits.maximumReservedUnits)
    await send({type:'life.schedule',schedule:'work'});await send({type:'mode.set',mode:'rest'})
  }
  const chat=async(text,step,options={})=>{
    await phase(step)
    assert.equal((await send({type:'message.send',text})).status,'accepted','CHAT_REJECTED:'+step)
    const message=(await journalRows(profile)).findLast(r=>r.type==='user/message'&&r.text===text)
    assert.ok(message,'USER_MESSAGE_NOT_PERSISTED:'+step)
    let answer,clarificationAnswered=false
    const result=await wait(async s=>{
      if(options.clarification&&!clarificationAnswered&&s.question?.status==='waiting'&&s.question.kind!=='approval'){
        assert.ok(s.question.items?.length,'CLARIFICATION_ITEMS_MISSING')
        report.clarification={id:s.question.id,items:s.question.items}
        assert.equal((await send({type:'question.answer',questionId:s.question.id,answers:s.question.items.map(item=>({id:item.id,selected:[],custom:options.clarificationAnswers?.[item.id]??options.clarificationAnswer??'先不改，两个任务保持原要求。'}))})).status,'accepted')
        clarificationAnswered=true
      }
      const rows=await journalRows(profile)
      if(rows.some(r=>r.type==='narrator/failure'&&r.failure?.sourceMessageId===message.id))throw Error('CHAT_FAILED:'+step)
      const seen=rows.findLast(r=>r.type==='model/seen'&&r.originalEvents?.some(e=>e.eventId===message.id))
      if(!seen||!rows.some(r=>r.type==='turn/end'&&r.turnId===seen.turnId&&r.reason==='completed'))return false
      answer=rows.findLast(r=>r.type==='assistant/message'&&r.turnId===seen.turnId&&r.status==='complete'&&!r.displayOnly)
      return !!answer
    },'CHAT_NOT_COMPLETED:'+step,{approvals:options.approvals})
    assert.ok(answer?.text&&!answer.failure,'CHAT_FAILED:'+step)
    answers.push({step,userMessageId:message.id,turnId:answer.turnId,text:answer.text});return result
  }
  const chooseProject=async path=>{
    await mkdir(path,{recursive:true});await instance.evaluate(({dialog},path)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[path]})},path)
    assert.equal((await send({type:'project.pick'})).status,'accepted')
    await wait(async s=>{
      if(s.work?.current?.path===path)return true
      // Picking a local folder can race DSH's final idle notification after turn/end.
      if(s.work?.status==='idle'&&s.work.error==='project-busy'&&s.task?.status==='completed')assert.equal((await send({type:'project.pick'})).status,'accepted')
      return false
    },'PROJECT_NOT_SELECTED')
  }
  const finalize=async(error)=>{
    if(error){report.error=error.message??String(error);process.exitCode=1}
    if(instance&&page){report.lastState=await snapshot().catch(()=>null);if(selfTest)report.dshErrors=await instance.evaluate(()=>globalThis.probeDshErrors).catch(()=>null)}
    await closeApp().catch(()=>{report.cleanupUncertain=true})
    if(helper){report.gateway=await gateway().catch(()=>null);await helper.evaluate(async()=>{await globalThis.continuityProbe?.close()}).catch(()=>{report.cleanupUncertain=true});await helper.close().catch(()=>{})}
    await writeFile(join(root,'report.json'),JSON.stringify(report,null,2))
    console.log(JSON.stringify({root,ok:report.ok,batch,selfTest,error:report.error,checks,gateway:report.gateway?{...report.gateway,captures:undefined,samples:report.gateway.samples?.length}:null}))
  }
  try{
    helper=await _electron.launch({...target,env:{...env,LCA_DATA_DIR:join(root,'helper'),LCA_PROVIDERS_FILE:join(root,'absent.json')},timeout:30000})
    providers=await helper.evaluate(async(_,input)=>{globalThis.continuityProbe=await process.mainModule.require(input.compiled).startContinuityGateway(input);return globalThis.continuityProbe.providersFile},{compiled,root,batch,selfTest,selfTestModelFault,firstRequestOnly,captureOnly,restoreOnly,authorized:selfTest?undefined:process.env.LCA_PROVIDERS_FILE,embeddingConfig:selfTest?undefined:process.env.LCA_MEMORY_CONNECTION_FILE})
    await launch()
  }catch(error){await finalize(error);throw error}
  return {root,selfTest,limits,report,checks,answers,snapshot,send,gateway,phase,wait,chat,chooseProject,launch,closeApp,finalize,
    profile:()=>profile,app:()=>instance,
    review:async()=>{
      await closeApp()
      if(selfTest)return
      await writeFile(join(root,'answers-for-review.json'),JSON.stringify({answers,checks},null,2))
      console.log(JSON.stringify({reviewRequired:batch,file:join(root,'answers-for-review.json'),reviewFile:join(root,'semantic-review.json')}))
      for(let i=0;i<600;i++){
        try{await access(join(root,'semantic-review.json'));const review=JSON.parse(await readFile(join(root,'semantic-review.json'),'utf8'));assert.ok(review.batch===batch&&review.accepted===true&&review.reason,'SEMANTIC_REVIEW_FAILED');report.semanticReview=review;return}catch(error){if(error.code!=='ENOENT')throw error}
        await new Promise(done=>setTimeout(done,500))
      }
      throw new Error('SEMANTIC_REVIEW_MISSING')
    },
  }
}
