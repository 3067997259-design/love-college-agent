import { BrowserWindow, screen } from 'electron'
import type { AppCommand, AppEvent, AppSnapshot, PublicErrorCode, WindowsView } from '../../shared'
import type { Clock } from '../clock'
import type { SettingsStore } from '../config/settings'
import type { Scheduler } from '../scheduler'
import { clampMiniBounds } from './bounds'
import { hasBlackMiniCorners, type MiniFallbackReason } from './presentation'

export type WindowSurface = 'book' | 'mini'
const safeWorkArea = (area: { x: number; y: number; width: number; height: number }) => {
  const inset = Math.min(2, Math.floor(Math.min(area.width, area.height) / 4))
  return { x: area.x + inset, y: area.y + inset, width: area.width - inset * 2, height: area.height - inset * 2 }
}
export function createCompanionWindows(options: { book: BrowserWindow; clock: Clock; uiClock: Clock; scheduler: Scheduler; settings: SettingsStore;
  initialFallbackReason?: MiniFallbackReason | null;
  createMini(bounds: { x: number; y: number; width: number; height: number }, opaque: boolean): BrowserWindow; snapshot(): AppSnapshot; subscribe(listener: (event: AppEvent) => void): () => void; changed(): void }) {
  let mini: BrowserWindow | undefined; let ready = false; let wantMini = false; let mode: WindowSurface = 'book'; let clickThrough = true; let disposed = false; let savePosition: (() => void) | undefined
  let fallbackReason = options.initialFallbackReason ?? null; let checkTransparency: (() => void) | undefined
  // Confirming a replacement plan during a focus must not collapse an already expanded book again.
  const focusKey = (snapshot: AppSnapshot) => snapshot.pomodoro.phase === 'focus' && snapshot.pomodoro.plan ? String(snapshot.pomodoro.focusIndex) : null
  let lastFocus = focusKey(options.snapshot())
  let transition: (() => void) | undefined
  // Let the originating pointer/IPC finish before hiding its window. This is UI time, not simulation time.
  const defer = (action: () => void) => { transition?.(); transition = options.uiClock.after(50, () => { transition = undefined; action() }) }
  const persist = () => { savePosition?.(); savePosition = undefined; if (mini && !mini.isDestroyed()) { const { x, y } = mini.getBounds(); options.settings.update((draft) => { draft.miniPosition = { x, y } }) } }
  const ignore = (value: boolean) => { if (!mini || mini.isDestroyed()) return; mini.setIgnoreMouseEvents(value, { forward: true }); clickThrough = value }
  const destroyMini = () => { options.scheduler.cancel('mini.pointer'); checkTransparency?.(); checkTransparency = undefined; persist(); const previous = mini; mini = undefined; ready = false; if (previous && !previous.isDestroyed()) previous.destroy() }
  const expand = () => {
    if (disposed || options.book.isDestroyed()) return
    wantMini = false; mode = 'book'; destroyMini(); options.book.show(); options.book.focus(); options.changed()
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
  const inspectTransparency = (window: BrowserWindow, again = false) => {
    checkTransparency = options.uiClock.after(250, () => {
      checkTransparency = undefined
      if (disposed || mini !== window || window.isDestroyed() || fallbackReason || mode !== 'mini') return
      void window.webContents.capturePage().then((image) => {
        if (disposed || mini !== window || window.isDestroyed() || fallbackReason || mode !== 'mini' || image.isEmpty()) return
        const pixels = image.resize({ width: 32, height: 40 }); const size = pixels.getSize()
        if (hasBlackMiniCorners(pixels.toBitmap(), size.width, size.height)) { if (again) fallback('black-background'); else inspectTransparency(window, true) }
      }).catch(() => { /* A closed window or capture failure is not evidence of a black compositor. */ })
    })
  }
  const collapse = () => {
    if (disposed) return
    transition?.(); transition = undefined
    wantMini = true
    if (!mini || mini.isDestroyed()) {
      const saved = options.settings.read().miniPosition; const area = saved ? screen.getDisplayNearestPoint(saved).workArea : screen.getPrimaryDisplay().workArea
      const bounds = clampMiniBounds({ x: saved?.x ?? area.x + area.width - 344, y: saved?.y ?? area.y + area.height - 424, width: 320, height: 400 }, safeWorkArea(area))
      mini = options.createMini(bounds, !!fallbackReason); ready = false
      const window = mini; ignore(true)
      mini.once('ready-to-show', () => { if (disposed || mini !== window) return; ready = true; relocate(); present(); if (!fallbackReason) inspectTransparency(window) })
      mini.on('close', (event) => { if (!disposed) { event.preventDefault(); expand() } })
      return
    }
    defer(present)
  }
  const fallback = (reason: MiniFallbackReason) => {
    if (disposed || fallbackReason) return
    fallbackReason = reason
    if (mini) { destroyMini(); if (wantMini) collapse() }
    options.changed()
  }
  const relocate = () => {
    if (!mini || mini.isDestroyed()) return
    const bounds = mini.getBounds(); const area = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
    const next = clampMiniBounds(bounds, safeWorkArea(area))
    if (next.width !== bounds.width || next.height !== bounds.height) mini.setSize(next.width, next.height, false)
    mini.setPosition(next.x, next.y, false); persist(); options.changed()
  }
  screen.on('display-removed', relocate); screen.on('display-metrics-changed', relocate); screen.on('display-added', relocate)
  const stop = options.subscribe((event) => { const key = focusKey(event.snapshot); if (key !== lastFocus) { lastFocus = key; if (key && event.snapshot.pomodoro.status === 'running') collapse() } })
  const dispose = () => { if (disposed) return; disposed = true; transition?.(); stop(); screen.removeListener('display-removed', relocate); screen.removeListener('display-metrics-changed', relocate); screen.removeListener('display-added', relocate); destroyMini() }
  options.book.once('closed', dispose)
  return { dispose, fallback,
    view: (): WindowsView => ({ mode, miniPresentation: fallbackReason ? 'opaque' : 'transparent', miniFallbackReason: fallbackReason, miniBounds: mini && !mini.isDestroyed() ? mini.getBounds() : null, miniAlwaysOnTop: !!mini && !mini.isDestroyed() && mini.isAlwaysOnTop(), miniClickThrough: !!mini && !mini.isDestroyed() && clickThrough }),
    dispatch: (command: AppCommand, surface: WindowSurface): PublicErrorCode | undefined => {
      if (disposed) return 'unavailable'
      if (command.type === 'window.mini') { collapse(); return }
      if (command.type === 'window.expand' || command.type === 'window.book') { wantMini = false; defer(expand); return }
      if (surface !== 'mini') return 'permission-denied'
      if (command.type === 'window.mini.hover') { if (mode === 'mini') { ignore(!command.over); options.changed() }; return }
      if (command.type === 'window.mini.move') {
        if (!mini || mini.isDestroyed() || mode !== 'mini') return 'unavailable'
        const current = mini.getBounds(); const x = current.x + command.dx; const y = current.y + command.dy
        const area = screen.getDisplayNearestPoint({ x: Math.round(x + current.width / 2), y: Math.round(y + current.height / 2) }).workArea
        // Leave two DIP for native high-DPI rounding; movement must not repeatedly resize the paper.
        const next = clampMiniBounds({ ...current, x, y }, safeWorkArea(area))
        if (next.width !== current.width || next.height !== current.height) mini.setSize(next.width, next.height, false)
        mini.setPosition(next.x, next.y, false); savePosition?.(); savePosition = options.uiClock.after(500, persist); options.changed(); return
      }
      return 'invalid-command'
    },
  }
}
export type CompanionWindows = ReturnType<typeof createCompanionWindows>
