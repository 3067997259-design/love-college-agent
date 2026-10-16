// 书本界面的浏览器预览（假数据场景，数字键 1–9 切换）。不启动 Electron，也不读任何密钥。
// 用法：pnpm preview:ui，然后在浏览器打开打印出来的地址。?trace 是描图工具，?onboarding 是新手流程。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.LCA_PREVIEW_PORT ?? 5174)
const paths = join(root, 'src/renderer/src/book/wash/paths')

/** 描图工具的“保存”：只收两个固定文件名的 JSON，写进 wash/paths/；服务只听本机 */
const saveTrace = {
  name: 'lca-save-trace',
  configureServer(server) {
    server.middlewares.use('/__lca/save-trace', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
      let body = ''
      req.on('data', (chunk) => { body += chunk; if (body.length > 2_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const { file, data } = JSON.parse(body)
          if (!['trace.json', 'furniture.json'].includes(file) || data?.version !== 1) throw new Error('bad request')
          mkdirSync(paths, { recursive: true })
          writeFileSync(join(paths, file), JSON.stringify(data, null, 1) + '\n')
          console.log(`描图工具：已保存 ${file}`)
          res.setHeader('content-type', 'application/json')
          res.end('{"ok":true}')
        } catch {
          res.statusCode = 400
          res.end('{"ok":false}')
        }
      })
    })
  },
}

const server = await createServer({
  root: join(root, 'src/renderer'),
  configFile: false,
  plugins: [react(), saveTrace],
  // 和 electron.vite.config.ts 一样换掉 meshopt 解码器：它会在 script-src 'self' 下编译 WASM，触发 CSP 报错
  resolve: { alias: { '@renderer': join(root, 'src/renderer/src'), 'three/examples/jsm/libs/meshopt_decoder.module.js': join(root, 'src/renderer/src/tools/meshopt-disabled.ts') } },
  server: { host: '127.0.0.1', port, strictPort: true },
})
await server.listen()
console.log(`书本界面预览（假数据）：http://127.0.0.1:${port}/?scenario=break-delivery`)
console.log('数字键 1–9 切换场景；Ctrl+C 退出。')
console.log(`描图工具：http://127.0.0.1:${port}/?trace；新手流程：http://127.0.0.1:${port}/?onboarding`)
