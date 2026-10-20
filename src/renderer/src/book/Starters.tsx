import { useEffect, useRef, useState } from 'react'
import type { AppSnapshot } from '../../../shared'
import copy from '../voice/book.zh.json'
import { fill } from './life/text'

const STARTERS_KEY = 'lca:starters-done'
const FAMILIAR_KEY = 'lca:familiar-projects'
const read = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const write = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* 存不下就下次再提示一次，不影响对话 */ } }
const familiar = (): string[] => { try { const value: unknown = JSON.parse(read(FAMILIAR_KEY) ?? '[]'); return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [] } catch { return [] } }

type Starter = { label: string; text?: string; action?: 'project' }

/**
 * 第一次和她干活的几个开头（2026-10-20 用户：受众可能没用过 Agent，像第一次用 Claude Code 时先定工作目录、跑一次 /init）。
 * 不讲课：每个开头点一下就是一句真的请求；第一次换到自己的项目时，给一句“先熟悉一下这个项目”，只读不改。
 * 用过一次（你发了第一句话、点了开头或“不用了”）就收起；重新走一遍新手指引后再出现。只记在这台电脑上。需要 DSH 的工作环境（snapshot.work）。
 */
export function Starters({ snapshot, say, pickProject }: { snapshot: AppSnapshot; say: (text: string) => void; pickProject: () => void }) {
  const words = copy.starters
  const work = snapshot.work
  const busy = !!snapshot.task && ['queued', 'running', 'waiting-user', 'cancelling'].includes(snapshot.task.status)
  // 按这一次走完新手指引的时刻算：之后你还没开过口、也没用过这些开头
  const finished = String(snapshot.onboarding?.completedAtMs ?? 0)
  const since = snapshot.onboarding?.completedAtMs ?? 0
  const spoke = snapshot.messages.some((message) => message.role === 'user' && !message.kind && message.createdAtMs >= since)
  const [usedAt, setUsedAt] = useState(() => read(STARTERS_KEY))
  const starters = usedAt !== finished
  const [known, setKnown] = useState(familiar)
  const current = work?.current && !work.current.desk ? work.current : null
  const offerFamiliar = !!current && !known.includes(current.path)
  const offerStarters = starters && !spoke && !offerFamiliar
  const doneStarters = () => { write(STARTERS_KEY, finished); setUsedAt(finished) }
  const doneFamiliar = (path: string) => { const next = [...new Set([...familiar(), path])].slice(-32); write(FAMILIAR_KEY, JSON.stringify(next)); setKnown(next) }
  // 你自己开口了：这些开头就用不上了
  const shown = useRef({ starters: offerStarters, familiar: offerFamiliar ? current?.path ?? null : null })
  const userLines = snapshot.messages.filter((message) => message.role === 'user').length
  const lines = useRef(userLines)
  useEffect(() => {
    if (userLines > lines.current) {
      if (shown.current.starters) doneStarters()
      if (shown.current.familiar) doneFamiliar(shown.current.familiar)
    }
    lines.current = userLines
    shown.current = { starters: offerStarters, familiar: offerFamiliar ? current?.path ?? null : null }
  })
  if (!work || busy || (!offerStarters && !offerFamiliar)) return null
  if (offerFamiliar && current) return (
    <div className="starters" role="group" aria-label={words.label}>
      <button type="button" className="choice-chip" title={words.familiarText} onClick={() => { doneFamiliar(current.path); doneStarters(); say(words.familiarText) }}>{fill(words.familiar, { name: current.name })}</button>
      <button type="button" className="link-button" onClick={() => doneFamiliar(current.path)}>{words.dismiss}</button>
    </div>
  )
  return (
    <div className="starters" role="group" aria-label={words.label}>
      <span className="starters-label">{words.label}</span>
      {(words.items as Starter[]).map((item) => (
        <button key={item.label} type="button" className="choice-chip" title={item.text ?? words.projectHint}
          onClick={() => { if (item.action === 'project') pickProject(); else if (item.text) { doneStarters(); say(item.text) } }}>{item.label}</button>
      ))}
      <button type="button" className="link-button" onClick={doneStarters}>{words.dismiss}</button>
    </div>
  )
}
