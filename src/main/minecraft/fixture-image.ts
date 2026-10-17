import { deflateSync } from 'node:zlib'
/** Tiny synthetic sky/ground fixture, not a screenshot of Minecraft or the user's desktop. */
export function syntheticGamePng() {
  const width = 16; const height = 12; const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4
    rows.set(y < 7 ? [90, 160, 220, 255] : [(x + y) % 2 ? 40 : 50, 120, 60, 255], offset)
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const chunk = (name: string, bytes: Buffer) => {
    const encoded = Buffer.concat([Buffer.from(name), bytes]); let crc = 0xffffffff
    for (const byte of encoded) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([length, encoded, checksum])
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
