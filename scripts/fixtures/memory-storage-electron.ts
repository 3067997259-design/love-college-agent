import { app } from 'electron'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createManualClock } from '../../src/main/clock'
import { openUtilityMemoryDatabase } from '../../src/main/memory/storage/host'
import { runMemoryStorageContract } from './memory-storage-contract'

const root = process.argv[2]
if (!root) throw new Error('Isolated probe directory required')
mkdirSync(join(root, 'electron-profile'), { recursive: true })
app.setPath('userData', join(root, 'electron-profile'))
app.disableHardwareAcceleration()
void app.whenReady().then(async () => {
  const pids: number[] = []
  try {
    const report = await runMemoryStorageContract(async () => {
      const db = await openUtilityMemoryDatabase({ path: join(root, 'memory.duckdb'), clock: createManualClock(100), workerPath: join(__dirname, 'memoryWorker.cjs') })
      if (db.pid()) pids.push(db.pid()!)
      return db
    })
    writeFileSync(join(root, 'report.json'), JSON.stringify({ ...report, runtime: { electron: process.versions.electron, node: process.versions.node }, utilityPids: pids }, null, 2))
    app.exit(0)
  } catch (error) {
    // This fixture handles only its own synthetic facts. Product errors are redacted in host.ts.
    writeFileSync(join(root, 'report.json'), JSON.stringify({ ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined, utilityPids: pids }, null, 2))
    app.exit(1)
  }
})
