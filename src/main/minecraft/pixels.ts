import { nativeImage } from 'electron'
import { imageSize } from '../model/image-size'

/** Source PNG headers have already passed checkedScreenshot before native decoding. */
export function normalizeGamePixels(png: Buffer) {
  const declared = imageSize(png, 'png')
  if (declared.width > 4096 || declared.height > 2304 || png.length > 6_291_456) throw new Error('GAME_IMAGE_LIMIT')
  const image = nativeImage.createFromBuffer(png); const size = image.getSize()
  if (image.isEmpty() || size.width !== declared.width || size.height !== declared.height) throw new Error('GAME_IMAGE_INVALID')
  const scale = Math.min(1, 800 / size.width, 600 / size.height)
  const width = Math.max(1, Math.round(size.width * scale)); const height = Math.max(1, Math.round(size.height * scale))
  const resized = image.resize({ width, height, quality: 'good' }); let jpeg = resized.toJPEG(70)
  if (jpeg.length > 262144) jpeg = resized.toJPEG(45)
  if (jpeg.length > 262144 || !jpeg.length) throw new Error('GAME_IMAGE_LIMIT')
  return { jpeg, width, height }
}
