import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const deltas = resolve('src/renderer/src/assets/character/taozi/deltas')
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

interface PatchEntry { id: string; baseKey: string; variant: string; rect: [number, number, number, number]; canvas: [number, number]; runtimeSha256: string }
interface Adopted { id: string; kind: string; source: string; runtime: string; runtimeSha256: string }

const manifest = JSON.parse(readFileSync(resolve(deltas, 'manifest.json'), 'utf8')) as {
  approval: string; patches: PatchEntry[]
}
const adopted = JSON.parse(readFileSync(resolve('art/retouch-deltas-adopted.json'), 'utf8')) as { assets: Adopted[] }

describe('face deltas adopted 2026-10-17', () => {
  it('ships 12 local patches (blink / look-up / mouth) with matching runtime hashes', () => {
    expect(manifest.patches).toHaveLength(12)
    for (const patch of manifest.patches) {
      const path = resolve(deltas, `${patch.id}.png`)
      expect(existsSync(path), patch.id).toBe(true)
      expect(hash(path), patch.id).toBe(patch.runtimeSha256)
      const [x, y, w, h] = patch.rect
      const [cw, ch] = patch.canvas
      expect(x >= 0 && y >= 0 && x + w <= cw && y + h <= ch, `${patch.id} rect`).toBe(true)
      // 局部补丁不能是整帧
      expect(w, patch.id).toBeLessThan(cw)
      expect(h, patch.id).toBeLessThan(ch)
    }
  })

  it('ships the 7 full-frame relights (think, 5 night, coast night) with matching hashes', () => {
    const full = adopted.assets.filter((asset) => asset.kind !== 'patch')
    expect(full).toHaveLength(7)
    for (const asset of full) {
      const path = resolve(asset.runtime)
      expect(existsSync(path), asset.runtime).toBe(true)
      expect(hash(path), asset.runtime).toBe(asset.runtimeSha256)
    }
  })

  it('adopts all 19 delivered images (12 patches + 7 full frames)', () => {
    expect(new Set(adopted.assets.map((asset) => asset.id)).size).toBe(19)
    expect(manifest.approval).toContain('2026-10-17')
  })
})
