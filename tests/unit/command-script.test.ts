import { expect, it } from 'vitest'
import { commandScriptPreview } from '../../src/renderer/src/book/command-script'
it('makes a Unicode PowerShell encoded command reviewable without executing it', () => {
  const source = "[IO.File]::WriteAllText('hello.txt','你好😀'); 'value\u202e'"
  const command = 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(source, 'utf16le').toString('base64')
  expect(commandScriptPreview(command)).toBe(source.replace('\u202e', '\\u202e'))
  expect(commandScriptPreview('echo literal')).toBeNull(); expect(commandScriptPreview(command + ' & echo extra')).toBeNull()
  expect(commandScriptPreview('powershell -EncodedCommand /w==')).toBeNull()
})
