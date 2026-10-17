/**
 * 模型 JSON 任务（记忆抽取/摘要、隐私字段、日记、分身……）的容错解析：
 * 有些真实模型会把 JSON 包在 ```json 围栏里，或在前后带一句说明；模型一轮的输出仍只允许一个 JSON 值。
 * 只在解析层容错，schema 校验与业务校验保持不变。
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [trimmed]
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = trimmed.indexOf(open)
    const end = trimmed.lastIndexOf(close)
    if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1))
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch { /* try next */ }
  }
  throw new Error('MODEL_JSON_INVALID')
}
