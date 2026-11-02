import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import { runtimeEnv } from './runtime-env.mjs'

const networkOnly=process.argv.includes('--network-only')
assert.ok(process.env.LCA_REAL_MODEL==='1'&&process.env.LCA_PROVIDERS_FILE&&(networkOnly||process.env.LCA_DIAGNOSIS_SPEC)&&process.env.LCA_CONTINUITY_PROBE_RUN&&process.env.LCA_TEST_EXECUTABLE,'DIAGNOSIS_AUTHORIZATION_REQUIRED')
const repo=resolve(import.meta.dirname,'..'),root=resolve(process.env.LCA_CONTINUITY_PROBE_RUN),exe=resolve(process.env.LCA_TEST_EXECUTABLE)
if(!networkOnly){try{await access(join(root,'closed.json'));throw Error('DIAGNOSIS_WINDOW_CLOSED')}catch(error){if(error.code!=='ENOENT')throw error}}
const spec=networkOnly?{id:'network-readonly'}:JSON.parse(await readFile(process.env.LCA_DIAGNOSIS_SPEC,'utf8'));assert.match(spec.id,/^[a-z0-9-]+$/)
const grantFile=join(root,'authorization.json'),hash=data=>createHash('sha256').update(data).digest('hex')
await mkdir(root,{recursive:true})
try{await access(grantFile)}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(grantFile,JSON.stringify({id:randomUUID(),source:'user: 去详细探究一下原因。复现出结论后汇报。',maximumModelRequests:8,maximumReservedUnits:128000,maximumAutonomousUnits:0,scope:'controlled diagnosis; expected failed conditions recorded; no automatic retries',asarSha256:hash(await readFile(join(dirname(exe),'resources/app.asar')))},null,2),{flag:'wx'})}
const grant=JSON.parse(await readFile(grantFile,'utf8'));assert.equal(grant.asarSha256,hash(await readFile(join(dirname(exe),'resources/app.asar'))));assert.equal(grant.maximumModelRequests,8)
const compiled=join(repo,'.cache','provider-diagnosis',randomUUID(),'probe.cjs')
await build({configFile:false,logLevel:'error',build:{ssr:join(repo,'scripts/fixtures/provider-diagnosis.ts'),outDir:dirname(compiled),emptyOutDir:false,minify:false,rollupOptions:{external:['electron'],output:{format:'cjs',entryFileNames:'probe.cjs'}}}})
const frozen=join(root,spec.id,'source');await mkdir(frozen,{recursive:true});const manifest={}
for(const file of ['scripts/probe-provider-diagnosis.mjs','scripts/fixtures/provider-diagnosis.ts','scripts/fixtures/curl-transport.ts','scripts/fixtures/probe-response.ts','scripts/fixtures/probe-transport.ts']){const data=await readFile(join(repo,file));manifest[file]=hash(data);await writeFile(join(frozen,file.replaceAll('/','__')),data,{flag:'wx'})}
const bundle=await readFile(compiled);manifest['probe.cjs']=hash(bundle);await writeFile(join(frozen,'probe.cjs'),bundle,{flag:'wx'});await writeFile(join(root,spec.id,'source-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'})
const env={...runtimeEnv(repo),LCA_DATA_DIR:join(root,spec.id,'helper'),LCA_PROVIDERS_FILE:join(root,'absent.json'),LCA_TEST_SILENT:'1',LCA_MCP_PORT:'0',LCA_CDP_PORT:'0'}
delete env.ELECTRON_RENDERER_URL;delete env.DSH_ROOT;delete env.LCA_BOOTH
let app
try{app=await _electron.launch({executablePath:exe,args:[],env,timeout:30000});const report=await app.evaluate(async(_,input)=>process.mainModule.require(input.compiled)[input.networkOnly?'inspectProviderPath':'runProviderDiagnosis'](input),{compiled,root,providersFile:process.env.LCA_PROVIDERS_FILE,spec,networkOnly});console.log(JSON.stringify(report))}
finally{await app?.close()}
