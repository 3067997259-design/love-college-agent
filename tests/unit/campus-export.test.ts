import { mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManualClock } from '../../src/main/clock'
import { exportCampusItem, foldLine } from '../../src/main/campus/export'
import type { CampusItem } from '../../src/main/campus/projection'
import { createArtifactStore } from '../../src/main/artifacts/store'

const clock = createManualClock(0)
const candidate = { id: 'c:one', revision: 1, source: 'fake' as const, createdAtMs: 1000, kind: 'deadline' as const, title: '第三次作业', deadlineIso: '2026-10-24T23:59:00+08:00', plannedCompletionIso: '2026-10-23T20:00:00+08:00', status: 'confirmed' as const, sourceLabel: '课程助教 · 第三次作业', evidenceRef: 'e:private' }
const item: CampusItem = { current: candidate, accepted: candidate, originalCreatedAtMs: 1000, acceptedAtMs: 2000, calendarUid: 'stable-uid', sequence: 0 }
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) { if (!resolve(root).startsWith(join(resolve(tmpdir()), 'lca-export-'))) throw new Error('Unsafe cleanup'); rmSync(root, { recursive: true, force: true }) } })
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'lca-export-')); roots.push(root); return { root, store: createArtifactStore(root, { userId: 'u', characterId: 'c' }) } }
describe('calendar export and immutable local artifacts', () => {
  it('uses the original deadline in UTC, stable UID, and explicit revision sequence without inventing duration', () => {
    const { ics, md } = exportCampusItem(item, clock)
    expect(ics).toContain('DTSTART:20261024T155900Z\r\n'); expect(ics).not.toContain('DTEND:')
    expect(ics).toContain('UID:stable-uid@love-college-agent.local\r\nSEQUENCE:0\r\n')
    expect(ics.replaceAll('\r\n ', '')).toContain('计划完成：2026-10-23T20:00:00+08:00')
    expect(ics).not.toContain('e:private'); expect(md).toContain('合成邮件开发数据')
    const changed = exportCampusItem({ ...item, accepted: { ...candidate, revision: 2, deadlineIso: '2026-10-26T23:59:00+08:00' }, sequence: 1, acceptedAtMs: 3000 }, clock)
    expect(changed.ics).toContain('UID:stable-uid@love-college-agent.local\r\nSEQUENCE:1\r\n')
    expect(changed.ics).toContain('DTSTART:20261026T155900Z'); expect(changed.ics).toContain('LAST-MODIFIED:19700101T000003Z')
    clock.advanceBy(99_000); expect(exportCampusItem(item, clock)).toEqual({ ics, md })
  })
  it('exports event start/end separately from registration deadline and escapes/folds Unicode text by octets', () => {
    const event = { ...candidate, kind: 'event' as const, title: '分享,会;\\测试', eventStartIso: '2026-10-22T19:00:00+08:00', eventEndIso: '2026-10-22T20:30:00+08:00', locationText: '东区第二教学楼316教室' }
    const { ics } = exportCampusItem({ ...item, accepted: event }, clock)
    expect(ics).toContain('DTSTART:20261022T110000Z\r\nDTEND:20261022T123000Z')
    expect(ics).toContain('SUMMARY:分享\\,会\\;\\\\测试')
    expect(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true)
    const long = 'DESCRIPTION:' + '桃子🙂'.repeat(40)
    expect(foldLine(long).replaceAll('\r\n ', '')).toBe(long)
    expect(foldLine(long).split('\r\n').every((line) => Buffer.byteLength(line) <= 75)).toBe(true)
  })
  it('writes real files idempotently, refuses conflicting bytes, and detects corruption or traversal on open', () => {
    const { root, store } = fixture()
    const spec = { candidateId: 'c:one', revision: 1, format: 'ics' as const, displayName: '事项.ics', source: 'fake' as const, createdAtMs: 1, content: exportCampusItem(item, clock).ics }
    const artifact = store.write(spec)
    expect(readFileSync(join(root, artifact.relativePath), 'utf8')).toBe(spec.content)
    expect(store.write(spec)).toEqual(artifact); expect(store.read(artifact)).toBe(spec.content)
    expect(() => store.write({ ...spec, content: 'conflicting bytes' })).toThrow()
    expect(store.read(artifact)).toBe(spec.content)
    expect(() => store.read({ ...artifact, relativePath: '../settings.json' })).toThrow()
    writeFileSync(join(root, artifact.relativePath), 'corrupt')
    expect(() => store.read(artifact)).toThrow('ARTIFACT_INTEGRITY_FAILED')
  })
  it('rejects a directory junction that redirects artifact writes outside the owned directory', () => {
    const { root } = fixture(); const outside = mkdtempSync(join(tmpdir(), 'lca-export-')); roots.push(outside)
    rmdirSync(join(root, 'artifacts'))
    symlinkSync(outside, join(root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => createArtifactStore(root, { userId: 'u', characterId: 'c' })).toThrow('ARTIFACT_ROOT_INVALID')
  })
})
