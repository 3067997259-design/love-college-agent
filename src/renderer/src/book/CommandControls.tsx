import type { ReactNode } from 'react'
import type { AppBridge, AppSnapshot, DeskCommandView } from '../../../shared'
import words from '../voice/commands.zh.json'
import { commandScriptPreview } from './command-script'
import { fill } from './life/text'
import { useAct } from './useAct'
import './work.css'

type Props = { snapshot: AppSnapshot; bridge: AppBridge }
const ACTIVE: ReadonlySet<DeskCommandView['status']> = new Set(['preparing', 'awaiting-approval', 'running'])

/** 当前心流里的那条命令（心流结束就不再显示） */
const flowCommand = (snapshot: AppSnapshot) => snapshot.heartFlow?.activeId ? snapshot.heartFlow.command : undefined

/**
 * 心流里真正的 Windows 命令（主进程的书桌副本＋无网络底座，每次单独批准）。
 * 等你批准、准备中、运行中：停在输入框上面，和代码审批卡同一处，最先被看到。
 * 卡上只有快照里的东西：命令原文、能解码的脚本、范围和输入指纹；输出走用户专用窗口，不进快照。
 */
export function CommandDock({ snapshot, bridge }: Props) {
  const command = flowCommand(snapshot)
  const act = useAct(bridge, snapshot, command?.id)
  if (!command || !ACTIVE.has(command.status)) return null
  const script = commandScriptPreview(command.command)
  const waiting = command.status === 'awaiting-approval'
  return (
    <section className="dock-card dock-decision" data-desk-command={command.status} role={waiting ? 'alertdialog' : 'status'} aria-label={words.title}>
      <header className="dock-head">
        <span className="dock-label">{waiting ? words.ask : words.status[command.status]}</span>
        {!waiting && <span className="work-pulse" aria-hidden />}
      </header>
      <pre className="flow-code work-command" aria-label={words.commandLine}>{command.command}</pre>
      {script !== null && (
        <details className="work-script" open={waiting}>
          <summary>{words.script}</summary>
          <pre className="flow-code">{script}</pre>
        </details>
      )}
      <ScopeChips command={command} />
      {command.error?.code === 'command-encoding-unsupported' && <Notice>{words.encoding}</Notice>}
      <div className="card-actions dock-actions">
        {waiting ? <>
          <button type="button" className="btn btn-primary btn-small" disabled={act.busy} onClick={() => void act.send({ type: 'flow.command.approve', commandId: command.id, allow: true })}>{words.allow}</button>
          <button type="button" className="btn btn-ghost btn-small" disabled={act.busy} onClick={() => void act.send({ type: 'flow.command.approve', commandId: command.id, allow: false })}>{words.deny}</button>
        </> : (
          <button type="button" className="btn btn-ghost btn-small" disabled={act.busy} onClick={() => void act.send({ type: 'flow.command.cancel', commandId: command.id })}>{words.cancel}</button>
        )}
        {act.busy && <span className="work-sending" role="status">{words.sending}</span>}
      </div>
      {act.failed && <Notice>{words.error}</Notice>}
    </section>
  )
}

/**
 * 命令结束后的回执，收进心流工作台：退出码、用时、写回了什么。
 * 写回结果不确定（unknown）或中断（partial）时明说，已核实的份数只是下限；“查看命令输出”打开用户专用窗口。
 */
export function CommandReceipt({ snapshot, bridge }: Props) {
  const command = flowCommand(snapshot)
  const act = useAct(bridge, snapshot, command?.id)
  if (!command || ACTIVE.has(command.status)) return null
  const outcome = command.outcome
  const doubtful = outcome?.publication === 'unknown' || outcome?.publication === 'partial'
  const facts = outcome ? [
    outcome.exitCode === null ? words.exitUnknown : fill(words.exit, { code: outcome.exitCode }),
    outcome.elapsedMs === null ? null : fill(words.elapsed, { s: (outcome.elapsedMs / 1000).toFixed(1) }),
    outcome.changedFiles === null ? words.changedUnknown : fill(words.changed, { n: outcome.changedFiles }),
    outcome.processTreeTerminated ? words.tree : null,
  ].filter((fact): fact is string => fact !== null) : []
  const publication = outcome ? fill(words.publicationDetail[outcome.publication], { n: outcome.appliedFiles }) : null
  return (
    <div className="work-receipt" data-desk-command={command.status}>
      <div className="work-receipt-head">
        <span className="flow-label">{words.receiptTitle}</span>
        <span className="work-status" data-status={command.status}>{words.status[command.status]}</span>
      </div>
      <code className="work-command-line" title={command.command}>{command.command}</code>
      {facts.length > 0 && <p className="work-facts">{facts.join(' · ')}</p>}
      {publication && (doubtful ? <Notice>{publication}</Notice> : <p className="work-facts work-publication">{publication}</p>)}
      {command.error?.code === 'command-encoding-unsupported' && <Notice>{words.encoding}</Notice>}
      {outcome && (
        <button type="button" className="link-button" disabled={act.busy} onClick={() => void act.send({ type: 'flow.command.open', commandId: command.id })}>{words.output}</button>
      )}
      {act.failed && <Notice>{words.error}</Notice>}
    </div>
  )
}

/** 范围和证据：书桌副本、无网络、时限、输入几份文件和它们的指纹（只给前 8 位，完整值在提示里） */
function ScopeChips({ command }: { command: DeskCommandView }) {
  return (
    <ul className="work-chips" aria-label={words.scope}>
      <li>{words.chips.desk}</li>
      <li>{words.chips.offline}</li>
      <li>{fill(words.chips.timeout, { s: Math.round(command.timeoutMs / 1000) })}</li>
      <li>{fill(words.chips.files, { n: command.fileCount })}</li>
      <li title={command.snapshotHash}>{command.snapshotHash ? fill(words.chips.fingerprint, { hash: command.snapshotHash.slice(0, 8) }) : words.chips.fingerprintPending}</li>
    </ul>
  )
}

/** 需要你留意的一句：亮黄的“！”＋深色字，不靠红色。live 为假时不当成新提醒播报（例如对话里过去的失败） */
export function Notice({ children, live = true }: { children: ReactNode; live?: boolean }) {
  return <p className="work-notice" role={live ? 'alert' : undefined}><span className="notice-mark" aria-hidden>！</span><span>{children}</span></p>
}
