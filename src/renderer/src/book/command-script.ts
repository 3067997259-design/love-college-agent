/** Read-only approval aid. Never evaluate or rewrite the command that main will execute. */
export function commandScriptPreview(command: string): string | null {
  const encoded = /^powershell(?:\.exe)?\s+(?:(?:-NoLogo|-NoProfile|-NonInteractive)\s+)*-EncodedCommand\s+([a-z0-9+/]+={0,2})\s*$/i.exec(command.trim())?.[1]
  if (!encoded || encoded.length > 6000) return null
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
    const script = new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    return [...script].map((char) => { const n = char.codePointAt(0)!; return n < 32 && ![9, 10, 13].includes(n) || n === 127 || n >= 0x202a && n <= 0x202e || n >= 0x2066 && n <= 0x2069 ? '\\u' + n.toString(16).padStart(4, '0') : char }).join('')
  } catch { return null }
}
