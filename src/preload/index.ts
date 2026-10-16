import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, type AppBridge, type AppEvent } from '../shared'

const bridge: AppBridge = {
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.snapshot),
  dispatch: (command) => ipcRenderer.invoke(IPC_CHANNELS.command, command),
  readEvidence: (reference) => ipcRenderer.invoke(IPC_CHANNELS.evidence, reference),
  subscribe: (listener) => {
    const wrapped = (_event: IpcRendererEvent, event: AppEvent) => listener(event)
    ipcRenderer.on(IPC_CHANNELS.event, wrapped)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.event, wrapped) }
  },
}

contextBridge.exposeInMainWorld('lca', bridge)
