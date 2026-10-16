import { BrowserWindow, screen } from 'electron'
import type { AppCommand, AppEvent, AppSnapshot, PublicErrorCode, WindowsView } from '../../shared'
import type { Clock } from '../clock'
import type { SettingsStore } from '../config/settings'
import type { Scheduler } from '../scheduler'
import { clampMiniBounds } from './bounds'

export type WindowSurface = 'book' | 'mini'
export function createCompanionWindows(options: { book: BrowserWindow; clock: Clock; uiClock: Clock; scheduler: Scheduler; settings: SettingsStore;
  createMini(bounds: { x: number; y: number; width: number; height: number }): BrowserWindow; snapshot(): AppSnapshot; subscribe(listener: (event: AppEvent) => void): () => void; changed(): void }) {
  let mini: BrowserWindow | undefined; let ready = false; let wantMini = false; let mode: WindowSurface = 'book'; let clickThrough = true; let disposed = false; let savePosition: (() => void) | undefined
  const focusKey = (snapshot: AppSnapshot) => snapshot.pomodoro.phase === 'focus' && snapshot.pomodoro.plan ? snapshot.pomodoro.plan.id + ':' + snapshot.pomodoro.focusIndex : null
  let lastFocus = focusKey(options.snapshot())
  let transition: (() => void) | undefined
  // Let the originating pointer/IPC finish before hiding its window. This is UI time, not simulation time.
  const defer = (action: () => void) => { transition?.(); transition = options.uiClock.after(50, () => { transition = undefined; action() }) }
  const persist = () => { savePosition?.(); savePosition = undefined; if (mini && !mini.isDestroyed()) { const { x, y } = mini.getBounds(); options.settings.update((draft) => { draft.miniPosition = { x, y } }) } }
  const ignore = (value: boolean) => { if (!mini || mini.isDestroyed()) return; mini.setIgnoreMouseEvents(value, { forward: true }); clickThrough = value }
  const expand = () => {
    if (disposed || options.book.isDestroyed()) return
    wantMini = false; mode = 'book'; options.scheduler.cancel('mini.pointer'); ignore(true); mini?.hide(); options.book.show(); options.book.focus(); options.changed()
  }
  const present = () => {
    if (disposed || !wantMini || !mini || mini.isDestroyed() || !ready) return
    mode = 'mini'; mini.setAlwaysOnTop(true, 'floating'); ignore(true); mini.showInactive(); options.book.hide(); options.changed()
    options.scheduler.schedule('mini.pointer', options.clock.nowMs() + 200, () => {
      if (!mini || mini.isDestroyed() || mode !== 'mini') return
      const point = screen.getCursorScreenPoint(); const bounds = mini.getBounds()
      if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) { if (!clickThrough) { ignore(true); options.changed() } }
    }, { everyMs: 200, background: false })
  }
  const collapse = () => {
    if (disposed) return
    wantMini = true
    if (!mini || mini.isDestroyed()) {
      const saved = options.settings.read().miniPosition; const area = saved ? screen.getDisplayNearestPoint(saved).workArea : screen.getPrimaryDisplay().workArea
      const bounds = clampMiniBounds({ x: saved?.x ?? area.x + area.width - 344, y: saved?.y ?? area.y + area.height - 424, width: 320, height: 400 }, area)
      mini = options.createMini(bounds); ready = false
      mini.once('ready-to-show', () => { ready = true; present() })
      mini.on('close', (event) => { if (!disposed) { event.preventDefault(); expand() } })
      return
    }
    defer(present)
  }
  const stop = options.subscribe((event) => { const key = focusKey(event.snapshot); if (key !== lastFocus) { lastFocus = key; if (key && event.snapshot.pomodoro.status === 'running') collapse() } })
  const dispose = () => { if (disposed) return; disposed = true; transition?.(); persist(); stop(); options.scheduler.cancel('mini.pointer'); if (mini && !mini.isDestroyed()) mini.destroy() }
  options.book.once('closed', dispose)
  return { dispose,
    view: (): WindowsView => ({ mode, miniBounds: mini && !mini.isDestroyed() ? mini.getBounds() : null, miniAlwaysOnTop: !!mini && !mini.isDestroyed() && mini.isAlwaysOnTop(), miniClickThrough: !!mini && !mini.isDestroyed() && clickThrough }),
    dispatch: (command: AppCommand, surface: WindowSurface): PublicErrorCode | undefined => {
      if (disposed) return 'unavailable'
      if (command.type === 'window.mini') { collapse(); return }
      if (command.type === 'window.book') { wantMini = false; defer(expand); return }
      if (surface !== 'mini') return 'permission-denied'
      if (command.type === 'window.mini.hover') { if (mode === 'mini') { ignore(!command.over); options.changed() }; return }
      if (command.type === 'window.mini.move') {
        if (!mini || mini.isDestroyed() || mode !== 'mini') return 'unavailable'
        const current = mini.getBounds(); const x = current.x + command.dx; const y = current.y + command.dy
        const area = screen.getDisplayNearestPoint({ x: Math.round(x + current.width / 2), y: Math.round(y + current.height / 2) }).workArea
        // Leave two DIP for native high-DPI rounding; movement must not repeatedly resize the paper.
        const inset = Math.min(2, Math.floor(Math.min(area.width, area.height) / 4))
        const next = clampMiniBounds({ ...current, x, y }, { x: area.x + inset, y: area.y + inset, width: area.width - inset * 2, height: area.height - inset * 2 })
        if (next.width !== current.width || next.height !== current.height) mini.setSize(next.width, next.height, false)
        mini.setPosition(next.x, next.y, false); savePosition?.(); savePosition = options.uiClock.after(500, persist); options.changed(); return
      }
      return 'invalid-command'
    },
  }
}
export type CompanionWindows = ReturnType<typeof createCompanionWindows>
