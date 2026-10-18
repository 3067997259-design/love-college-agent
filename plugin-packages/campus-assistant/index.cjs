'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const pinned = { 'bridge.py': 'b4a5654245796e7962391f45736167c4eea6837997b0a37b4a01c160ab2032ab', 'candidates.cjs': 'd6394b0ec58ec9900a3176008d62d7083df749ea4ca23eb0d4d20426e5800d1a' }
for (const [name, hash] of Object.entries(pinned)) if (createHash('sha256').update(readFileSync(join(__dirname, name), 'utf8').replace(/\r\n/g, '\n')).digest('hex') !== hash) throw new Error('CAMPUS_PLUGIN_CHANGED')
const candidates = require('./candidates.cjs')
const receipt = (ok, value) => ({ ok, raw: value, visible: value })
async function invoke(input, context) {
  try {
    context.signal.throwIfAborted()
    if (input.action === 'import') return candidates.tools.import_student_hub_candidates({}, context)
    if (['status', 'collect', 'cancel'].includes(input.action) && !input.jobId) return receipt(false, { error: 'scan-job-required' })
    const root = candidates.studentHubRoot()
    const args = ['-B', join(__dirname, 'bridge.py'), '--config', candidates.configPath(root), '--action', input.action, '--limit', String(input.limit ?? 10)]
    if (input.jobId) args.push('--job', input.jobId)
    if (process.env.LCA_STUDENT_HUB_DB) args.push('--db', process.env.LCA_STUDENT_HUB_DB)
    const { stdout } = await run(candidates.pythonPath(), args, { cwd: root, env: { ...candidates.childEnvironment(root), PYTHONIOENCODING: 'utf-8' }, timeout: 25000, maxBuffer: 1600000, windowsHide: true, signal: context.signal })
    context.signal.throwIfAborted()
    const output = JSON.parse(stdout)
    if (input.action === 'health') return receipt(output.ok === true, { backend: output.backend === true, configured: output.configured === true, authentication: 'not-tested' })
    const states = ['queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'cancelled']
    if (!states.includes(output.status) || typeof output.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(output.jobId)) return receipt(false, { error: 'student-hub-unavailable' })
    const result = receipt(output.ok === true, { jobId: output.jobId, status: output.status, action: input.action })
    if (input.action === 'collect' && output.status === 'succeeded') {
      const existing = await candidates.readCandidates(context.nowMs(), context.signal)
      result.candidates = existing.candidates
      const sourceMails = (output.artifacts ?? []).slice(0, 20).map((artifact) => {
        const stamp = Date.parse(artifact.at); const at = Number.isFinite(stamp) && stamp >= 0 ? stamp : context.nowMs()
        return { uidValidity: BigInt('0x' + createHash('sha256').update(JSON.stringify(['student-hub', root, artifact.source, artifact.version])).digest('hex').slice(0, 15)).toString(),
          uid: artifact.id, senderAddress: 'artifact-' + createHash('sha256').update(JSON.stringify([root, artifact.source])).digest('hex').slice(0, 16) + '-' + artifact.id + '@student-hub.local', senderName: 'Student Hub', subject: artifact.subject, body: artifact.body, sentAtMs: at, receivedAtMs: at }
      })
      if (sourceMails.length) result.sourceMails = sourceMails
      else result.visible = result.raw = { ...result.visible, evidenceCount: 0, candidates: existing.candidates.length }
    }
    return result
  } catch { return receipt(false, { error: context.signal.aborted ? 'operation-cancelled' : 'student-hub-unavailable' }) }
}
module.exports = { tools: { campus_assistant: invoke }, activate: candidates.activate }
