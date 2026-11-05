import { useState, type ReactNode } from 'react'
import type { AppBridge, AppSnapshot, AppCommand } from '../../../shared'
import words from '../voice/settings.zh.json'
import { ModelControls } from './ModelControls'
import { MailboxControls } from './MailboxControls'
import { DocumentControls } from './DocumentControls'
import { BackupControls } from './BackupControls'
import { CharacterControls } from './CharacterControls'
import { MemoryControls } from './MemoryControls'
import { ProfileControls } from './ProfileControls'

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

/** 不用展开的一行：标题、一句说明、右边一个按钮。和折叠组并排时看起来是同一种东西。 */
function Row({ action, title, note, children }: { action: string; title: string; note: string; children: ReactNode }) {
  return <div className="settings-row" data-action={action}><div><strong>{title}</strong><p>{note}</p></div>{children}</div>
}

function SettingsNav() {
  return <nav className="settings-nav" aria-label={words.sectionsNav}>
    {SECTIONS.map((id) => <button key={id} type="button" onClick={() => document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{words.sections[id].title}</button>)}
  </nav>
}

export function UserSettings({ bridge, snapshot, onClose, onOpenPlugins }: { bridge: AppBridge; snapshot: AppSnapshot; onClose?(): void; onOpenPlugins?: () => void }) {
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
        {onClose && <button type="button" onClick={onClose}>{words.close}</button>}
      </span>
    </header>
    {booth && <p className="settings-source">{words.source.booth}</p>}{synthetic && <p className="settings-source" data-synthetic-source>{words.source.fake}</p>}
    <SettingsNav />
    <Section id="model"><ModelControls {...props} /><VoiceControls {...props} /></Section>
    <Section id="connections">
      {onOpenPlugins && <Row action="settings.plugins" title={words.plugins.title} note={words.plugins.note}><button type="button" onClick={onOpenPlugins}>{words.openPlugins}</button></Row>}
      <Group name={words.groups.campus}><MailboxControls {...props} /><DocumentControls {...props} /></Group>
      {snapshot.notifications && <Group name={words.groups.notifications}><NotificationControls {...props} /></Group>}
      {booth && <Group name="Minecraft"><MinecraftControls {...props} /></Group>}
    </Section>
    <Section id="rhythm">
      {/* 旧心流是 1.1 已退役的只读记录：LegacyFlowRecords 自己是一个淡一档的折叠，没有记录时不出现 */}
      <Group name={words.groups.life}><LifeControls {...props} /><DiaryControls {...props} /><LegacyFlowRecords bridge={bridge} snapshot={snapshot} /></Group>
    </Section>
    <Section id="book">
      {/* 展位是公共的机器，不收来访者的个人介绍 */}
      {!booth && <Group name={words.groups.profile}><ProfileControls {...props} /></Group>}
      <Group name={words.groups.memory}><MemoryControls {...props} /></Group>
      <Group name={words.groups.book}><BackupControls {...props} /><CharacterControls {...props} /></Group>
      {/* 重新走一遍新手指引只把“看过引导”改回没看过（onboarding.reset），不动任何资料；是一行，不藏进折叠组 */}
      {!booth && <Row action="onboarding.reset" title={words.onboarding.title} note={words.resetHint}><button type="button" onClick={() => void send({ type: 'onboarding.reset' })}>{words.reset}</button></Row>}
    </Section>
    <Section id="usage">
      <Group name={words.groups.resources} open={booth}><ResourceControls {...props} /></Group>
      <Group name={words.groups.experimental}><OpticalControls {...props} /></Group>
    </Section>
    <Section id="developer">
      <Group name={words.groups.advanced} open={booth}><p className="settings-note">{words.developerHint}</p><label><input type="checkbox" checked={runtime.developer.requestedEnabled} disabled={booth} onChange={(event) => void send({ type: 'developer.set', enabled: event.target.checked })} />{words.developerSwitch}</label>{runtime.developer.restartRequired && <button onClick={() => void send({ type: 'app.restart' })}>{words.restart}</button>}</Group>
    </Section>
    <SettingsIssue code={error} />
  </>
}
