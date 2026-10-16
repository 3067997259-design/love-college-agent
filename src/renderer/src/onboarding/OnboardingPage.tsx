import { useEffect, useRef, useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand, type CommandBody } from '../book/command'
import { ROOM_COLOR_MS, type IntroStep } from '../book/wash/intro'
import copy from '../voice/onboarding.zh.json'
import './onboarding.css'

/**
 * 首次启动：把她画出来（体验设计 §7.1）。右页是向导，只留必填的几步；左页跟着每一步变化：
 * 写名字时铅笔画出空房间再勾出她，接上模型时彩铅上简单的颜色，叫出她的名字时晕成真实颜色，
 * 最后她拿起羽毛笔给整个房间上色，转过来注意到你。
 * “我已经有一本书了”走存档恢复：主进程校验、确认、重启，重启后颜色从笔尖晕开。
 * 名字和称呼的保存、是否已完成新手流程，等主进程的接口落地后再接；现在只在浏览器预览（?onboarding）里跑。
 */
export type OnboardingStep = 'cover' | 'name' | 'model' | 'call' | 'persona' | 'alive' | 'coloring' | 'greet'

const NUMBERED: readonly OnboardingStep[] = ['name', 'model', 'call', 'persona', 'alive']
const VISUAL: Record<OnboardingStep, IntroStep> = {
  cover: 'paper', name: 'drawing', model: 'flat', call: 'real', persona: 'real', alive: 'real', coloring: 'room', greet: 'done',
}
export const introStepOf = (step: OnboardingStep) => VISUAL[step]

export function OnboardingPage({ snapshot, bridge, step, onStep, onDone }: {
  snapshot: AppSnapshot
  bridge: AppBridge
  step: OnboardingStep
  onStep: (step: OnboardingStep) => void
  onDone: (names: { userName: string; characterName: string }) => void
}) {
  const [userName, setUserName] = useState('')
  const [characterName, setCharacterName] = useState('')
  const [error, setError] = useState('')
  const send = async (body: CommandBody) => {
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setError(result.ok ? '' : '没有完成，请稍后重试。')
  }
  // 上色放完就转到“她注意到你”：计时用 requestAnimationFrame，不用 setTimeout
  useAfter(step === 'coloring', ROOM_COLOR_MS, () => onStep('greet'))

  const her = characterName.trim() || copy.call.placeholder
  const models = snapshot.modelSettings
  const index = NUMBERED.indexOf(step)

  return (
    <section className="page page-right onboarding" aria-label="新手流程" data-step={step}>
      {index >= 0 && <p className="onboarding-progress">{copy.progress.replace('{n}', String(index + 1)).replace('{total}', String(NUMBERED.length))}</p>}
      <div className="onboarding-body" key={step}>
        {step === 'cover' && (
          <>
            <h2 className="onboarding-title">{copy.cover.title}</h2>
            <p className="onboarding-lead">{copy.cover.lead}</p>
            <div className="onboarding-actions">
              <button type="button" className="btn btn-primary" onClick={() => onStep('name')}>{copy.cover.open}</button>
              <button type="button" className="btn btn-ghost" title={copy.cover.restoreHint} onClick={() => { void send({ type: 'backup.import' }) }}>{copy.cover.restore}</button>
            </div>
            <p className="onboarding-hint">{copy.cover.restoreHint}</p>
            <RestoreConsent snapshot={snapshot} send={send} />
          </>
        )}

        {step === 'name' && (
          <form onSubmit={(event) => { event.preventDefault(); if (userName.trim()) onStep('model') }}>
            <h2 className="onboarding-title">{copy.name.title}</h2>
            <p className="onboarding-lead">{copy.name.lead}</p>
            <input className="onboarding-input" autoFocus maxLength={20} value={userName} placeholder={copy.name.placeholder}
              aria-label={copy.name.placeholder} onChange={(event) => setUserName(event.target.value)} />
            <div className="onboarding-actions"><button type="submit" className="btn btn-primary" disabled={!userName.trim()}>{copy.name.next}</button></div>
          </form>
        )}

        {step === 'model' && (
          <>
            <h2 className="onboarding-title">{copy.model.title}</h2>
            <p className="onboarding-lead">{copy.model.lead}</p>
            {models && models.configuredSlots.length > 0 && <p className="onboarding-note">{copy.model.configured.replace('{slots}', models.configuredSlots.join('、'))}</p>}
            {models?.restartRequired && <p className="onboarding-note">{copy.model.restart}</p>}
            <div className="onboarding-actions">
              <button type="button" className="btn btn-ghost" disabled={!models || models.status === 'selecting'} onClick={() => { void send({ type: 'models.configure' }) }}>{copy.model.choose}</button>
              <button type="button" className="btn btn-primary" disabled={!models?.configuredSlots.length} onClick={() => onStep('call')}>{copy.model.next}</button>
            </div>
            <button type="button" className="link-button" onClick={() => onStep('call')}>{copy.model.skip}</button>
          </>
        )}

        {step === 'call' && (
          <form onSubmit={(event) => { event.preventDefault(); onStep('persona') }}>
            <h2 className="onboarding-title">{copy.call.title}</h2>
            <p className="onboarding-lead">{copy.call.lead}</p>
            <input className="onboarding-input" autoFocus maxLength={12} value={characterName} placeholder={copy.call.placeholder}
              aria-label="她的称呼" onChange={(event) => setCharacterName(event.target.value)} />
            <div className="onboarding-actions"><button type="submit" className="btn btn-primary">{copy.call.next}</button></div>
          </form>
        )}

        {step === 'persona' && (
          <>
            <h2 className="onboarding-title">{copy.persona.title}</h2>
            <ul className="onboarding-persona">{copy.persona.lines.map((line) => <li key={line}>{line}</li>)}</ul>
            <div className="onboarding-actions"><button type="button" className="btn btn-primary" onClick={() => onStep('alive')}>{copy.persona.next}</button></div>
          </>
        )}

        {step === 'alive' && (
          <>
            <h2 className="onboarding-title">{copy.alive.title}</h2>
            <p className="onboarding-lead">{copy.alive.lead}</p>
            <div className="onboarding-actions"><button type="button" className="btn btn-primary" onClick={() => onStep('coloring')}>{copy.alive.next}</button></div>
          </>
        )}

        {step === 'coloring' && (
          <>
            <h2 className="onboarding-title">{copy.coloring.title}</h2>
            <p className="onboarding-lead">{copy.coloring.lead}</p>
          </>
        )}

        {step === 'greet' && (
          <>
            <h2 className="onboarding-title">{copy.greet.title}</h2>
            <p className="onboarding-her"><span className="msg-who" aria-hidden />{copy.greet.line.replace('{userName}', userName.trim()).replace('{characterName}', her)}</p>
            <div className="onboarding-actions">
              <button type="button" className="btn btn-primary" onClick={() => onDone({ userName: userName.trim(), characterName: her })}>{copy.greet.next}</button>
            </div>
          </>
        )}
        {error && <p role="alert" className="onboarding-note">{error}</p>}
      </div>
    </section>
  )
}

/** 导入的存档经主进程校验后，在书里写清楚是哪本、有多少东西，再由你确认；确认后应用会重启 */
function RestoreConsent({ snapshot, send }: { snapshot: AppSnapshot; send: (body: CommandBody) => Promise<void> }) {
  const backup = snapshot.backup
  if (!backup) return null
  if (backup.status === 'validating') return <p className="onboarding-note" role="status">{copy.restore.validating}</p>
  if (backup.status === 'restoring') return <p className="onboarding-note" role="status">{copy.restore.restoring}</p>
  if (backup.status !== 'awaiting-confirmation' || !backup.incoming || !backup.restoreId) return null
  const incoming = backup.incoming
  const restoreId = backup.restoreId
  return (
    <div className="onboarding-consent">
      <p className="onboarding-note">{copy.restore.summary
        .replace('{pages}', String(incoming.pageCount)).replace('{messages}', String(incoming.messageCount))
        .replace('{memories}', String(incoming.memoryCount)).replace('{deliveries}', String(incoming.deliveryCount))}</p>
      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary" onClick={() => { void send({ type: 'backup.restore', restoreId }) }}>{copy.restore.confirm}</button>
        <button type="button" className="btn btn-ghost" onClick={() => { void send({ type: 'backup.cancel' }) }}>{copy.restore.cancel}</button>
      </div>
    </div>
  )
}

/** active 变成 true 之后过 ms 毫秒调一次 fn；中途变回 false 就取消 */
function useAfter(active: boolean, ms: number, fn: () => void) {
  const latest = useRef(fn)
  useEffect(() => { latest.current = fn })
  useEffect(() => {
    if (!active) return
    const started = performance.now()
    let frame = requestAnimationFrame(function tick() {
      if (performance.now() - started >= ms) latest.current()
      else frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [active, ms])
}
