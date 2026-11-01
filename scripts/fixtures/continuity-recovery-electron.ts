import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createManualClock } from '../../src/main/clock'
import { openUtilityMemoryDatabase } from '../../src/main/memory/storage/host'
import { probeContinuityRecovery } from '../../src/main/validation/continuity-recovery'

const root = process.argv[2]
if (!root) throw new Error('Isolated recovery directory required')
mkdirSync(join(root, 'electron-profile'), { recursive: true })
app.setPath('userData', join(root, 'electron-profile')); app.disableHardwareAcceleration()
void app.whenReady().then(async () => {
  const utilityPids: number[] = []
  try {
    const report = await probeContinuityRecovery(join(root, 'profile'), async path => {
      const database = await openUtilityMemoryDatabase({ path, clock: createManualClock(1790000000000), workerPath: join(__dirname, 'memoryWorker.cjs') })
      if (database.pid()) utilityPids.push(database.pid()!)
      return database
    })
    writeFileSync(join(root, 'report.json'), JSON.stringify({ ...report, runtime: { electron: process.versions.electron, node: process.versions.node }, utilityPids }, null, 2))
    app.exit(0)
  } catch (error) {
    // Only local synthetic fixtures reach this diagnostic report.
    writeFileSync(join(root, 'report.json'), JSON.stringify({ ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined, utilityPids }, null, 2))
    app.exit(1)
  }
})
