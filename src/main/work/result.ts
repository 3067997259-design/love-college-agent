import type { WorkInterruption, WorkResultState } from '../../shared/continuity'
import type { WorkRecord } from './journal'

export function recordWorkInterruption(work: WorkRecord, reason: WorkInterruption['reason'], atMs: number) {
  work.lastInterruption = { generation: work.identity.generation, objectiveRevision: work.identity.objectiveRevision, atMs, reason }
}

export function workResultState(work: WorkRecord): WorkResultState {
  const checkpoint = work.checkpoints?.find(item => item.id === work.checkpointId)
  const published = checkpoint && work.delivery?.checkpointId === checkpoint.id
    && checkpoint.identity.generation === work.identity.generation && checkpoint.identity.objectiveRevision === work.identity.objectiveRevision
  return { completion: published ? checkpoint.outcome : 'unverified', interruption: work.lastInterruption ? structuredClone(work.lastInterruption) : null,
    unconfirmedCommands: (work.evidence ?? []).filter(item => item.kind === 'command' && item.status !== 'passed' && item.exitCode === null).length }
}

/** Safe facts plus their meaning; no command text, tool results or external targets.
 * This same projection reaches foreground queries and resumed Worker roots. */
export function workResultContext(work: WorkRecord) {
  return { ...workResultState(work),
    instruction: '完成状态只由已发布检查点证明。没有完成证据，不等于外部动作没有发生；失败或停止也不证明外部动作已撤回。执行被中断或命令没有明确结果时，应说明结果尚未确认，先核对实际文件或外部服务记录，再决定是否继续，不能直接重发。新代次不消除旧动作的不确定性，也不继承旧批准。检查点只证明所列产物或命令，不证明其他外部动作的结果。' }
}
