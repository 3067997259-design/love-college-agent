// 书本界面的浏览器预览（假数据场景，数字键 1–9 切换）。不启动 Electron，也不读任何密钥。
// 用法：pnpm preview:ui，然后在浏览器打开打印出来的地址。
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.LCA_PREVIEW_PORT ?? 5174)
const server = await createServer({
  root: join(root, 'src/renderer'),
  configFile: false,
  plugins: [react()],
  resolve: { alias: { '@renderer': join(root, 'src/renderer/src') } },
  server: { host: '127.0.0.1', port, strictPort: true },
})
await server.listen()
console.log(`书本界面预览（假数据）：http://127.0.0.1:${port}/?scenario=break-delivery`)
console.log('数字键 1–9 切换场景；Ctrl+C 退出。')
