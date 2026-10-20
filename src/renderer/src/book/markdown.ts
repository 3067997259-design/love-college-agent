/**
 * 她的话里的简单 Markdown（受过 harness 训练的模型习惯这样写）。只认常用的几种：段落、标题、列表、引用、
 * 代码块、表格、分隔线，以及行内的代码、粗体、斜体、删除线、链接和 $公式$（只去掉符号，不排版公式）。
 *
 * 无损：原文的每个字符都留在结果里，语法符号记作 mark（界面隐藏，但仍在 DOM 文字里）。所以从渲染后的文字
 * 取的偏移量就是原文的偏移量，旧页按偏移量引用原文不受影响。链接只显示文字，不跳转。
 */
export type MdInline =
  | { t: 'text'; s: string }
  | { t: 'mark'; s: string }
  | { t: 'code'; s: string }
  | { t: 'math'; s: string }
  | { t: 'strong' | 'em' | 'del'; c: MdInline[] }
  | { t: 'link'; url: string; c: MdInline[] }
export type MdRow = { cells: MdInline[][]; head: boolean; hidden: boolean }
export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: number; c: MdInline[] }
  | { t: 'li'; ordered: boolean; depth: number; c: MdInline[] }
  | { t: 'quote'; c: MdInline[] }
  | { t: 'code'; lang: string; open: string; body: string; close: string }
  | { t: 'hr'; s: string }
  | { t: 'table'; rows: MdRow[] }
  | { t: 'gap'; s: string }

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
const HEADING = /^(\s{0,3}#{1,6}\s+)([^\n]*)$/
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])(\s+)([^\n]*)$/
const QUOTE = /^(\s{0,3}>\s?)([^\n]*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const blank = (line: string) => line.trim() === ''
const leadOf = (line: string) => line.slice(0, line.length - line.trimStart().length)
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || HR.test(line) || ITEM.test(line) || QUOTE.test(line)
const isTableStart = (lines: readonly string[], i: number) => lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('|')

// 行内：找最早出现的一种写法；粗体、斜体、删除线和链接里面再解析一层。不认下划线写法，免得误伤 snake_case。
const INLINE: { re: RegExp; make(m: RegExpExecArray): MdInline[] }[] = [
  { re: /`([^`\n]+)`/g, make: (m) => [{ t: 'mark', s: '`' }, { t: 'code', s: m[1] }, { t: 'mark', s: '`' }] },
  { re: /\*\*(?=\S)([^\n]+?)(?<=\S)\*\*/g, make: (m) => [{ t: 'mark', s: '**' }, { t: 'strong', c: parseInline(m[1]) }, { t: 'mark', s: '**' }] },
  { re: /~~(?=\S)([^\n]+?)(?<=\S)~~/g, make: (m) => [{ t: 'mark', s: '~~' }, { t: 'del', c: parseInline(m[1]) }, { t: 'mark', s: '~~' }] },
  { re: /(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g, make: (m) => [{ t: 'mark', s: '*' }, { t: 'em', c: parseInline(m[1]) }, { t: 'mark', s: '*' }] },
  // 行内公式：开头后、结尾前都不是空格，结尾后不跟数字（照 pandoc 的规矩），免得把“$5 和 $10”当成公式
  { re: /(?<![\w$])\$(?=[^\s$])([^$\n]+?)(?<=[^\s$])\$(?!\d)/g, make: (m) => [{ t: 'mark', s: '$' }, { t: 'math', s: m[1] }, { t: 'mark', s: '$' }] },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)\)/g, make: (m) => [{ t: 'mark', s: '[' }, { t: 'link', url: m[2], c: parseInline(m[1]) }, { t: 'mark', s: `](${m[2]})` }] },
]

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = []
  let pos = 0
  while (pos < text.length) {
    let best: { m: RegExpExecArray; make: (m: RegExpExecArray) => MdInline[] } | undefined
    for (const rule of INLINE) {
      rule.re.lastIndex = pos
      const m = rule.re.exec(text)
      if (m && (!best || m.index < best.m.index)) best = { m, make: rule.make }
    }
    if (!best) break
    if (best.m.index > pos) out.push({ t: 'text', s: text.slice(pos, best.m.index) })
    out.push(...best.make(best.m))
    pos = best.m.index + best.m[0].length
  }
  if (pos < text.length) out.push({ t: 'text', s: text.slice(pos) })
  return out
}

/** 表格一行：竖线记作 mark，单元格内容照常解析；行尾的换行也藏在最后一格里。 */
function tableRow(line: string, tail: string, head: boolean, hidden: boolean): MdRow {
  if (hidden) return { cells: [[{ t: 'mark', s: line + tail }]], head, hidden }
  const parts = line.split('|')
  const lead = parts.length > 1 && parts[0].trim() === '' ? parts.shift()! + '|' : ''
  const trail = parts.length > 1 && parts[parts.length - 1].trim() === '' ? '|' + parts.pop()! : ''
  const cells = parts.map((part, index) => [
    ...(index === 0 && lead ? [{ t: 'mark' as const, s: lead }] : []),
    ...(index > 0 ? [{ t: 'mark' as const, s: '|' }] : []),
    ...parseInline(part),
    ...(index === parts.length - 1 ? [{ t: 'mark' as const, s: trail + tail }] : []),
  ])
  return { cells, head, hidden }
}

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split('\n')
  const blocks: MdBlock[] = []
  const gap = (s: string) => { if (!s) return; const last = blocks.at(-1); if (last?.t === 'gap') last.s += s; else blocks.push({ t: 'gap', s }) }
  let i = 0
  while (i < lines.length) {
    if (i > 0) gap('\n')
    const line = lines[i]
    if (blank(line)) { gap(line); i++; continue }
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1]
      let end = i + 1
      while (end < lines.length && !(lines[end].trim().startsWith(marker[0].repeat(marker.length)) && FENCE.test(lines[end]) && !FENCE.exec(lines[end])![2])) end++
      const closed = end < lines.length
      const body = lines.slice(i + 1, end)
      blocks.push({ t: 'code', lang: fence[2], open: line + (body.length || closed ? '\n' : ''), body: body.join('\n'), close: closed ? (body.length ? '\n' : '') + lines[end] : '' })
      i = closed ? end + 1 : end
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) { blocks.push({ t: 'h', level: heading[1].trim().length, c: [{ t: 'mark', s: heading[1] }, ...parseInline(heading[2])] }); i++; continue }
    if (HR.test(line)) { blocks.push({ t: 'hr', s: line }); i++; continue }
    if (isTableStart(lines, i)) {
      let end = i + 2
      while (end < lines.length && lines[end].includes('|') && !blank(lines[end])) end++
      // 行与行之间的换行藏在上一行的末格里；最后一行之后的换行留给块之间的间隔。
      blocks.push({ t: 'table', rows: lines.slice(i, end).map((row, index) => tableRow(row, i + index < end - 1 ? '\n' : '', index === 0, index === 1)) })
      i = end
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      const indent = item[1].length
      const ordered = /\d/.test(item[2])
      // 有序列表的序号照原样显示；无序的符号藏起来，由界面画圆点
      const marker: MdInline[] = ordered ? [{ t: 'text', s: item[2] + item[3] }] : [{ t: 'mark', s: item[2] + item[3] }]
      const c: MdInline[] = [...(indent ? [{ t: 'mark' as const, s: item[1] }] : []), ...marker, ...parseInline(item[4])]
      let end = i + 1
      // 缩进的下一行（不是新的列表项）算这一项的续行
      while (end < lines.length && !blank(lines[end]) && leadOf(lines[end]).length > indent && !startsBlock(lines[end])) {
        const lead = leadOf(lines[end])
        c.push({ t: 'text', s: '\n' }, { t: 'mark', s: lead }, ...parseInline(lines[end].slice(lead.length)))
        end++
      }
      blocks.push({ t: 'li', ordered, depth: Math.min(3, Math.floor(indent / 2)), c })
      i = end
      continue
    }
    if (QUOTE.test(line)) {
      const c: MdInline[] = []
      let end = i
      while (end < lines.length && QUOTE.test(lines[end])) {
        const m = QUOTE.exec(lines[end])!
        if (end > i) c.push({ t: 'text', s: '\n' })
        c.push({ t: 'mark', s: m[1] }, ...parseInline(m[2]))
        end++
      }
      blocks.push({ t: 'quote', c })
      i = end
      continue
    }
    const c: MdInline[] = []
    let end = i
    while (end < lines.length && !blank(lines[end]) && (end === i || (!startsBlock(lines[end]) && !isTableStart(lines, end)))) {
      if (end > i) c.push({ t: 'text', s: '\n' })
      c.push(...parseInline(lines[end]))
      end++
    }
    blocks.push({ t: 'p', c })
    i = end
  }
  return blocks
}

/** 只有一段普通文字（没有块级写法）时，界面可以照旧按一行行内文字排。 */
export const isPlainParagraph = (blocks: readonly MdBlock[]) => blocks.filter((block) => block.t !== 'gap').length <= 1 && blocks.every((block) => block.t === 'gap' || block.t === 'p')

/** 拼回原文：测试用来确认无损。 */
export function sourceOf(blocks: readonly MdBlock[]): string {
  const inline = (nodes: readonly MdInline[]): string => nodes.map((node) => 'c' in node ? inline(node.c) : node.s).join('')
  return blocks.map((block) => {
    switch (block.t) {
      case 'code': return block.open + block.body + block.close
      case 'hr': case 'gap': return block.s
      case 'table': return block.rows.map((row) => row.cells.map(inline).join('')).join('')
      default: return inline(block.c)
    }
  }).join('')
}
