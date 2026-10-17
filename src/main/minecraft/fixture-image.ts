import { deflateSync } from 'node:zlib'
/** Synthetic sky/ground or bounded noise, never a capture of Minecraft or the user's desktop. */
export function syntheticGamePng(size?: { width: number; height: number; noise?: boolean }) {
  const width = size?.width ?? 16; const height = size?.height ?? 12
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 2048)) throw new Error('SYNTHETIC_IMAGE_LIMIT')
  const rows = Buffer.alloc((width * 4 + 1) * height); let seed = 0x1a2b3c4d
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4
    if (size?.noise) for (let channel = 0; channel < 4; channel++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; rows[offset + channel] = seed & 255 }
    else rows.set(y < 7 ? [90, 160, 220, 255] : [(x + y) % 2 ? 40 : 50, 120, 60, 255], offset)
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
