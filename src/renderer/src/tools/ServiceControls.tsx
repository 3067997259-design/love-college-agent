import { useState } from 'react'
import type { AppBridge, AppSnapshot, ModelSettingsView } from '../../../shared'
import { sendCommand } from '../book/command'
import { SettingsIssue } from './SettingsIssue'
import copy from '../voice/providers.zh.json'

/** 语音、礼物生成和邮箱的图形化连接；和模型槽位一样，已保存的值不回显。 */
export function ServiceControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const models = snapshot.modelSettings
  if (!models) return null
  return <section className="provider-services" aria-label={copy.services.title}>
    <h3>{copy.services.title}</h3>
    <p className="provider-hint">{copy.services.lead}</p>
    <div className="provider-list">
      <TtsCard bridge={bridge} epoch={snapshot.epoch} status={models.status} configured={!!models.services?.tts} />
      <RodinCard bridge={bridge} epoch={snapshot.epoch} status={models.status} configured={!!models.services?.rodin} />
      <MailCard bridge={bridge} epoch={snapshot.epoch} status={models.status} configured={!!models.services?.mail} />
    </div>
  </section>
}

function TtsCard({ bridge, epoch, configured, status }: { bridge: AppBridge; epoch: string; configured: boolean; status: ModelSettingsView['status'] }) {
  const [base, setBase] = useState(''); const [model, setModel] = useState(''); const [voice, setVoice] = useState(''); const [key, setKey] = useState('')
  const [notice, setNotice] = useState(''); const [error, setError] = useState('')
  const canSave = configured ? Boolean(base.trim() || model.trim() || voice.trim() || key.trim()) : Boolean(base.trim() && model.trim() && voice.trim() && key.trim())
  const save = async () => {
    setError(''); setNotice('')
    const result = await sendCommand(bridge, epoch, { type: 'models.service.save', service: 'tts', baseUrl: base, model, voice, ...(key.trim() ? { apiKey: key.trim() } : {}) })
    if (!result.ok) { setError(result.code); return }
    setKey(''); setNotice(copy.services.saved)
  }
  return <section className="provider-card" data-service="tts">
    <header className="provider-head"><strong>{copy.services.tts}</strong><span className="provider-state">{configured ? copy.services.configured : copy.services.notConfigured}</span></header>
    <label className="provider-field">{copy.services.ttsBase}<input value={base} placeholder={configured ? copy.keep : copy.baseHint} autoComplete="off" spellCheck={false} onChange={(event) => setBase(event.target.value)} /></label>
    <label className="provider-field">{copy.services.ttsModel}<input value={model} placeholder={configured ? copy.keep : copy.modelHint} autoComplete="off" spellCheck={false} onChange={(event) => setModel(event.target.value)} /></label>
    <label className="provider-field">{copy.services.voice}<input value={voice} placeholder={configured ? copy.keep : '例如 alloy'} autoComplete="off" spellCheck={false} onChange={(event) => setVoice(event.target.value)} /></label>
    <label className="provider-field">{copy.services.ttsKey}<input type="password" value={key} placeholder={configured ? copy.keySaved : copy.keyHint} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} /></label>
    <div className="provider-actions"><button type="button" className="btn btn-primary btn-small" disabled={!canSave} onClick={() => void save()}>{copy.services.ttsSave}</button></div>
    {notice && status === 'saved' && <p className="provider-note" role="status">{notice}</p>}{error && <SettingsIssue code={error} />}
  </section>
}

function RodinCard({ bridge, epoch, configured, status }: { bridge: AppBridge; epoch: string; configured: boolean; status: ModelSettingsView['status'] }) {
  const [base, setBase] = useState(''); const [key, setKey] = useState('')
  const [notice, setNotice] = useState(''); const [error, setError] = useState('')
  const canSave = configured ? Boolean(base.trim() || key.trim()) : Boolean(base.trim() && key.trim())
  const save = async () => {
    setError(''); setNotice('')
    const result = await sendCommand(bridge, epoch, { type: 'models.service.save', service: 'rodin', baseUrl: base, model: '', ...(key.trim() ? { apiKey: key.trim() } : {}) })
    if (!result.ok) { setError(result.code); return }
    setKey(''); setNotice(copy.services.saved)
  }
  return <section className="provider-card" data-service="rodin">
    <header className="provider-head"><strong>{copy.services.rodin}</strong><span className="provider-state">{configured ? copy.services.configured : copy.services.notConfigured}</span></header>
    <label className="provider-field">{copy.services.rodinBase}<input value={base} placeholder={configured ? copy.keep : copy.baseHint} autoComplete="off" spellCheck={false} onChange={(event) => setBase(event.target.value)} /></label>
    <label className="provider-field">{copy.services.rodinKey}<input type="password" value={key} placeholder={configured ? copy.keySaved : copy.keyHint} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} /></label>
    <div className="provider-actions"><button type="button" className="btn btn-primary btn-small" disabled={!canSave} onClick={() => void save()}>{copy.services.rodinSave}</button></div>
    {notice && status === 'saved' && <p className="provider-note" role="status">{notice}</p>}{error && <SettingsIssue code={error} />}
  </section>
}

function MailCard({ bridge, epoch, configured, status }: { bridge: AppBridge; epoch: string; configured: boolean; status: ModelSettingsView['status'] }) {
  const [host, setHost] = useState(''); const [port, setPort] = useState(''); const [user, setUser] = useState(''); const [code, setCode] = useState('')
  const [notice, setNotice] = useState(''); const [error, setError] = useState('')
  const canSave = configured ? Boolean(host.trim() || port.trim() || user.trim() || code.trim()) : Boolean(host.trim() && user.trim() && code.trim())
  const save = async () => {
    setError(''); setNotice('')
    const result = await sendCommand(bridge, epoch, { type: 'mail.configure', host, ...(port.trim() ? { port: Number(port) } : {}), user, ...(code.trim() ? { authCode: code.trim() } : {}) })
    if (!result.ok) { setError(result.code); return }
    setCode(''); setNotice(copy.services.saved)
  }
  return <section className="provider-card" data-service="mail">
    <header className="provider-head"><strong>{copy.services.mail}</strong><span className="provider-state">{configured ? copy.services.configured : copy.services.notConfigured}</span></header>
    <label className="provider-field">{copy.services.mailHost}<input value={host} placeholder={configured ? copy.keep : 'imap.example.com'} autoComplete="off" spellCheck={false} onChange={(event) => setHost(event.target.value)} /></label>
    <label className="provider-field">{copy.services.mailPort}<input type="number" min={1} max={65535} placeholder={configured ? copy.keep : '993'} value={port} onChange={(event) => setPort(event.target.value)} /></label>
    <label className="provider-field">{copy.services.mailUser}<input value={user} placeholder={configured ? copy.keep : 'you@example.edu'} autoComplete="off" spellCheck={false} onChange={(event) => setUser(event.target.value)} /></label>
    <label className="provider-field">{copy.services.mailCode}<input type="password" value={code} placeholder={configured ? copy.keySaved : copy.keyHint} autoComplete="off" spellCheck={false} onChange={(event) => setCode(event.target.value)} /></label>
    <div className="provider-actions"><button type="button" className="btn btn-primary btn-small" disabled={!canSave} onClick={() => void save()}>{copy.services.mailSave}</button></div>
    {notice && status === 'saved' && <p className="provider-note" role="status">{notice}</p>}{error && <SettingsIssue code={error} />}
  </section>
}
