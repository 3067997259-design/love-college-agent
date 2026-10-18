import { useState } from 'react'
import type { AppBridge, AppSnapshot, GeneratedGiftView, QuillView } from '../../../../shared'
import copy from '../../voice/book.zh.json'
import { sendCommand, type CommandBody } from '../command'
import { GiftModel } from '../life/GiftModel'
import { ObjectSketch } from '../life/objects'
import { dateLabel, dayKeyLabel, fill, giftName, sourceText } from '../life/text'

type Entry =
  | { kind: 'quill'; id: string; at: number; quill: QuillView }
  | { kind: 'gift'; id: string; at: number; gift: GeneratedGiftView }

/**
 * 礼物架（体验设计 §2 书签）：她送你的东西摆在架子上，点开看它来自哪段经历；下面是她出门带回来的。
 * 状态都来自快照：做没做好、送没送出由主进程判定，这里不推导。3D 只在展台上放一个。
 */
export function GiftShelf({ snapshot, bridge }: { snapshot: AppSnapshot; bridge: AppBridge }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const quill = snapshot.quill?.state === 'given' ? snapshot.quill : null
  const entries: Entry[] = [
    ...(quill ? [{ kind: 'quill' as const, id: quill.id, at: quill.givenAtMs ?? quill.createdAtMs, quill }] : []),
    ...(snapshot.gifts?.items ?? []).filter((gift) => gift.status !== 'cancelled')
      .map((gift) => ({ kind: 'gift' as const, id: gift.id, at: gift.givenAtMs ?? gift.readyAtMs ?? gift.createdAtMs, gift })),
  ].sort((a, b) => a.at - b.at)
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries.findLast((entry) => entry.kind === 'quill' || entry.gift.status === 'given') ?? entries.at(-1)
  const items = snapshot.life?.items ?? []
  const command = async (body: CommandBody) => setFailed(!(await sendCommand(bridge, snapshot.epoch, body)).ok)

  return (
    <section className="page page-right sheet" aria-label={copy.shelf.title}>
      <header className="page-head">
        <span className="page-date">{copy.shelf.title}</span>
        <span className="sheet-lead">{copy.shelf.lead}</span>
      </header>
      <div className="sheet-body">
        <h2 className="sheet-section">{copy.shelf.given}</h2>
        {selected ? <Showcase entry={selected} snapshot={snapshot} failed={failed} onCommand={(body) => { void command(body) }} /> : <p className="sheet-empty">{copy.shelf.empty}</p>}
        {entries.length > 0 && (
          <ul className="shelf" aria-label={copy.shelf.given}>
            {entries.map((entry) => {
              const kind = entry.kind === 'quill' ? 'quill' : entry.gift.objectId
              const name = entry.kind === 'quill' ? copy.objects.quill : giftName(entry.gift)
              return (
                <li key={entry.id}>
                  <button type="button" className="shelf-item" data-active={entry.id === selected?.id}
                    data-status={entry.kind === 'gift' ? entry.gift.status : 'given'} onClick={() => setSelectedId(entry.id)}>
                    <ObjectSketch kind={kind} className={kind === 'quill' ? 'shelf-quill' : 'shelf-sketch'} motif={entry.kind === 'gift' ? entry.gift.motif : 'plain'} />
                    <span>{name}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <h2 className="sheet-section">{copy.shelf.brought}</h2>
        {items.length === 0 ? <p className="sheet-empty">{copy.shelf.broughtEmpty}</p> : (
          <ul className="brought">
            {[...items].reverse().map((item) => (
              <li key={item.id} className="brought-item">
                <ObjectSketch kind={item.kind} className="brought-sketch" />
                <span className="brought-name">{copy.objects[item.kind]}</span>
                <span className="brought-note">{fill(copy.shelf.broughtOn, { date: dayKeyLabel(item.dayKey), place: copy.places[item.place] })}</span>
                <span className="brought-where">{item.display === 'desk' ? copy.shelf.onSill : copy.shelf.inDrawer}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

/** 展台：选中的那一件。做好了的有 3D 就放 3D，没有就是铅笔画 */
function Showcase({ entry, snapshot, failed, onCommand }: { entry: Entry; snapshot: AppSnapshot; failed: boolean; onCommand: (body: CommandBody) => void }) {
  if (entry.kind === 'quill') {
    return (
      <article className="showcase">
        <div className="showcase-art"><ObjectSketch kind="quill" className="showcase-quill" /></div>
        <div className="showcase-text">
          <h3 className="card-title">{copy.objects.quill}</h3>
          <p className="showcase-date">{fill(copy.shelf.givenOn, { date: dateLabel(entry.at) })}</p>
          <p className="showcase-from">{copy.shelf.quillNote}</p>
        </div>
      </article>
    )
  }
  const { gift } = entry
  const name = giftName(gift)
  const from = sourceText(snapshot, gift.sourceMemoryId)
  const status = {
    proposed: gift.acceptedAtMs ? copy.shelf.accepted : fill(copy.shelf.proposed, { object: name, measure: copy.measures[gift.objectId] }),
    making: fill(copy.shelf.making, { object: name, measure: copy.measures[gift.objectId] }),
    ready: copy.shelf.ready,
    given: fill(copy.shelf.givenOn, { date: dateLabel(gift.givenAtMs ?? gift.createdAtMs) }),
    failed: copy.shelf.failed,
    cancelled: copy.shelf.cancelled,
  }[gift.status]
  const shown = gift.assetUrl && (gift.status === 'ready' || gift.status === 'given')
  return (
    <article className="showcase" data-status={gift.status}>
      <div className="showcase-art">
        {shown ? <GiftModel gift={gift} label={name} className="showcase-model" /> : <ObjectSketch kind={gift.objectId} className="showcase-sketch" drawing={gift.status === 'making'} motif={gift.motif} />}
      </div>
      <div className="showcase-text">
        <h3 className="card-title">{name}{gift.source === 'fake' && <small className="demo-tag">{copy.shelf.fake}</small>}</h3>
        <p className="showcase-date">{status}</p>
        <p className="showcase-from">{from ? fill(copy.shelf.from, { text: from }) : copy.shelf.fromUnknown}</p>
        {gift.status === 'proposed' && (
          <div className="card-actions">
            {!gift.acceptedAtMs && <button type="button" className="btn btn-primary btn-small"
              onClick={() => onCommand({ type: 'gift.accept', giftId: gift.id })}>{copy.shelf.start}</button>}
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onCommand({ type: 'gift.cancel', giftId: gift.id })}>{copy.shelf.decline}</button>
          </div>
        )}
        {gift.status === 'making' && (
          <div className="card-actions">
            <button type="button" className="btn btn-ghost btn-small" onClick={() => onCommand({ type: 'gift.cancel', giftId: gift.id })}>{copy.shelf.stop}</button>
          </div>
        )}
        {failed && <span className="notice-mark" title="没办成，稍后再试">！</span>}
      </div>
    </article>
  )
}
