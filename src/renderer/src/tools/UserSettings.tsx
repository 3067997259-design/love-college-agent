import { useState, type ReactNode } from 'react'
import type { AppBridge, AppSnapshot, AppCommand } from '../../../shared'
import words from '../voice/settings.zh.json'
import { ModelControls } from './ModelControls'
import { MailboxControls } from './MailboxControls'
import { DocumentControls } from './DocumentControls'
import { BackupControls } from './BackupControls'
import { CharacterControls } from './CharacterControls'

import { NotificationControls } from './NotificationControls'
import { VoiceControls } from './VoiceControls'
import { ResourceControls } from './ResourceControls'
import { LegacyFlowRecords } from './LegacyFlowRecords'
import { LifeControls } from './LifeControls'
import { DiaryControls } from './DiaryControls'
import { OpticalControls } from './OpticalControls'
import { MinecraftControls } from './MinecraftControls'
import { SettingsIssue } from './SettingsIssue'
import type { CommandBody } from '../book/command'


type SectionId = 'model' | 'connections' | 'rhythm' | 'book' | 'usage' | 'developer'
const SECTIONS: readonly SectionId[] = ['model', 'connections', 'rhythm', 'book', 'usage', 'developer']

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const copy = words.sections[id]
  return <section className="settings-section" id={`settings-${id}`} data-settings-section={id} aria-labelledby={`settings-${id}-title`}>
    <header className="settings-section-head">
      <h2 id={`settings-${id}-title`}>{copy.title}</h2>
      <p>{copy.note}</p>
    </header>
    {children}
  </section>
}

function Group({ name, open = false, children }: { name: string; open?: boolean; children: ReactNode }) {
  return <details className="settings-group" open={open}><summary>{name}</summary>{children}</details>
}

function SettingsNav() {
  return <nav className="settings-nav" aria-label={words.sectionsNav}>
    {SECTIONS.map((id) => <button key={id} type="button" onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{words.sections[id].title}</button>)}
  </nav>
}

export function UserSettings({ bridge, snapshot, onClose, onOpenPlugins }: { bridge: AppBridge; snapshot: AppSnapshot; onClose(): void; onOpenPlugins?: () => void }) {
  const [error, setError] = useState('')
  const runtime = snapshot.runtime!; const booth = runtime.developer.mode === 'booth'
  const props = { bridge, snapshot }
  const send = async (body: CommandBody) => { try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') } catch { setError('connection-failed') } }
  const synthetic = snapshot.capabilities.some((capability) => capability.source === 'fake') || snapshot.voice?.source === 'fake' || snapshot.mailbox?.source === 'fake'
  return <>
    {/* 标题栏固定在面板顶上：内容往下滚，关闭和收起一直够得着 */}
    <header className="settings-head">
      <span className="settings-title">{words.title}</span>
      <span className="settings-head-actions">
        {snapshot.windows && <button type="button" onClick={() => void send({ type: 'window.mini' })}>{words.mini}</button>}
        <button type="button" onClick={onClose}>{words.close}</button>
      </span>
    </header>
    {booth && <p className="settings-source">{words.source.booth}</p>}{synthetic && <p className="settings-source" data-synthetic-source>{words.source.fake}</p>}
    <SettingsNav />
    <Section id="model"><ModelControls {...props} /><VoiceControls {...props} /></Section>
    <Section id="connections">
      {onOpenPlugins && <div className="settings-callout" data-action="settings.plugins"><p>{words.pluginsHint}</p><button type="button" onClick={onOpenPlugins}>{words.openPlugins}</button></div>}
      <Group name={words.groups.campus}><MailboxControls {...props} /><DocumentControls {...props} /></Group>
      <NotificationControls {...props} />
      {booth && <Group name="Minecraft"><MinecraftControls {...props} /></Group>}
    </Section>
    <Section id="rhythm">
      <Group name={words.groups.life}><LifeControls {...props} /><DiaryControls {...props} /><LegacyFlowRecords bridge={bridge} snapshot={snapshot} /></Group>
    </Section>
    <Section id="book">
      <Group name={words.groups.book}><BackupControls {...props} /><CharacterControls {...props} /><button disabled={booth} onClick={() => void send({ type: 'onboarding.reset' })}>{words.reset}</button></Group>
    </Section>
    <Section id="usage">
      <Group name="运行资源" open={booth}><ResourceControls {...props} /></Group>
      <Group name={words.groups.experimental}><OpticalControls {...props} /></Group>
    </Section>
    <Section id="developer">
      <Group name={words.groups.advanced} open={booth}><p>{words.developerHint}</p><label><input type="checkbox" checked={runtime.developer.requestedEnabled} disabled={booth} onChange={(event) => void send({ type: 'developer.set', enabled: event.target.checked })} />{words.developerSwitch}</label>{runtime.developer.restartRequired && <button onClick={() => void send({ type: 'app.restart' })}>{words.restart}</button>}</Group>
    </Section>
    <SettingsIssue code={error} />
  </>
}
