import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { WorkRecord } from '../../src/main/work/journal'

type Message = { role: string; content: unknown; tool_calls?: { function: { name: string; arguments: string } }[] }
export type ProbeRequest = { model: string; stream?: boolean; messages: Message[]; tools?: { function: { name: string; parameters: unknown } }[] }
export const messageText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('') : ''
export function requestObjects(input: ProbeRequest): Record<string, unknown>[] {
  return input.messages.flatMap(m => messageText(m.content).split('\n\n').flatMap(text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? [value] : [] } catch { return [] } }))
}
export function workPackage(input: ProbeRequest) {
  const value = requestObjects(input).findLast(o => o.kind === 'work-package' || o.kind === 'work-decision-update')
  if (!value) return undefined
  const work = value as unknown as Pick<WorkRecord, 'identity' | 'objective'>
  assert.ok(typeof work.identity?.workId === 'string' && Number.isSafeInteger(work.identity.generation) && typeof work.objective === 'string', 'INVALID_WORK_PACKAGE')
  return work
}
type WorkReference = WorkRecord & { checkpoint?: { published: boolean } }
const workReferences = (objects: Record<string, unknown>[]) => (objects.findLast(o => Array.isArray(o.workCheckpoints))?.workCheckpoints ?? []) as WorkReference[]
type Reply = { text?: string; tool?: string; args?: unknown }
/** Protocol fixture, used only in --self-test. No scripted text enters real-model requests. */
export function createContinuityScriptedModel() {
  const workerSteps = new Map<string, number>()
  return (body: ProbeRequest, phase: string, slot: string): Reply => {
    const objects = requestObjects(body)
    const allText = body.messages.map(m => messageText(m.content)).join('\n')
    const lastUser = body.messages.findLastIndex(m => m.role === 'user')
    const toolMessages = body.messages.slice(lastUser + 1).filter(m => m.role === 'tool')
    const call = (name: string, args: unknown): Reply => {
      const tool = body.tools?.find(t => t.function.name === name || t.function.name === 'lca_' + name)
      assert.ok(tool, 'SCRIPTED_TOOL_UNAVAILABLE:' + name)
      return { tool: tool.function.name, args }
    }
    if (slot === 'background') {
      const input = objects.at(-1)
      if (input && ('userText' in input || 'assistantText' in input)) return { text: '[]' }
      if (Array.isArray(input)) return { text: JSON.stringify({ lines: input.slice(0, 2).map((s: { id: string; text: string }) => ({ sourceId: s.id, quote: s.text.slice(0, 120) })) }) }
      return { text: '[]' }
    }
    if (phase === 'compact') return { text: 'Earlier ordinary conversation was summarized. Current reviewed memory must be read from the current reference; older preferences can be superseded.' }
    const packageInput = workPackage(body)
    if (packageInput && body.tools?.some(t => t.function.name.endsWith('inspect_current_work'))) {
      const identity = packageInput.identity, key = identity.workId + ':' + identity.generation
      let step = workerSteps.get(key) ?? 0
      if (step === 1 && messageText(body.messages.findLast(m => m.role === 'tool')?.content).includes('trusted this project')) step = 0
      workerSteps.set(key, step + 1)
      const label = /WORK_([AB])/.exec(packageInput.objective)?.[1] ?? 'A'
      if (step === 0) return call('pwsh', { description: 'Wait for the isolated test barrier', command: '& .\\barrier.ps1 ' + label + identity.generation, timeout: 180000 })
      if (step === 1) {
        const text = /COFFEE/.test(allText) ? 'COFFEE' : 'TEA'
        return call('write', { file_path: 'result.txt', content: text + '\n' })
      }
      if (step === 2) return call('inspect_current_work', {})
      if (step === 3) {
        const inspected = objects.findLast(o => (o.identity as WorkRecord['identity'] | undefined)?.workId === identity.workId && Array.isArray(o.evidence)) as WorkRecord | undefined
        assert.ok(inspected, 'SCRIPTED_WORK_INSPECTION_MISSING')
        const proof = inspected.evidence?.findLast(e => e.kind === 'artifact' && e.status === 'passed' && e.identity.objectiveRevision === inspected.identity.objectiveRevision)
        assert.ok(proof, 'SCRIPTED_WORK_PROOF_MISSING')
        return call('finish_work', { expectedObjectiveRevision: inspected.identity.objectiveRevision, evidenceIds: [proof.id], outcome: 'completed', explanation: 'Updated result.txt from the latest original decision.', unresolved: [], nextStep: null })
      }
      return { text: '工作检查点已准备好。' }
    }
    const user = body.messages.filter(m => m.role === 'user').flatMap(m => messageText(m.content).split('\n\n')).findLast(text => text.startsWith('请启动独立工作')) ?? ''
    if (phase.startsWith('work-create-') && !toolMessages.length) return call('start_work', { objective: user, acceptance: ['result.txt matches the latest original decision and has an evidence-backed checkpoint.'] })
    if (phase === 'work-amend' && !toolMessages.length) {
      const work = workReferences(objects).find(w => w.status === 'running' || w.status === 'waiting')
      assert.ok(work, 'SCRIPTED_WORK_REFERENCE_MISSING')
      return call('update_work', { workId: work.identity.workId, expectedRevision: work.revision, action: 'supplement' })
    }
    if (phase === 'work-ambiguous') return !toolMessages.length ? call('ask_user_question', { questions: [{ id: 'target', question: '你要修改任务 A 还是任务 B？请明确工作编号。' }] }) : { text: '已保留两个任务的原要求。' }
    if (phase === 'work-followup') {
      assert.ok(workReferences(objects).some(w => w.checkpoint?.published), 'SCRIPTED_CHECKPOINT_MISSING')
      return { text: 'result.txt 已按你的后续要求改成 COFFEE，文件检查点已经确认。' }
    }
    if (phase === 'remember' && !toolMessages.length) return call('remember_memory', { content: '我平时喜欢喝茶。', title: '饮料偏好', summary: '当前喜欢喝茶。' })
    if (phase === 'correct' || phase === 'forget') {
      if (!toolMessages.length) return call('search_memory', { query: '饮料偏好' })
      if (toolMessages.length === 1) {
        const raw = messageText(toolMessages[0].content)
        const target = JSON.parse(raw)
        const scan = (value: unknown): Record<string, unknown>[] => value && typeof value === 'object' ? [value as Record<string, unknown>, ...Object.values(value).flatMap(scan)] : []
        const fact = scan(target).find(v => typeof v.id === 'string' && typeof v.revision === 'number' && (v.content || v.text))
        assert.ok(fact, 'SCRIPTED_MEMORY_TARGET_MISSING')
        return call(phase === 'correct' ? 'correct_memory' : 'forget_memory', { targetId: fact.id, expectedRevision: fact.revision,
          ...(phase === 'correct' ? { content: '我现在喜欢喝咖啡，不再喝茶。', title: '饮料偏好', summary: '当前喜欢喝咖啡。' } : {}) })
      }
    }
    if (['recall-tea', 'recall-coffee', 'after-compact', 'after-restart', 'after-forget', 'after-restore'].includes(phase)) {
      if (!toolMessages.length) return call('search_memory', { query: '饮料偏好' })
      const result = messageText(toolMessages.at(-1)?.content)
      return { text: result.includes('咖啡') ? '当前记忆是你喜欢喝咖啡。' : result.includes('喝茶') ? '当前记忆是你喜欢喝茶。' : '目前没有可用的饮料偏好记忆。' }
    }
    return { text: phase.startsWith('work-') ? '收到，我会按这项要求处理。' : '这条记忆操作等待你审阅确认。' }
  }
}

export function scriptedResponse(body: ProbeRequest, reply: Reply) {
  const call = reply.tool ? [{ index: 0, id: randomUUID(), type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] : undefined
  if (!body.stream) return JSON.stringify({ id: randomUUID(), object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: reply.text ?? null, ...(call ? { tool_calls: call } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })
  return 'data: ' + JSON.stringify({ id: randomUUID(), object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text ?? null, ...(call ? { tool_calls: call } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n'
}
