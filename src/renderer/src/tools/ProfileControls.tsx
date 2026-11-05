import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand } from '../book/command'
import words from '../voice/settings.zh.json'

/** Same tidying main applies before saving, so "unchanged" means the same thing on both sides. */
const tidy = (text: string) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

/**
 * 称呼与关于你（设置 · 角色与书本）：新手流程写下的名字、她的称呼，加上你愿意让她知道的事。
 * 都存在本机档案里，由主进程校验和规整。“关于你”在她的上下文里单独一层，不进角色卡，
 * 也不会被当成共同经历记进记忆；私人存档会带上它，角色包不会。
 */
export function ProfileControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const copy = words.profile
  const profile = snapshot.onboarding
  const [userName, setUserName] = useState(profile?.userName ?? '')
  const [characterName, setCharacterName] = useState(profile?.characterName ?? '')
  const [aboutUser, setAboutUser] = useState(profile?.aboutUser ?? '')
  const [result, setResult] = useState<'saved' | 'failed' | null>(null)
  if (!profile) return null
  const dirty = userName.trim() !== (profile.userName ?? '') || (characterName.trim() || '桃子') !== profile.characterName
    || tidy(aboutUser) !== (profile.aboutUser ?? '')
  const change = (set: (value: string) => void) => (event: { target: { value: string } }) => { set(event.target.value); setResult(null) }
  const save = async () => {
    const sent = await sendCommand(bridge, snapshot.epoch, { type: 'onboarding.profile', userName, characterName, aboutUser })
    setResult(sent.ok ? 'saved' : 'failed')
  }
  return <section aria-label={copy.title} className="profile-controls">
    <label>{copy.userName}<input maxLength={20} value={userName} onChange={change(setUserName)} /></label>
    <label>{copy.characterName}<input maxLength={12} value={characterName} placeholder="桃子" onChange={change(setCharacterName)} /></label>
    <label>{copy.about}<textarea rows={5} maxLength={500} value={aboutUser} placeholder={copy.aboutPlaceholder} onChange={change(setAboutUser)} /></label>
    <p>{copy.note}</p>
    <button type="button" disabled={!dirty || !userName.trim()} onClick={() => void save()}>{copy.save}</button>
    {result === 'saved' && !dirty && <span role="status"> {copy.saved}</span>}
    {result === 'failed' && <p role="alert">{copy.failed}</p>}
  </section>
}
