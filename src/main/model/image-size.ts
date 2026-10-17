/** Read dimensions before any native decoder allocates a bitmap. No metadata is retained. */
export function imageSize(bytes: Buffer, format: 'png' | 'jpeg'): { width: number; height: number } {
  if (format === 'png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('IMAGE_INVALID')
    return positive(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw new Error('IMAGE_INVALID')
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9 || marker === undefined) break
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) break
      return positive(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
    }
    offset += length
  }
  throw new Error('IMAGE_INVALID')
}
function positive(width: number, height: number) { if (!width || !height) throw new Error('IMAGE_INVALID'); return { width, height } }
