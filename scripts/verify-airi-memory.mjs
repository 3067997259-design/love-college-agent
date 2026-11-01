import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve('vendor/airi-memory')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
if (manifest.commit !== '3a84a4fbaf6a54defe385e050be86fcb5436745b') throw new Error('AIRI baseline changed')
for (const file of manifest.files) {
  if (!['baseline', 'increment'].includes(file.layer) || file.path.includes('..') || file.path.startsWith('/')) throw new Error('Invalid source manifest path')
  const bytes = readFileSync(resolve(root, file.layer, file.path))
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Pinned AIRI source changed: ${file.layer}/${file.path}`)
}
console.log(JSON.stringify({ ok: true, files: manifest.files.length, commit: manifest.commit }))
