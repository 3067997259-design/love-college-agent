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

  it('parses JSON arrays', () => {
    expect(parseModelJson('```\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
  })

  it('still rejects text with no JSON value', () => {
    expect(() => parseModelJson('I cannot help with that.')).toThrow('MODEL_JSON_INVALID')
  })
})
