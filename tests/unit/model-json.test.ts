import { describe, expect, it } from 'vitest'
import { parseModelJson } from '../../src/main/model/parse-json'

describe('model JSON task parsing', () => {
  it('parses a plain JSON object', () => {
    expect(parseModelJson('{"items":[]}')).toEqual({ items: [] })
  })

  it('tolerates a ```json fence', () => {
    expect(parseModelJson('```json\n{"items":[{"quote":"x"}]}\n```')).toEqual({ items: [{ quote: 'x' }] })
  })

  it('tolerates prose before/after one JSON value', () => {
    expect(parseModelJson('Here is the result:\n{"items":[1,2]}\nI did not invent anything.')).toEqual({ items: [1, 2] })
  })

  it('parses JSON arrays and a single fenced scalar', () => {
    expect(parseModelJson('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
    expect(parseModelJson('```json\nnull\n```')).toBeNull()
  })

  it('does not mistake braces inside JSON strings for a second value', () => {
    expect(parseModelJson('{"quote":"a{b}c [d] \\"e\\"","items":[{"x":1}]}')).toEqual({ quote: 'a{b}c [d] "e"', items: [{ x: 1 }] })
  })

  it('rejects two fenced JSON values as ambiguous', () => {
    expect(() => parseModelJson('first:\n```json\n{"items":[]}\n```\nsecond:\n```json\n{"items":[1]}\n```')).toThrow('MODEL_JSON_AMBIGUOUS')
  })

  it('counts a fenced scalar as a second value', () => {
    expect(() => parseModelJson('```json\n{"items":[]}\n```\n```json\nnull\n```')).toThrow('MODEL_JSON_AMBIGUOUS')
    expect(() => parseModelJson('```json\n"retracted"\n```\n```json\n{"items":[]}\n```')).toThrow('MODEL_JSON_AMBIGUOUS')
  })

  it('rejects a fenced value plus a contradicting top-level value', () => {
    expect(() => parseModelJson('```json\n{"items":[]}\n```\n{"items":[1]}')).toThrow('MODEL_JSON_AMBIGUOUS')
  })

  it('rejects a malformed outer container instead of rescuing its inner object', () => {
    expect(() => parseModelJson('{"result":{"kind":"notice"},}')).toThrow('MODEL_JSON_INVALID')
    expect(() => parseModelJson('{"result":{"items":[]},}')).toThrow('MODEL_JSON_INVALID')
    expect(() => parseModelJson('{"result":{"items":[]}')).toThrow('MODEL_JSON_INVALID')
    expect(() => parseModelJson('```json\n{"result":{"kind":"notice"},}\n```')).toThrow('MODEL_JSON_INVALID')
  })

  it('still rejects text with no JSON value', () => {
    expect(() => parseModelJson('I cannot help with that.')).toThrow('MODEL_JSON_INVALID')
  })
})
