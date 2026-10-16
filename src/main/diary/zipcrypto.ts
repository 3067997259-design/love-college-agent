import { randomBytes } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
const table = Array.from({ length: 256 }, (_, value) => { let n = value; for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0 })
const update = (crc: number, byte: number) => (table[(crc ^ byte) & 255] ^ crc >>> 8) >>> 0
const crc32 = (bytes: Buffer) => (~bytes.reduce((crc, byte) => update(crc, byte), 0xffffffff)) >>> 0
function cipher(password: string) {
  let a = 0x12345678; let b = 0x23456789; let c = 0x34567890
  const next = (byte: number) => { a = update(a, byte); b = (Math.imul((b + (a & 255)) >>> 0, 134775813) + 1) >>> 0; c = update(c, b >>> 24) }
  for (const byte of Buffer.from(password, 'utf8')) next(byte)
  const mask = () => { const temp = (c | 2) & 0xffff; return Math.imul(temp, temp ^ 1) >>> 8 & 255 }
  return { encrypt: (byte: number) => { const out = byte ^ mask(); next(byte); return out }, decrypt: (byte: number) => { const out = byte ^ mask(); next(out); return out } }
}
/** Single-entry PKWARE traditional-encryption ZIP, independent implementation of APPNOTE section 6.1. */
export function encryptDiaryZip(text: string, password: string, day: string) {
  const content = Buffer.from(text); if (content.length > 16000 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('DIARY_INVALID')
  const checksum = crc32(content); const header = randomBytes(12); header[11] = checksum >>> 24
  const crypto = cipher(password); const data = Buffer.from(Buffer.concat([header, deflateRawSync(content)]).map(crypto.encrypt)); const filename = Buffer.from(day + '.md')
  const [year, month, date] = day.split('-').map(Number); const dosDate = (Math.min(2107, Math.max(1980, year)) - 1980) << 9 | month << 5 | date
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x801, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); local.subarray(4, 28).copy(central, 6)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16)
  return Buffer.concat([local, filename, data, central, filename, end])
}
export function decryptDiaryZip(bytes: Buffer, password: string) {
  if (bytes.length < 100 || bytes.length > 32000 || bytes.readUInt32LE(0) !== 0x04034b50 || bytes.readUInt16LE(6) !== 0x801 || bytes.readUInt16LE(8) !== 8 || bytes.readUInt32LE(22) > 16000) throw new Error('DIARY_INVALID')
  const offset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28); const size = bytes.readUInt32LE(18)
  if (offset + size > bytes.length || size < 12) throw new Error('DIARY_INVALID')
  const crypto = cipher(password); const plain = Buffer.from(bytes.subarray(offset, offset + size).map(crypto.decrypt))
  if (plain[11] !== bytes.readUInt32LE(14) >>> 24) throw new Error('DIARY_INVALID')
  const content = inflateRawSync(plain.subarray(12), { maxOutputLength: 16000 }); if (content.length !== bytes.readUInt32LE(22) || crc32(content) !== bytes.readUInt32LE(14)) throw new Error('DIARY_INVALID')
  return content.toString('utf8')
}
