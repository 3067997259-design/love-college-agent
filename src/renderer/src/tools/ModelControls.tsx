import { useState } from 'react'
import type { AppBridge, AppSnapshot, ModelProviderSlot, ModelSettingsView } from '../../../shared'
import { sendCommand, type CommandBody } from '../book/command'
import { SettingsIssue } from './SettingsIssue'
import { ServiceControls } from './ServiceControls'
import words from '../voice/settings.zh.json'
import copy from '../voice/providers.zh.json'
import './providers.css'

const SLOTS: readonly ModelProviderSlot[] = ['chat', 'background', 'privacy']

export function ModelControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState('')
  const models = snapshot.modelSettings
  if (!models) return null
  const developer = snapshot.runtime?.developer.mode === 'developer'
  const importConfig = async () => {
    setError('')
    const result = await sendCommand(bridge, snapshot.epoch, { type: 'models.configure' })
    if (!result.ok) setError(result.code)
  }
  const restart = async () => {
    const result = await sendCommand(bridge, snapshot.epoch, { type: 'app.restart' })
    if (!result.ok) setError(result.code)
  }
  return <div aria-label="模型槽位控制" className="provider-controls">
    <h3>{copy.title}</h3>
    <p>{copy.lead}</p>
    <p className="provider-summary">{models.configuredSlots.length ? `${words.configured}${models.configuredSlots.map((slot) => (copy.slots as Record<string, string>)[slot] ?? (words.slots as Record<string, string>)[slot] ?? slot).join('、')}。` : copy.noneConfigured}</p>
    {developer ? <p className="provider-note">{copy.developer}</p> : <>
      <div className="provider-list">
        {SLOTS.map((slot) => <ProviderCard key={slot} slot={slot} bridge={bridge} epoch={snapshot.epoch}
          configured={models.configuredSlots.includes(slot)}
          probe={models.probe?.slot === slot ? models.probe : undefined} />)}
      </div>
      <ServiceControls bridge={bridge} snapshot={snapshot} />
      <div className="provider-import">
        <span>{copy.importHint}</span>
        <button type="button" className="link-button" disabled={models.status === 'selecting'} onClick={() => void importConfig()}>{copy.import}</button>
      </div>
    </>}
    {models.restartRequired && <div className="provider-restart" role="status">
      <p>{copy.restart}</p>
      <button type="button" className="btn btn-primary btn-small" onClick={() => void restart()}>{copy.restartAction}</button>
    </div>}
    <SettingsIssue code={error || models.error?.code} />
  </div>
}

function ProviderCard({ slot, bridge, epoch, configured, probe }: {
  slot: ModelProviderSlot
  bridge: AppBridge
  epoch: string
  configured: boolean
  probe: ModelSettingsView['probe']
}) {
  const presets = copy.presets as Record<string, { label: string; baseUrl: string; model: string }>
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const testing = probe?.status === 'testing'
  const dirty = Boolean(baseUrl.trim() || model.trim() || apiKey.trim())
  const canSave = !testing && (configured ? dirty : Boolean(baseUrl.trim() && model.trim() && apiKey.trim()))

  const save = async () => {
    setError(''); setNotice('')
    const body: CommandBody = { type: 'models.provider.save', slot, baseUrl, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }
    const result = await sendCommand(bridge, epoch, body)
    if (!result.ok) { setError(result.code); return }
    setBaseUrl(''); setModel(''); setApiKey(''); setNotice(copy.saved)
  }
  const test = async () => {
    setError('')
    const result = await sendCommand(bridge, epoch, { type: 'models.probe', slot })
    if (!result.ok) setError(result.code)
  }
  const remove = async () => {
    setError(''); setNotice('')
    const result = await sendCommand(bridge, epoch, { type: 'models.provider.remove', slot })
    if (!result.ok) { setError(result.code); return }
    setBaseUrl(''); setModel(''); setApiKey('')
  }
  const status = testing ? copy.testing
    : dirty ? copy.edited
      : probe?.status === 'ok' ? copy.ok
        : probe?.status === 'failed' ? copy.failed
          : configured ? copy.configured : copy.notConfigured
  const label = (copy.slots as Record<string, string>)[slot] ?? slot
  return <section className="provider-card" data-slot={slot} data-probe={probe?.status ?? 'none'}>
    <header className="provider-head"><strong>{label}</strong><span className="provider-state" data-ok={probe?.status === 'ok'}>{status}</span></header>
    {slot === 'privacy' && <p className="provider-hint">{copy.privacyHint}</p>}
    <label className="provider-field">{copy.preset}
      <select aria-label={copy.preset} value="" onChange={(event) => {
        const preset = presets[event.target.value]
        if (!preset) return
        setBaseUrl(preset.baseUrl); setModel(preset.model); setApiKey(''); setError(''); setNotice(copy.presetApplied)
      }}>
        <option value="">{copy.presetCustom}</option>
        {Object.entries(presets).map(([id, preset]) => <option key={id} value={id}>{preset.label}</option>)}
      </select>
    </label>
    <label className="provider-field">{copy.baseUrl}
      <input value={baseUrl} placeholder={configured ? copy.keep : copy.baseHint} autoComplete="off" spellCheck={false} onChange={(event) => setBaseUrl(event.target.value)} />
    </label>
    <label className="provider-field">{copy.model}
      <input value={model} placeholder={configured ? copy.keep : copy.modelHint} autoComplete="off" spellCheck={false} onChange={(event) => setModel(event.target.value)} />
    </label>
    <label className="provider-field">{copy.apiKey}
      <input type="password" value={apiKey} placeholder={configured ? copy.keySaved : copy.keyHint} autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} />
    </label>
    <div className="provider-actions">
      <button type="button" className="btn btn-primary btn-small" disabled={!canSave} onClick={() => void save()}>{copy.save}</button>
      <button type="button" className="btn btn-ghost btn-small" disabled={!configured || testing || dirty} onClick={() => void test()}>{testing ? copy.testing : copy.test}</button>
      {configured && <button type="button" className="link-button" onClick={() => void remove()}>{copy.remove}</button>}
    </div>
    {dirty && configured && !testing && <p className="provider-note">{copy.saveBeforeTest}</p>}
    {notice && <p className="provider-note" role="status">{notice}</p>}
    {probe?.status === 'failed' && <div className="provider-probe-failed"><p>{copy.probeFailed}</p><SettingsIssue code={probe.code} /></div>}
    {error && <SettingsIssue code={error} />}
  </section>
}
