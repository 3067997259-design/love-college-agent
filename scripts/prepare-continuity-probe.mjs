// No connection reads or model calls. Bind a reviewable grant template to passed preflights.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const [workPath,memoryPath,outputPath]=process.argv.slice(2)
assert.ok(workPath&&memoryPath&&outputPath,'WORK_MEMORY_REPORTS_AND_OUTPUT_REQUIRED')
const output=resolve(outputPath),repo=resolve(import.meta.dirname,'..')
const read=async file=>JSON.parse(await readFile(file,'utf8'))
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex')
const plan=await read(join(repo,'scripts/continuity-live-plan.json')), reports=[]
for(const [batch,root] of [['work',workPath],['memory',memoryPath]]){
  const report=await read(join(root,'report.json')),manifest=await read(join(root,'source-manifest.json'))
  assert.ok(report.ok&&report.selfTest&&report.batch===batch&&!report.gateway.halted&&!report.gateway.denials.length,'PREFLIGHT_NOT_PASSED:'+batch)
  assert.ok(report.gateway.samples.every(s=>s.ok),'PREFLIGHT_HAS_FAILED_REQUESTS')
  for(const [file,hash] of Object.entries(manifest))if(!file.startsWith('bundle/'))assert.equal(await sha(join(repo,file)),hash,'SOURCE_CHANGED:'+file)
  reports.push({root:resolve(root),reportSha256:await sha(join(root,'report.json')),report})
}
assert.equal(reports[0].report.receipt.asarSha256,reports[1].report.receipt.asarSha256,'PACKAGE_MISMATCH')
assert.deepEqual(reports[0].report.receipt.packageBridge,reports[1].report.receipt.packageBridge,'BRIDGE_MISMATCH')
await mkdir(output,{recursive:true})
for(const {report} of reports){
  const {id,...limits}=plan.batches.find(b=>b.id===report.batch)
  const grant={authorized:false,authorizationId:null,batch:id,asarSha256:report.receipt.asarSha256,packageBridge:report.receipt.packageBridge,
    maximumModelRequests:limits.maximumModelRequests,maximumReservedUnits:limits.maximumReservedUnits,maximumAutonomousUnits:limits.maximumAutonomousUnits,
    ...(id==='memory'?{maximumEmbeddingRequests:limits.maximumEmbeddingRequests,maximumEmbeddingInputCharacters:limits.maximumEmbeddingInputCharacters,embeddingAuthorized:false}:{}),
    unitDefinition:'Admission estimates, not money or provider billing; autonomous is part of total.',
    modelPolicy:'Use the saved chat model for all test lanes, without changing daily settings.',firstFailureStops:true}
  await writeFile(join(output,id+'-authorization.proposed.json'),JSON.stringify(grant,null,2)+'\n',{flag:'wx'})
}
await writeFile(join(output,'preflight-evidence.json'),JSON.stringify({authorized:false,reports:reports.map(({root,reportSha256,report})=>({root,reportSha256,batch:report.batch,checks:report.checks,requests:report.gateway.modelRequests,embeddingRequests:report.gateway.embeddingRequests}))},null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify({output,authorized:false,batches:reports.map(r=>r.report.batch)}))
