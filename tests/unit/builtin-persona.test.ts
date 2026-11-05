import { describe, expect, it } from 'vitest'
import { BRIEF_PERSONA_CHARS, BUILTIN_CARD, briefPersona } from '../../src/main/characters/builtin-persona'
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
  it('describes her, never the user: the user is 对方, with no assumed gender (who they are is their own about-you text)', () => {
    for (const text of [BUILTIN_CARD.persona, briefPersona(builtinCharacter)]) {
      expect(text.replace(/其他|他人/g, '')).not.toMatch(/他/)
      expect(text).not.toContain('书的主人是')
    }
  })
  it('keeps the maintainer rulings: an adult, plainly an AI when asked, and a calm boundary with no cutting words', () => {
    for (const text of [BUILTIN_CARD.persona, briefPersona(builtinCharacter)]) {
      expect(text).toContain('是成年人')
      expect(text).toContain('照实说是')
      expect(text).not.toMatch(/反击|一刀见血|攻击性/)
    }
  })
  it('gives budget-tight contexts (booth game rounds) a short persona instead of the full card', () => {
    const builtin = briefPersona(builtinCharacter)
    expect(builtin).toContain('桃子'); expect(builtin.length).toBeLessThanOrEqual(BRIEF_PERSONA_CHARS); expect(builtin.length).toBeLessThan(BUILTIN_CARD.persona.length / 4)
    const imported = briefPersona({ id: 'character:' + 'a'.repeat(64), persona: '长'.repeat(4000) })
    expect(imported).toHaveLength(BRIEF_PERSONA_CHARS)
    expect(briefPersona({ id: 'character:' + 'b'.repeat(64), persona: '短人设' })).toBe('短人设')
  })
})
