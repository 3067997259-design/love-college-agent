import { createNativeMemoryDatabase } from './neo'
import type { MemoryDatabaseReply, MemoryDatabaseRequest } from './protocol'

const port = process.parentPort
if (!port) throw new Error('Memory storage must run in an Electron utility process')
const database = createNativeMemoryDatabase()
let tail: Promise<void> = Promise.resolve()
port.on('message', (event: { data: { id: string; request: MemoryDatabaseRequest } }) => {
  const { id, request } = event.data
  tail = tail.then(async () => {
    let reply: MemoryDatabaseReply
    try { reply = { id, ok: true, result: await database.request(request) } }
    catch { reply = { id, ok: false, error: 'storage_failed' } }
    port.postMessage(reply)
  })
})
