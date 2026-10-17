import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeEnv } from './runtime-env.mjs'
import { buildDeskCommand } from './build-desk-command.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); await buildDeskCommand()
const data = join(root, '.local-data', 'command-probe-' + randomUUID()); await mkdir(data, { recursive: true })
const outside = join(data, 'outside.txt'); await writeFile(outside, 'OUTSIDE_CANARY')
const quote = (text) => "'" + text.replaceAll("'", "''") + "'"
const ps = (script) => 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64')
async function run(command, timeoutMs = 5000, cancel = false, killed = false) {
  const work = join(data, 'lca-command-' + randomUUID()); await mkdir(work); const output = []
  if (typeof command === 'function') command = command(work)
  const child = spawn(join(root, 'out/native/DeskCommand.exe'), [], { windowsHide: true, env: runtimeEnv(root), stdio: ['pipe', 'pipe', 'pipe'] })
  const code = new Promise((done, reject) => { child.on('error', reject); child.on('exit', (code) => done(code)) }); child.stdout.on('data', (chunk) => output.push(chunk)); child.stderr.resume()
  child.stdin.on('error', () => {}); child.stdin.write(JSON.stringify({ root: work, command, timeoutMs }) + '\n')
  let descendant
  if (killed) {
    for (let i = 0; i < 100; i++) { try { descendant = Number(await readFile(join(work, 'descendant.pid'), 'utf8')); break } catch { await new Promise((done) => setTimeout(done, 50)) } }
    if (!Number.isInteger(descendant) || descendant <= 0) { child.kill(); await code; throw new Error('DESCENDANT_NOT_STARTED: ' + Buffer.concat(output).toString('utf8')) }; process.kill(descendant, 0); child.kill()
  }
  const timer = cancel ? setTimeout(() => child.stdin.write('cancel\n'), 1600) : undefined
  await code; clearTimeout(timer); child.stdin.end()
  const frames = Buffer.concat(output).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); const profile = frames.find((row) => row.kind === 'profile')?.name
  if (!profile && frames.at(-1)?.status === 'unavailable' && frames.at(-1)?.stage === 'encoding') return { work, result: frames.at(-1) }
  assert.match(profile, /^lca\.desk\.[a-f0-9]{32}$/)
  if (killed) {
    let gone = false; for (let i = 0; i < 100; i++) { try { process.kill(descendant, 0) } catch { gone = true; break }; await new Promise((done) => setTimeout(done, 50)) }; assert.ok(gone, 'DESCENDANT_SURVIVED_HELPER')
    await new Promise((done, reject) => execFile(join(root, 'out/native/DeskCommand.exe'), ['--cleanup', profile], { windowsHide: true }, (error, stdout) => error || !JSON.parse(stdout).profileRemoved ? reject(new Error('PROFILE_CLEANUP_FAILED')) : done())); return { work }
  }
  const result = frames.at(-1); return { work, result }
}
const first = await run('echo EXECUTED>result.txt & echo CHILD_OK & cmd.exe /d /c echo NATIVE_CHILD_OK')
assert.equal(first.result.status, 'completed', JSON.stringify(first.result)); assert.equal(first.result.exitCode, 0, JSON.stringify(first.result)); assert.equal(first.result.appContainer, true); assert.equal((await readFile(join(first.work, 'result.txt'), 'utf8')).trim(), 'EXECUTED'); assert.ok(first.result.stdout.includes('CHILD_OK')); assert.ok(first.result.stdout.includes('NATIVE_CHILD_OK'), JSON.stringify(first.result))
// Original #31 compound command, including effects before/after Unicode. Unsupported hosts must reject all of it before execution.
const literal = await run('echo EXECUTED>result.txt & echo CHILD_OK & echo 中文输出 & echo 中文文件>unicode-literal.txt & cmd.exe /d /c echo NATIVE_CHILD_OK')
if (literal.result.status === 'unavailable') {
  assert.equal(literal.result.stage, 'encoding'); assert.equal(literal.result.error, 'command-encoding-unsupported'); await assert.rejects(readFile(join(literal.work, 'result.txt'))); await assert.rejects(readFile(join(literal.work, 'unicode-literal.txt')))
} else {
  assert.equal(literal.result.status, 'completed'); assert.equal(literal.result.exitCode, 0); assert.ok(literal.result.stdout.includes('中文输出')); assert.equal((await readFile(join(literal.work, 'unicode-literal.txt'), 'utf8')).trim(), '中文文件')
}
const unicode = await run(ps("[IO.File]::WriteAllText([IO.Path]::Combine($env:LCA_DESK_ROOT,'unicode.txt'),'中文文件'); $bytes=[Text.Encoding]::UTF8.GetBytes('中文输出'); $stream=[Console]::OpenStandardOutput(); $stream.Write($bytes,0,$bytes.Length)"))
assert.equal(unicode.result.exitCode, 0, JSON.stringify(unicode.result)); assert.ok(unicode.result.stdout.includes('中文输出')); assert.equal(await readFile(join(unicode.work, 'unicode.txt'), 'utf8'), '中文文件')
const invalid = await run(ps('$stream=[Console]::OpenStandardOutput(); $stream.WriteByte(255)')); assert.equal(invalid.result.status, 'unavailable'); assert.equal(invalid.result.error, 'command-encoding-unsupported')
let connections = 0; const server = createServer((socket) => { connections++; socket.destroy() }); await new Promise((done) => server.listen(0, '127.0.0.1', done))
try {
  const negativeScript = [
    '$denied=0',
    "try{[void][IO.File]::ReadAllText(" + quote(outside) + "); 'READ_ESCAPE'}catch{$denied++}",
    "try{[IO.File]::WriteAllText(" + quote(outside) + ",'CHANGED'); 'WRITE_ESCAPE'}catch{$denied++}",
    "try{$acl=[Security.AccessControl.FileSecurity]::new(); $sid=[Security.Principal.SecurityIdentifier]::new('S-1-15-2-1'); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); [IO.File]::WriteAllText([IO.Path]::Combine($env:LCA_DESK_ROOT,'acl-attempt.txt'),'ATTEMPTED'); [IO.File]::SetAccessControl(" + quote(outside) + ",$acl); 'ACL_ESCAPE'}catch{$denied++}",
    "'DENIED='+$denied; $count=0; foreach($key in [Environment]::GetEnvironmentVariables().Keys){if($key -match 'PROVIDER|API_KEY|TOKEN|PROXY'){$count++}}; 'ENVCOUNT='+$count",
  ].join('; ')
  const negative = await run(ps(negativeScript))
  assert.equal(negative.result.status, 'completed', JSON.stringify(negative.result)); assert.equal(negative.result.exitCode, 0); assert.ok(negative.result.stdout.includes('DENIED=3'), JSON.stringify(negative.result)); assert.ok(negative.result.stdout.includes('ENVCOUNT=0')); assert.equal(await readFile(join(negative.work, 'acl-attempt.txt'), 'utf8'), 'ATTEMPTED'); assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_CANARY')
  const network = await run(ps("[IO.File]::WriteAllText([IO.Path]::Combine($env:LCA_DESK_ROOT,'network-attempt.txt'),'ATTEMPTED'); try{$tcp=[Net.Sockets.TcpClient]::new(); $wait=$tcp.ConnectAsync('127.0.0.1'," + server.address().port + "); if($wait.Wait(500) -and $tcp.Connected){'NETWORK_ESCAPE'}else{'NETWORK_BLOCKED'}}catch{'NETWORK_BLOCKED'}"))
  assert.equal(await readFile(join(network.work, 'network-attempt.txt'), 'utf8'), 'ATTEMPTED'); assert.ok(['completed', 'timeout'].includes(network.result.status), JSON.stringify(network.result)); assert.equal(network.result.networkCapabilities, 0); assert.equal(connections, 0); assert.ok(!network.result.stdout.includes('NETWORK_ESCAPE'))
  const limit = await run(ps("'x'*70000")); assert.equal(limit.result.status, 'output-limit')
  const timeout = await run(ps('while($true){}'), 1200); assert.equal(timeout.result.status, 'timeout')
  const cancelled = await run(ps('Start-Sleep -Seconds 20'), 5000, true); assert.equal(cancelled.result.status, 'cancelled')
  const sub = Buffer.from('Start-Sleep -Seconds 30', 'utf16le').toString('base64')
  await run((work) => ps('$ErrorActionPreference=\'Stop\'; $start=New-Object Diagnostics.ProcessStartInfo; $start.FileName="$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"; $start.Arguments="-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + sub + '"; $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $child=[Diagnostics.Process]::Start($start); [IO.File]::WriteAllText(' + quote(join(work, 'descendant.pid')) + ',[string]$child.Id); Start-Sleep -Seconds 20'), 10000, false, true)
  console.log(JSON.stringify({ ok: true, probe: 'desk-command-native', appContainer: true, actualCmd: true, unicodeLiteral: literal.result.status === 'completed' ? 'preserved' : 'rejected-before-effects', unicodeStdout: true, invalidUtf8Rejected: true, nativeChild: true, deskWrite: true, outsideReadDenied: true, outsideWriteDenied: true, outsideAclDenied: true, loopbackDenied: true, cleanEnvironment: true, outputBound: true, timeout: true, cancellation: true, helperDeathKillsDescendant: true }))
} finally { await new Promise((done) => server.close(done)) }
