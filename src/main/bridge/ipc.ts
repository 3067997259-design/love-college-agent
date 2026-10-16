import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared'
import type { createAppController } from './controller'
import { createUserEvidenceReader, type UserEvidenceLookup } from './evidence'
import type { WindowSurface } from '../windows/companion'

export function registerAppBridge(controller: ReturnType<typeof createAppController>, evidenceLookup?: UserEvidenceLookup) {
  const windows = new Map<BrowserWindow, WindowSurface>()
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    const trusted = [...windows].find(([window]) => !window.isDestroyed() && window.webContents === event.sender && event.senderFrame === event.sender.mainFrame)
    if (!trusted) {
      throw new Error('Unauthorized renderer.')
    }
    return trusted[1]
  }
  ipcMain.handle(IPC_CHANNELS.snapshot, (event) => { assertTrusted(event); return controller.getSnapshot() })
  ipcMain.handle(IPC_CHANNELS.command, (event, input: unknown) => { const surface = assertTrusted(event); return controller.dispatch(input, surface) })
  const readEvidence = createUserEvidenceReader(evidenceLookup)
  const assertUserSurface = (event: IpcMainInvokeEvent) => { if (assertTrusted(event) === 'diagnostics') throw new Error('Restricted diagnostics window.') }
  ipcMain.handle(IPC_CHANNELS.evidence, (event, reference: unknown) => { assertUserSurface(event); return readEvidence(reference, controller.getSnapshot().scope) })
  ipcMain.handle(IPC_CHANNELS.files, (event, input: unknown) => { assertUserSurface(event); return controller.importUserFiles(input) })
  ipcMain.handle(IPC_CHANNELS.session, (event, id: unknown) => { assertUserSurface(event); return controller.readSession(id) })
  ipcMain.handle(IPC_CHANNELS.diagnostics, (event) => { assertTrusted(event); return controller.readDiagnostics() })
  const unsubscribe = controller.subscribe((event) => {
    for (const window of windows.keys()) if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event)
  })
  return {
    attach: (window: BrowserWindow, surface: WindowSurface = 'book') => { windows.set(window, surface); window.once('closed', () => windows.delete(window)) },
    dispose: () => { unsubscribe(); for (const channel of [IPC_CHANNELS.snapshot, IPC_CHANNELS.command, IPC_CHANNELS.evidence, IPC_CHANNELS.files, IPC_CHANNELS.session, IPC_CHANNELS.diagnostics]) ipcMain.removeHandler(channel); windows.clear() },
  }
}
