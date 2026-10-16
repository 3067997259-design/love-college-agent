import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared'
import type { createAppController } from './controller'
import { createUserEvidenceReader, type UserEvidenceLookup } from './evidence'

export function registerAppBridge(controller: ReturnType<typeof createAppController>, evidenceLookup?: UserEvidenceLookup) {
  const windows = new Set<BrowserWindow>()
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (![...windows].some((window) => !window.isDestroyed() && window.webContents === event.sender && event.senderFrame === event.sender.mainFrame)) {
      throw new Error('Unauthorized renderer.')
    }
  }
  ipcMain.handle(IPC_CHANNELS.snapshot, (event) => { assertTrusted(event); return controller.getSnapshot() })
  ipcMain.handle(IPC_CHANNELS.command, (event, input: unknown) => { assertTrusted(event); return controller.dispatch(input) })
  const readEvidence = createUserEvidenceReader(evidenceLookup)
  ipcMain.handle(IPC_CHANNELS.evidence, (event, reference: unknown) => { assertTrusted(event); return readEvidence(reference, controller.getSnapshot().scope) })
  ipcMain.handle(IPC_CHANNELS.files, (event, input: unknown) => { assertTrusted(event); return controller.importUserFiles(input) })
  const unsubscribe = controller.subscribe((event) => {
    for (const window of windows) if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event)
  })
  return {
    attach: (window: BrowserWindow) => { windows.add(window); window.once('closed', () => windows.delete(window)) },
    dispose: () => { unsubscribe(); for (const channel of [IPC_CHANNELS.snapshot, IPC_CHANNELS.command, IPC_CHANNELS.evidence, IPC_CHANNELS.files]) ipcMain.removeHandler(channel); windows.clear() },
  }
}
