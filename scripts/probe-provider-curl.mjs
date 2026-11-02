import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { build } from 'vite'
import { _electron } from 'playwright'
import { runtimeEnv } from './runtime-env.mjs'

const repo=resolve(import.meta.dirname,'..'), selfTest=process.argv.includes('--self-test')
assert.ok(process.env.LCA_CONTINUITY_PROBE_RUN&&process.env.LCA_TEST_EXECUTABLE,'ISOLATED_RUN_AND_PACKAGE_REQUIRED')
assert.ok(selfTest||process.env.LCA_REAL_MODEL==='1'&&process.env.LCA_PROVIDERS_FILE,'LIVE_OPT_IN_AND_CONNECTION_REQUIRED')
const root=resolve(process.env.LCA_CONTINUITY_PROBE_RUN),exe=resolve(process.env.LCA_TEST_EXECUTABLE),hash=data=>createHash('sha256').update(data).digest('hex')
await mkdir(root,{recursive:true})
await writeFile(join(root,'authorization.json'),JSON.stringify({id:randomUUID(),selfTest,source:selfTest?'local fixture only':'user explicitly requested one direct curl request with the saved endpoint and API key',maximumModelRequests:1,maximumReservedUnits:16000,maximumAutonomousUnits:0,automaticRetry:false,asarSha256:hash(await readFile(join(dirname(exe),'resources/app.asar')))},null,2),{flag:'wx'})
const compiled=join(repo,'.cache','curl-probe',randomUUID(),'probe.cjs')
await build({configFile:false,logLevel:'error',build:{ssr:join(repo,'scripts/fixtures/provider-curl-probe.ts'),outDir:dirname(compiled),emptyOutDir:false,minify:false,rollupOptions:{external:['electron'],output:{format:'cjs',entryFileNames:'probe.cjs'}}}})
const manifest={};await mkdir(join(root,'source'))
for(const file of ['scripts/probe-provider-curl.mjs','scripts/fixtures/provider-curl-probe.ts','scripts/fixtures/curl-transport.ts','scripts/fixtures/probe-response.ts']){const contents=await readFile(join(repo,file));manifest[file]=hash(contents);await writeFile(join(root,'source',file.replaceAll('/','__')),contents,{flag:'wx'})}
manifest['probe.cjs']=hash(await readFile(compiled));await writeFile(join(root,'probe.cjs'),await readFile(compiled),{flag:'wx'});await writeFile(join(root,'source-manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'})
const env={...runtimeEnv(repo),LCA_DATA_DIR:join(root,'helper'),LCA_PROVIDERS_FILE:join(root,'absent.json'),LCA_TEST_SILENT:'1',LCA_MCP_PORT:'0',LCA_CDP_PORT:'0'}
delete env.ELECTRON_RENDERER_URL;delete env.DSH_ROOT;delete env.LCA_BOOTH
let app
try{
  app=await _electron.launch({executablePath:exe,args:[],env,timeout:30000})
  const report=await app.evaluate(async(_,input)=>process.mainModule.require(input.compiled).probeProviderCurl(input),{compiled,root,selfTest,providersFile:selfTest?undefined:process.env.LCA_PROVIDERS_FILE})
  console.log(JSON.stringify({root,...report}));if(!report.ok)process.exitCode=1
}catch(error){console.log(JSON.stringify({root,error:error.message}));process.exitCode=1}
finally{await app?.close()}
