import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import electronPath from 'electron'
import { runtimeEnv } from './runtime-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); const data = join(root, '.local-data', 'resource-concurrency-' + randomUUID())
await mkdir(data, { recursive: true })
for (const name of ['ledger', 'sqlite-mutex']) await writeFile(join(data, name + '.cjs'), ts.transpileModule(await readFile(join(root, 'src/main/resources', name + '.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText)
const helper = join(data, 'worker.cjs'); const ledgerRoot = join(data, 'ledger')
await writeFile(helper, `
const {existsSync,writeFileSync}=require('node:fs'); const {join}=require('node:path');
const {openResourceMutex}=require('./sqlite-mutex.cjs'); const {openResourceLedger,ResourceFailure}=require('./ledger.cjs');
const [root,mode,name]=process.argv.slice(2); const clock={nowMs:()=>1792209600000,iso:(ms)=>new Date(ms).toISOString()};
const mutex=openResourceMutex(root); const ledger=openResourceLedger({root,clock,atomic:mutex.atomic,configurable:true});
try { if(mode==='init')ledger.configure({dailyTotalUnits:10000,dailyAutonomousUnits:10000});
 let admitted=0,denied=0; if(mode==='worker'){
  writeFileSync(join(root,name+'.ready'),'ready'); const until=Date.now()+15000;
  while(!existsSync(join(root,'go'))){if(Date.now()>until)throw new Error('BARRIER_TIMEOUT'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}
  for(let i=0;i<10;i++){try{ledger.reserveModel(1000,'autonomous');admitted++}catch(error){if(!(error instanceof ResourceFailure)||error.code!=='budget-exceeded')throw error;denied++}}
 }
 process.stdout.write(JSON.stringify({admitted,denied,view:ledger.view()}));
} finally {mutex.close()}
`)
const running = []
function launch(mode, name = mode) {
  const child = spawn(electronPath, [helper, ledgerRoot, mode, name], { cwd: root, env: { ...runtimeEnv(root), ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let errorOutput = ''
  const done = new Promise((resolve, reject) => { child.stdout.on('data', (data) => { output += data }); child.stderr.on('data', (data) => { errorOutput += data }); child.on('error', reject); child.on('exit', (code) => { if (code !== 0) reject(new Error('RESOURCE_WORKER_FAILED: ' + errorOutput.slice(-1000))); else { try { resolve(JSON.parse(output)) } catch { reject(new Error('RESOURCE_WORKER_BAD_RESULT')) } } }) }); done.catch(() => {})
  const own = { child, done }; running.push(own); return own
}
try {
  await launch('init').done
  const first = launch('worker', 'first'); const second = launch('worker', 'second')
  for (let i = 0; ; i++) {
    assert.equal(first.child.exitCode, null); assert.equal(second.child.exitCode, null)
    if ((await Promise.allSettled(['first', 'second'].map((name) => access(join(ledgerRoot, name + '.ready'))))).every((result) => result.status === 'fulfilled')) break
    if (i >= 300) throw new Error('RESOURCE_WORKERS_NOT_READY'); await new Promise((done) => setTimeout(done, 25))
  }
  await writeFile(join(ledgerRoot, 'go'), 'go'); const results = await Promise.all([first.done, second.done])
  assert.equal(results.reduce((sum, result) => sum + result.admitted, 0), 10); assert.equal(results.reduce((sum, result) => sum + result.denied, 0), 10)
  const final = await launch('view').done; assert.equal(final.view.model.totalReservedUnits, 10000); assert.equal(final.view.model.autonomousReservedUnits, 10000); assert.equal(final.view.model.attemptCount, 10)
  const lines = (await readFile(join(ledgerRoot, 'usage.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); assert.ok(lines.every((row, i) => row.seq === i + 1)); assert.equal(lines.filter((row) => row.kind === 'model').length, 10)
  await mkdir(join(root, 'test-results'), { recursive: true }); await writeFile(join(root, 'test-results/resource-concurrency-report.json'), JSON.stringify({ ok: true, atIso: new Date().toISOString(), concurrentNativeElectronProcesses: 2, realSqliteImmediateMutex: true, attempts: 20, admitted: 10, denied: 10, reservedUnits: 10000, appendOnlySeqsContinuous: true, reopenedByThirdProcess: true, realProviderUsed: false }, null, 2))
  console.log('Resource concurrency passed: two live native Electron/SQLite workers, 20 competing requests, exactly ten fsynced 1000-unit admissions, ten refusals, continuous append-only sequence and third-process reopen; no supplier calls.')
} finally { for (const { child } of running) if (child.exitCode === null && !child.killed) child.kill() }
