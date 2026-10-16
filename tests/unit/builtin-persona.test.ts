import { describe, expect, it } from 'vitest'
import { BUILTIN_CARD } from '../../src/main/characters/builtin-persona'
import { characterManifest } from '../../src/main/characters/package'
import { builtinCharacter } from '../../src/main/characters/service'

describe('built-in character card', () => {
  it('fits the character package format so the built-in export carries it', () => {
    expect(BUILTIN_CARD.persona.length).toBeGreaterThan(200)
    expect(characterManifest.parse({ formatVersion: 1, kind: 'lca-character', name: BUILTIN_CARD.name, persona: BUILTIN_CARD.persona, images: {} }).persona).toBe(BUILTIN_CARD.persona)
    expect(builtinCharacter).toMatchObject({ id: 'default-character', name: '桃子', persona: BUILTIN_CARD.persona })
  })
  it('keeps the adaptation clean: no source-card name or AIRI stage markup', () => {
    for (const marker of ['ReLU', '<|ACT', '<|DELAY', '<|CALL', 'mirror']) expect(BUILTIN_CARD.persona).not.toContain(marker)
  })
})
