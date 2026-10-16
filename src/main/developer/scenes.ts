import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { Clock } from '../clock'
import type { SettingsStore } from '../config/settings'
import { scriptSchema } from './model'
import fixture from './responses.json'

/** Zero-circle fixture format; full private .lca-save backup belongs to circle one. */
export const sceneSchema = z.strictObject({ formatVersion: z.literal(1), kind: z.literal('development-fixture'),
  clock: z.strictObject({ nowMs: z.number().int().min(0).max(8_640_000_000_000_000), rate: z.number().min(0.01).max(3600), frozen: z.boolean() }),
  mode: z.enum(['work', 'quiet', 'rest']), modelScript: scriptSchema,
  preset: z.enum(['empty', 'clock-tool', 'pomodoro-demo']),
})
export type DevelopmentScene = z.infer<typeof sceneSchema>
export function developmentProfile(root: string, settings: SettingsStore) {
  let id = settings.read().sceneId
  if (!id) { id = randomUUID(); settings.update((draft) => { draft.sceneId = id }) }
  return { id, path: join(root, 'developer', id) }
}
export function readScene(root: string): DevelopmentScene | undefined {
  const path = join(root, 'scene.json')
  if (!existsSync(path)) return
  try { return sceneSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { throw new Error('DEVELOPMENT_SCENE_INVALID') }
}
export function stageScene(root: string, settings: SettingsStore, input: unknown) {
  const scene = sceneSchema.parse(input); const id = randomUUID(); const path = join(root, 'developer', id)
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'scene.json'), JSON.stringify(scene), { mode: 0o600 })
  settings.update((draft) => { draft.sceneId = id })
  return id
}
export function presetScene(preset: DevelopmentScene['preset'], clock: Clock): DevelopmentScene {
  return { formatVersion: 1, kind: 'development-fixture', clock: { nowMs: Math.round(clock.nowMs()), rate: 1, frozen: false },
    mode: 'rest', modelScript: preset === 'clock-tool' ? fixture.clock : [], preset }
}
