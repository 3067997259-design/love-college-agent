import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared'
import type { createAppController } from './controller'

export function registerAppBridge(controller: ReturnType<typeof createAppController>) {
  const windows = new Set<BrowserWindow>()
  const assertTrusted = (event: IpcMainInvokeEvent) => {
    if (![...windows].some((window) => !window.isDestroyed() && window.webContents === event.sender && event.senderFrame === event.sender.mainFrame)) {
      throw new Error('Unauthorized renderer.')
    }
  }
  ipcMain.handle(IPC_CHANNELS.snapshot, (event) => { assertTrusted(event); return controller.getSnapshot() })
  ipcMain.handle(IPC_CHANNELS.command, (event, input: unknown) => { assertTrusted(event); return controller.dispatch(input) })
  const unsubscribe = controller.subscribe((event) => {
    for (const window of windows) if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.event, event)
  })
  return {
    attach: (window: BrowserWindow) => { windows.add(window); window.once('closed', () => windows.delete(window)) },
    dispose: () => { unsubscribe(); ipcMain.removeHandler(IPC_CHANNELS.snapshot); ipcMain.removeHandler(IPC_CHANNELS.command); windows.clear() },
  }
}
