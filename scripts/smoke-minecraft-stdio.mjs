import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
for (const mode of ['whole', 'fragmented', 'near-limit', 'image-oversize', 'transport-oversize']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(here, 'smoke-minecraft-images.mjs'), '--stdio=' + mode], { env: process.env, windowsHide: true, stdio: 'inherit' })
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('STDIO_SCENARIO_FAILED: ' + mode)))
  })
}
console.log('Minecraft stdio matrix passed: >1 MiB valid PNG whole/fragmented, near-6-MiB PNG through actual resize/model HTTP, image-budget refusal with verified release, and bounded transport failure without false release proof. Synthetic only.')
