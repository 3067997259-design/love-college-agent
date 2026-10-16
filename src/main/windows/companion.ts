import { BrowserWindow, screen } from 'electron'
import type { AppCommand, AppEvent, AppSnapshot, PublicErrorCode, WindowsView } from '../../shared'
import type { Clock } from '../clock'
import type { SettingsStore } from '../config/settings'
import type { Scheduler } from '../scheduler'
import { clampMiniBounds, MINI_SIZE, moveMiniByPixels, restoreMiniBounds } from './bounds'
import { hasBlackMiniCorners, type MiniFallbackReason } from './presentation'

export type WindowSurface = 'book' | 'mini' | 'diagnostics'
const safeWorkArea = (area: { x: number; y: number; width: number; height: number }) => {
  const inset = Math.min(2, Math.floor(Math.min(area.width, area.height) / 4))
  return { x: area.x + inset, y: area.y + inset, width: area.width - inset * 2, height: area.height - inset * 2 }
}
export function createCompanionWindows(options: { book: BrowserWindow; clock: Clock; uiClock: Clock; scheduler: Scheduler; settings: SettingsStore;
  initialFallbackReason?: MiniFallbackReason | null;
  createDiagnostics(): BrowserWindow;
  createMini(bounds: { x: number; y: number; width: number; height: number }, opaque: boolean): BrowserWindow; snapshot(): AppSnapshot; subscribe(listener: (event: AppEvent) => void): () => void; changed(): void }) {
  let mini: BrowserWindow | undefined; let ready = false; let wantMini = false; let mode: 'book' | 'mini' = 'book'; let clickThrough = true; let disposed = false; let savePosition: (() => void) | undefined
  let fallbackReason = options.initialFallbackReason ?? null; let checkTransparency: (() => void) | undefined
  let diagnostics: BrowserWindow | undefined; let remainder = { x: 0, y: 0 }
  // Confirming a replacement plan during a focus must not collapse an already expanded book again.
  const focusKey = (snapshot: AppSnapshot) => snapshot.pomodoro.phase === 'focus' && snapshot.pomodoro.plan ? String(snapshot.pomodoro.focusIndex) : null
  let lastFocus = focusKey(options.snapshot())
  let transition: (() => void) | undefined
  // Let the originating pointer/IPC finish before hiding its window. This is UI time, not simulation time.
  const defer = (action: () => void) => { transition?.(); transition = options.uiClock.after(50, () => { transition = undefined; action() }) }
  const persist = () => { savePosition?.(); savePosition = undefined; if (mini && !mini.isDestroyed()) { const bounds = mini.getBounds(); options.settings.update((draft) => { draft.miniPosition = { x: bounds.x, y: bounds.y, displayId: screen.getDisplayMatching(bounds).id } }) } }
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
      const bounds = restoreMiniBounds(options.settings.read().miniPosition, screen.getAllDisplays(), screen.getPrimaryDisplay().workArea)
      remainder = { x: 0, y: 0 }
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
    const bounds = mini.getBounds(); const area = safeWorkArea(screen.getDisplayMatching(bounds).workArea)
    const next = clampMiniBounds(bounds, area)
    // Windows at fractional DPI grows a frameless window on setPosition(getBounds()).
    // Set content bounds in one call so the renderer stays 280 x 350 DIP instead of accumulating rounding.
    mini.setContentBounds({ x: next.x, y: next.y, width: Math.min(MINI_SIZE.width, area.width), height: Math.min(MINI_SIZE.height, area.height) }, false)
    remainder = { x: 0, y: 0 }; persist(); options.changed()
  }
  screen.on('display-removed', relocate); screen.on('display-metrics-changed', relocate); screen.on('display-added', relocate)
  const stop = options.subscribe((event) => { const key = focusKey(event.snapshot); if (key !== lastFocus) { lastFocus = key; if (key && event.snapshot.pomodoro.status === 'running') collapse() } })
  const dispose = () => { if (disposed) return; disposed = true; transition?.(); stop(); screen.removeListener('display-removed', relocate); screen.removeListener('display-metrics-changed', relocate); screen.removeListener('display-added', relocate); destroyMini(); if (diagnostics && !diagnostics.isDestroyed()) diagnostics.destroy() }
  options.book.once('closed', dispose)
  return { dispose, fallback,
    view: (): WindowsView => ({ mode, diagnosticsOpen: !!diagnostics && !diagnostics.isDestroyed(), miniPresentation: fallbackReason ? 'opaque' : 'transparent', miniFallbackReason: fallbackReason, miniBounds: mini && !mini.isDestroyed() ? mini.getBounds() : null, miniAlwaysOnTop: !!mini && !mini.isDestroyed() && mini.isAlwaysOnTop(), miniClickThrough: !!mini && !mini.isDestroyed() && clickThrough }),
    dispatch: (command: AppCommand, surface: WindowSurface): PublicErrorCode | undefined => {
      if (disposed) return 'unavailable'
      if (surface === 'diagnostics') return 'permission-denied'
      if (command.type === 'window.diagnostics.open') {
        if (options.snapshot().runtime?.developer.mode !== 'developer') return 'permission-denied'
        if (diagnostics && !diagnostics.isDestroyed()) { diagnostics.show(); diagnostics.focus(); return }
        const window = options.createDiagnostics(); diagnostics = window
        window.once('ready-to-show', () => { if (!disposed && !window.isDestroyed()) window.show() })
        window.once('closed', () => { if (diagnostics === window) diagnostics = undefined; if (!disposed) options.changed() })
        options.changed(); return
      }
      if (command.type === 'window.mini') { collapse(); return }
      if (command.type === 'window.expand' || command.type === 'window.book') { wantMini = false; defer(expand); return }
      if (surface !== 'mini') return 'permission-denied'
      if (command.type === 'window.mini.hover') { if (mode === 'mini') { ignore(!command.over); options.changed() }; return }
      if (command.type === 'window.mini.move' || command.type === 'window.mini.moveBy') {
        if (!mini || mini.isDestroyed() || mode !== 'mini') return 'unavailable'
        const current = mini.getBounds(); const display = screen.getDisplayMatching(current); const area = safeWorkArea(display.workArea)
        // Leave two DIP for native high-DPI rounding and keep the content size fixed on every move.
        const moved = moveMiniByPixels(current, command.dx, command.dy, area, command.type === 'window.mini.moveBy' ? display.scaleFactor : 1, command.type === 'window.mini.moveBy' ? remainder : { x: 0, y: 0 })
        const next = moved.bounds
        mini.setContentBounds({ x: next.x, y: next.y, width: Math.min(MINI_SIZE.width, area.width), height: Math.min(MINI_SIZE.height, area.height) }, false)
        const actual = mini.getBounds(); remainder = { x: moved.remainder.x + next.x - actual.x, y: moved.remainder.y + next.y - actual.y }
        savePosition?.(); savePosition = options.uiClock.after(500, persist); options.changed(); return
      }
      return 'invalid-command'
    },
  }
}
export type CompanionWindows = ReturnType<typeof createCompanionWindows>
