import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppCommand, CharacterPackView, PublicErrorCode } from '../../shared'
import type { SettingsStore } from '../config/settings'
import type { BinaryAssets, BinaryAsset } from '../storage/assets'
import { assetUrl } from '../storage/assets'
import type { CharacterLibrary } from './library'
import { exportCharacterPackage, parseCharacterPackage, type CharacterDefinition } from './package'
import { BUILTIN_CARD } from './builtin-persona'
export const builtinCharacter = { id: 'default-character', name: BUILTIN_CARD.name, persona: BUILTIN_CARD.persona, images: {} as Record<string, BinaryAsset> }
export function createCharacterService(options: { library: CharacterLibrary; active: CharacterDefinition | typeof builtinCharacter; settings: SettingsStore; assets: BinaryAssets; normalizePng(bytes: Buffer): Buffer; exportBuiltin?(): Promise<Buffer>; busy(): boolean; chooseImport(): Promise<string | null>; chooseExport(): Promise<string | null>; changed(): void }) {
  let status: CharacterPackView['status'] = 'idle'; let worker: Promise<void> | undefined
  const run = (state: typeof status, work: () => Promise<void>) => { status = state; options.changed(); worker = work().catch(() => { status = 'failed' }).finally(() => { worker = undefined; if (status !== 'failed') status = 'idle'; options.changed() }) }
  return {
    view: (): CharacterPackView => { const selectedId = options.settings.read().activeCharacterId ?? 'default-character'; return { activeId: options.active.id, name: options.active.name, images: Object.fromEntries(Object.entries(options.active.images).filter(([, asset]) => options.assets.has(asset)).map(([slot, asset]) => [slot, assetUrl(asset)])), installed: [{ id: 'default-character', name: '桃子', builtin: true }, ...options.library.list()], status, restartRequired: selectedId !== options.active.id, selectedId } },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (worker || options.busy()) return 'unavailable'
      if (command.type === 'character.select') { if (command.characterId !== 'default-character') { try { options.library.read(command.characterId) } catch { return 'invalid-command' } }; options.settings.update((draft) => { draft.activeCharacterId = command.characterId }); options.changed(); return }
      if (command.type === 'character.import') { run('importing', async () => { const file = await options.chooseImport(); if (!file) return; const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error('CHARACTER_INVALID'); const parsed = await parseCharacterPackage(readFileSync(file), options.normalizePng); options.library.install(parsed, options.assets) }); return }
      if (command.type === 'character.export') { run('exporting', async () => { const file = await options.chooseExport(); if (!file) return; if (realpathSync(dirname(file)) !== dirname(file) || existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1)) throw new Error('CHARACTER_INVALID'); const bytes = options.active.id === 'default-character' && options.exportBuiltin ? await options.exportBuiltin() : await exportCharacterPackage(options.active, options.assets.read); const temporary = file + '.' + randomUUID() + '.tmp'; writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file) }); return }
      return 'invalid-command'
    }, close: async () => { await worker }, idle: async () => { await worker },
  }
}
export type CharacterService = ReturnType<typeof createCharacterService>
