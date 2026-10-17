/**
 * 模型 JSON 任务的容错解析：只允许说明文字或代码围栏包裹**恰好一个**完整 JSON 值。
 * - 明确围栏里必须是恰好一个合法 JSON（对象/数组/标量）；
 * - 多份围栏、围栏内外各一份、多个顶层容器都失败关闭；
 * - 坏外层（trailing comma、截断）不得把内部子对象“救回”成顶层结果。
 * 不猜第一段/最后一段，也不合并；schema 与业务接地校验保持不变。
 */
type Parsed = { ok: true; value: unknown } | { ok: false }
const tryParse = (text: string): Parsed => {
  try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false } }
}
const balancedEnd = (text: string, start: number): number => {
  const stack: string[] = []; let inString = false; let escaped = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; continue }
    if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (!stack.length) return -1
      stack.pop()
      if (!stack.length) return index
    }
  }
  return -1
}
/** Scan top-level containers. A malformed outer container is fatal; we never descend into a failed outer. */
const scanContainers = (text: string): unknown[] => {
  const values: unknown[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char !== '{' && char !== '[') continue
    const end = balancedEnd(text, index)
    if (end < 0) throw new Error('MODEL_JSON_INVALID')
    const parsed = tryParse(text.slice(index, end + 1))
    if (!parsed.ok) throw new Error('MODEL_JSON_INVALID')
    values.push(parsed.value)
    index = end
  }
  return values
}
const FENCE = /```(?:json)?\s*([\s\S]*?)```/gi
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const direct = tryParse(trimmed)
  if (direct.ok) return direct.value
  const fences = [...text.matchAll(FENCE)]
  if (fences.length) {
    if (fences.length > 1) throw new Error('MODEL_JSON_AMBIGUOUS')
    const fenced = tryParse(fences[0][1].trim())
    if (!fenced.ok) throw new Error('MODEL_JSON_INVALID')
    // A second JSON value outside the fence is still ambiguous.
    const outside = scanContainers(text.replace(FENCE, '\n'))
    if (outside.length) throw new Error('MODEL_JSON_AMBIGUOUS')
    return fenced.value
  }
  const values = scanContainers(text)
  if (values.length === 1) return values[0]
  throw new Error(values.length > 1 ? 'MODEL_JSON_AMBIGUOUS' : 'MODEL_JSON_INVALID')
}
