import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC_CHANNELS } from '../../src/shared'
import type { createAppController } from '../../src/main/bridge/controller'

const handlers = vi.hoisted(() => new Map<string, (event: unknown, input: unknown) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, handler: (event: unknown, input: unknown) => unknown) => handlers.set(key, handler), removeHandler: (key: string) => handlers.delete(key) } }))
import { registerAppBridge } from '../../src/main/bridge/ipc'

it('allows member details only to the registered book main frame and removes the handler on dispose', async () => {
  const read = vi.fn(async () => ({ withheld: false, steps: [] }))
  const controller = { readMemberSteps: read, subscribe: () => () => {} } as unknown as ReturnType<typeof createAppController>
  const bridge = registerAppBridge(controller)
  const window = () => ({ isDestroyed: () => false, webContents: { mainFrame: {} }, once: vi.fn() })
  const book = window(), mini = window(), diagnostics = window()
  bridge.attach(book as unknown as BrowserWindow, 'book'); bridge.attach(mini as unknown as BrowserWindow, 'mini'); bridge.attach(diagnostics as unknown as BrowserWindow, 'diagnostics')
  const handler = handlers.get(IPC_CHANNELS.memberSteps)!
  const address = { runtimeId: 'r', projectId: 'p', rootSessionId: 'root', sessionId: 'child', parentSessionId: 'root' }
  await expect(handler({ sender: book.webContents, senderFrame: book.webContents.mainFrame }, address)).resolves.toEqual({ withheld: false, steps: [] })
  for (const target of [mini, diagnostics]) expect(() => handler({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, address)).toThrow('Restricted user read')
  expect(() => handler({ sender: book.webContents, senderFrame: {} }, address)).toThrow('Unauthorized renderer')
  expect(() => handler({ sender: {}, senderFrame: {} }, address)).toThrow('Unauthorized renderer')
  expect(read).toHaveBeenCalledTimes(1)
  bridge.dispose(); expect(handlers.has(IPC_CHANNELS.memberSteps)).toBe(false)
})
