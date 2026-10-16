import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { definitionId, definitionSchema, type CharacterDefinition } from './package'
import type { BinaryAssets } from '../storage/assets'
export function createCharacterLibrary(root: string) {
  const folder = join(resolve(root), 'characters'); mkdirSync(folder, { recursive: true })
  const check = () => { if (lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== folder) throw new Error('CHARACTER_INVALID') }
  const read = (id: string) => {
    check(); if (!/^character:[a-f0-9]{64}$/.test(id)) throw new Error('CHARACTER_INVALID'); const file = join(folder, id.slice(10) + '.json'); const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32000) throw new Error('CHARACTER_INVALID')
    const definition = definitionSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); if (definition.id !== id || definitionId(definition) !== id) throw new Error('CHARACTER_INVALID'); return definition
  }
  return { read,
    list: () => { check(); return readdirSync(folder).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 100).flatMap((name) => { try { const value = read('character:' + name.slice(0, -5)); return [{ id: value.id, name: value.name, builtin: false }] } catch { return [] } }) },
    install: (input: { name: string; persona: string; images: Record<string, Buffer> }, assets: BinaryAssets): CharacterDefinition => {
      check(); const images = Object.fromEntries(Object.entries(input.images).map(([slot, image]) => [slot, assets.write(image, 'png')]))
      const fields = { name: input.name, persona: input.persona, images }; const definition = definitionSchema.parse({ ...fields, id: definitionId(fields) }); const target = join(folder, definition.id.slice(10) + '.json')
      if (existsSync(target)) { read(definition.id); return definition }
      const temporary = join(folder, '.' + randomUUID() + '.tmp'); writeFileSync(temporary, JSON.stringify(definition), { flag: 'wx', mode: 0o600 }); renameSync(temporary, target); return definition
    },
  }
}
export type CharacterLibrary = ReturnType<typeof createCharacterLibrary>
