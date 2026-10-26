import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppBridge, ConnectionProbeDetail, ConnectionTestRead, ModelProviderSlot, ModelSettingsView } from '../../../shared'
import { SettingsIssue } from './SettingsIssue'
import { formatDateTime } from '../book/format'
import copy from '../voice/providers.zh.json'

type Probe = NonNullable<ModelSettingsView['probe']>
type Issue = NonNullable<ConnectionProbeDetail['issue']>
const words = copy.probe
const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
const seconds = (ms: number) => (ms / 1000).toFixed(1)

/** Warning triangle: a shape plus a light/dark contrast, so it reads without relying on hue. */
export function WarningTriangle() {
  return <svg className="issue-triangle" viewBox="0 0 20 18" aria-hidden="true" focusable="false">
    <path d="M10 1.6 18.7 16.4H1.3Z" fill="var(--notice-bg)" stroke="var(--notice-ink)" strokeWidth="1.4" strokeLinejoin="round" />
    <path d="M10 6.4v4.8" stroke="var(--notice-ink)" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="10" cy="13.7" r="1.05" fill="var(--notice-ink)" />
  </svg>
}

/** Under a model card after "Test connection": a passing test says which path it took; a failure opens its details. */
export function ProbeOutcome({ probe, slot, slotLabel, bridge }: { probe: Probe; slot: ModelProviderSlot; slotLabel: string; bridge: AppBridge }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  if (probe.status === 'testing') return null
  const detail = probe.detail
  if (probe.status === 'ok') return detail ? <p className="provider-note probe-ok" role="status">{fill(words.okVia[detail.path], { seconds: seconds(detail.durationMs) })}</p> : null
  // Failures before any request (budget, unreadable config) have no network facts; the closed code explains them.
  if (!detail?.issue) return <SettingsIssue code={probe.code} />
  const kind = words.kinds[detail.issue.kind]
  return <>
    <button ref={trigger} type="button" className="probe-issue" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <WarningTriangle />
      <span className="probe-issue-text">{kind.title}{detail.issue.httpStatus ? `（HTTP ${detail.issue.httpStatus}）` : ''}</span>
      <span className="probe-issue-more">{words.open}</span>
    </button>
    {open && <ProbeDialog detail={detail} issue={detail.issue} atMs={probe.atMs} slot={slot} slotLabel={slotLabel} bridge={bridge}
      onClose={() => { setOpen(false); trigger.current?.focus() }} />}
  </>
}

function ProbeDialog({ detail, issue, atMs, slot, slotLabel, bridge, onClose }: {
  detail: ConnectionProbeDetail; issue: Issue; atMs: number; slot: ModelProviderSlot; slotLabel: string; bridge: AppBridge; onClose(): void
}) {
  const titleId = useId()
  const box = useRef<HTMLElement>(null)
  const facts = useRef<HTMLDListElement>(null)
  const [read, setRead] = useState<ConnectionTestRead | 'loading' | 'gone'>('loading')
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  const kind = words.kinds[issue.kind]
  // The address and the provider's words are not in the snapshot: ask main for this exact test.
  useEffect(() => {
    let active = true
    if (!bridge.readConnectionTest) { setRead('gone'); return }
    bridge.readConnectionTest(slot).then((value) => { if (active) setRead(value.atMs === atMs ? value : 'gone') }, () => { if (active) setRead('gone') })
    return () => { active = false }
  }, [bridge, slot, atMs])
  // Snapshot refreshes re-render the card with a new onClose; keep focus where the user put it.
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    box.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close.current() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const known = typeof read === 'object' ? read : undefined
  const endpoint = known ? known.endpoint ?? (detail.path === 'dsh' ? words.nativeEndpoint : '') : ''
  const rows: [label: string, value: string, code?: boolean][] = [
    [words.path, words.paths[detail.path]],
    ...(detail.adapter ? [[words.adapter, detail.adapter, true]] as [string, string, boolean][] : []),
    ...(endpoint ? [[words.endpoint, endpoint, !!known?.endpoint]] as [string, string, boolean][] : []),
    ...(known ? [[words.model, known.model, true]] as [string, string, boolean][] : []),
    ...(issue.httpStatus ? [[words.status, String(issue.httpStatus)]] as [string, string][] : []),
    ...(issue.code ? [[words.code, issue.code, true]] as [string, string, boolean][] : []),
    ...(known?.message ? [[words.message, known.message, true]] as [string, string, boolean][] : []),
    ...(known?.requestId ? [[words.requestId, known.requestId, true]] as [string, string, boolean][] : []),
    [words.duration, fill(words.seconds, { seconds: seconds(detail.durationMs) })],
    [words.at, formatDateTime(atMs)],
  ]
  const copyReport = async () => {
    const report = [`LCA 连接测试 · ${slotLabel}`, `结果：${kind.title}`, ...rows.map(([label, value]) => `${label}：${value}`), ...(known?.body ? [`${words.body}：`, known.body] : [])].join('\n')
    try { await navigator.clipboard.writeText(report); setCopied('ok') }
    catch { if (facts.current) window.getSelection()?.selectAllChildren(facts.current); setCopied('failed') }
  }
  return createPortal(<div className="probe-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={box} className="probe-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} aria-busy={read === 'loading'}>
      <h3 id={titleId}><WarningTriangle />{kind.title}</h3>
      <p className="probe-dialog-lead">{kind.hint}</p>
      <dl ref={facts} className="probe-facts">
        {rows.map(([label, value, code]) => <div key={label}><dt>{label}</dt><dd>{code ? <code>{value}</code> : value}</dd></div>)}
      </dl>
      {read === 'loading' && <p className="probe-dialog-note" role="status">{words.loading}</p>}
      {read === 'gone' && <p className="probe-dialog-note" role="status">{words.gone}</p>}
      {known?.body && <details className="probe-raw"><summary>{words.body}</summary><pre>{known.body}</pre></details>}
      <div className="probe-dialog-actions">
        {copied && <span className="probe-copy-note" role="status">{copied === 'ok' ? words.copied : words.copyFailed}</span>}
        <button type="button" className="btn btn-ghost btn-small" disabled={read === 'loading'} onClick={() => void copyReport()}>{words.copy}</button>
        <button type="button" className="btn btn-primary btn-small" onClick={onClose}>{words.close}</button>
      </div>
    </section>
  </div>, document.body)
}
