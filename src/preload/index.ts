import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, type AppBridge, type AppEvent } from '../shared'

const bridge: AppBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.snapshot),
  dispatch: (command) => ipcRenderer.invoke(IPC_CHANNELS.command, command),
  readEvidence: (reference) => ipcRenderer.invoke(IPC_CHANNELS.evidence, reference),
  readSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.session, id),
  readDiagnostics: () => ipcRenderer.invoke(IPC_CHANNELS.diagnostics),
  importFiles: async (files, epoch) => {
    try {
      if (files.length < 1 || files.length > 5) throw new Error('FILE_COUNT_INVALID')
      const paths = Array.from(files, (file) => webUtils.getPathForFile(file))
      if (paths.some((path) => !path)) throw new Error('NATIVE_FILE_REQUIRED')
      return await ipcRenderer.invoke(IPC_CHANNELS.files, { epoch, paths })
    } catch { return { acceptedIds: [], rejectedCount: files.length || 1, error: { code: 'invalid-command', retryable: false } } }
  },
  subscribe: (listener) => {
    const wrapped = (_event: IpcRendererEvent, event: AppEvent) => listener(event)
    ipcRenderer.on(IPC_CHANNELS.event, wrapped)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.event, wrapped) }
  },
}

contextBridge.exposeInMainWorld('lca', bridge)
