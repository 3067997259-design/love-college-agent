import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

describe('engineering boundaries', () => {
  it('rejects wall clocks, global timers and renderer privileged imports', async () => {
    const eslint = new ESLint()
    const [business] = await eslint.lintText('Date.now(); new Date(); setTimeout(() => {}, 1); setInterval(() => {}, 1); globalThis.Date.now(); window.setTimeout(() => {}, 1)', { filePath: 'src/main/business.ts' })
    expect(business.messages.filter((message) => message.ruleId?.startsWith('no-restricted')).length).toBe(6)
    const [renderer] = await eslint.lintText("import fs from 'node:fs'; console.log(fs)", { filePath: 'src/renderer/src/example.ts' })
    expect(renderer.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true)
    const [clock] = await eslint.lintText('export const now = () => Date.now()', { filePath: 'src/main/clock/example.ts' })
    expect(clock.errorCount).toBe(0)
  })
})
