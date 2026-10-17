import { useState, type ReactNode } from 'react'
import type { AppBridge, AppSnapshot, AppCommand } from '../../../shared'
import words from '../voice/settings.zh.json'
import { ModelControls } from './ModelControls'
import { MailboxControls } from './MailboxControls'
import { DocumentControls } from './DocumentControls'
import { BackupControls } from './BackupControls'
import { CharacterControls } from './CharacterControls'
import { McpControls } from './McpControls'
import { NotificationControls } from './NotificationControls'
import { VoiceControls } from './VoiceControls'
import { ResourceControls } from './ResourceControls'
import { HeartFlowControls } from './HeartFlowControls'
import { LifeControls } from './LifeControls'
import { DiaryControls } from './DiaryControls'
import { MemoryControls } from './MemoryControls'
import { OpticalControls } from './OpticalControls'
import { MinecraftControls } from './MinecraftControls'
import { SettingsIssue, settingStatus } from './SettingsIssue'
import type { CommandBody } from '../book/command'
import { PomodoroSettings } from './PomodoroSettings'

function Group({ name, open = false, children }: { name: string; open?: boolean; children: ReactNode }) {
  return <details className="settings-group" open={open}><summary>{name}</summary>{children}</details>
}
export function UserSettings({ bridge, snapshot, onClose }: { bridge: AppBridge; snapshot: AppSnapshot; onClose(): void }) {
  const [error, setError] = useState(''); const [approving, setApproving] = useState<string | null>(null)
  const runtime = snapshot.runtime!; const booth = runtime.developer.mode === 'booth'
  const props = { bridge, snapshot }
  const send = async (body: CommandBody) => { try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') } catch { setError('connection-failed') } }
  const synthetic = snapshot.capabilities.some((capability) => capability.source === 'fake') || snapshot.voice?.source === 'fake' || snapshot.mailbox?.source === 'fake'
  return <>
    <button type="button" onClick={onClose}>{words.close}</button>
    {snapshot.windows && <button type="button" onClick={() => void send({ type: 'window.mini' })}>{words.mini}</button>}
    {booth && <p>{words.source.booth}</p>}{synthetic && <p data-synthetic-source>{words.source.fake}</p>}
    <ModelControls {...props} />
    <Group name={words.groups.campus}><MailboxControls {...props} /><DocumentControls {...props} /></Group>
    <Group name={words.groups.pomodoro}><PomodoroSettings {...props} /></Group>
    <Group name={words.groups.book}><BackupControls {...props} /><CharacterControls {...props} /><button disabled={booth} onClick={() => void send({ type: 'onboarding.reset' })}>{words.reset}</button></Group>
    <Group name={words.groups.connections}><McpControls {...props} /><NotificationControls {...props} /></Group>
    <Group name={words.groups.voice} open={booth}><VoiceControls {...props} /><ResourceControls {...props} /></Group>
    <Group name={words.groups.life}><LifeControls {...props} /><DiaryControls {...props} />{!snapshot.heartFlow?.activeId && <HeartFlowControls {...props} />}</Group>
    {booth && <Group name="Minecraft"><MinecraftControls {...props} /></Group>}
    <Group name={words.groups.memory}><MemoryControls {...props} /></Group>
    <Group name={words.groups.experimental}><OpticalControls {...props} /></Group>
    <Group name={words.groups.extensions}>{runtime.plugins.map((plugin) => <section className="tools-plugin" key={plugin.id}>
      <strong>{plugin.name}</strong><p>{settingStatus(plugin.status)}</p>
      {plugin.status === 'enabled' ? <button onClick={() => void send({ type: 'plugin.disable', pluginId: plugin.id })}>{words.plugin.disable}</button> : <button disabled={['incompatible', 'failed'].includes(plugin.status)} onClick={() => plugin.source === 'folder' ? setApproving(plugin.id) : void send({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint })}>{words.plugin.enable}</button>}
      <label>{words.plugin.privacy}<select value={plugin.privacy} disabled={plugin.privacyLocked} onChange={(event) => void send({ type: 'plugin.privacy.set', pluginId: plugin.id, privacy: event.target.value as 'none' | 'optional' | 'always' })}><option value="none">{words.plugin.off}</option><option value="optional">{words.plugin.optional}</option><option value="always">{words.plugin.always}</option></select></label>
      {approving === plugin.id && <div role="alertdialog" aria-label={words.plugin.approval}><p>{words.plugin.hint}</p><p>{words.plugin.permissions}{plugin.permissions.join('、') || words.none}</p><code>{plugin.fingerprint}</code><button onClick={() => { setApproving(null); void send({ type: 'plugin.enable', pluginId: plugin.id, fingerprint: plugin.fingerprint }) }}>{words.plugin.confirm}</button><button onClick={() => setApproving(null)}>{words.plugin.cancel}</button></div>}
    </section>)}</Group>
    <Group name={words.groups.advanced}><p>{words.developerHint}</p><label><input type="checkbox" checked={runtime.developer.requestedEnabled} disabled={booth} onChange={(event) => void send({ type: 'developer.set', enabled: event.target.checked })} />{words.developerSwitch}</label>{runtime.developer.restartRequired && <button onClick={() => void send({ type: 'app.restart' })}>{words.restart}</button>}</Group>
    <SettingsIssue code={error} />
  </>
}
