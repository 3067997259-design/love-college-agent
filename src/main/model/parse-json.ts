/**
 * 模型 JSON 任务的容错解析：允许说明文字或 ```json 围栏包裹**一个**完整 JSON 值。
 * 发现两个及以上顶层 JSON 值就失败关闭（不猜第一段/最后一段，也不合并），避免歧义回复被当成成功。
 * 解析层只负责挑值；schema 与业务接地校验保持不变。
 */
const parseSingle = (text: string): { ok: true; value: unknown } | { ok: false } => {
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
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const direct = parseSingle(trimmed)
  if (direct.ok) return direct.value
  const values: unknown[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char !== '{' && char !== '[') continue
    const end = balancedEnd(text, index)
    if (end < 0) continue
    const candidate = parseSingle(text.slice(index, end + 1))
    if (!candidate.ok) continue
    values.push(candidate.value)
    index = end
  }
  if (values.length === 1) return values[0]
  throw new Error(values.length > 1 ? 'MODEL_JSON_AMBIGUOUS' : 'MODEL_JSON_INVALID')
}
