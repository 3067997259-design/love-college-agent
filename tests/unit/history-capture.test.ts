import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { createManualClock } from '../../src/main/clock'
import { captureHistoryScene } from '../../src/main/history/capture'
it('times out even if renderer evaluation and cleanup never return, without allowing overlapping captures', async () => {
  const clock = createManualClock(1000)
  const executeJavaScript = vi.fn(() => new Promise<never>(() => {}))
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript, getBackgroundThrottling: () => true, setBackgroundThrottling: vi.fn() } } as unknown as BrowserWindow
  const pending = captureHistoryScene(window, 'session', clock); clock.advanceBy(5000)
  await expect(pending).rejects.toThrow('PHOTO_TIMEOUT')
  expect(executeJavaScript).toHaveBeenCalledTimes(2)
  await expect(captureHistoryScene(window, 'session', clock)).rejects.toThrow('PHOTO_BUSY')
})
