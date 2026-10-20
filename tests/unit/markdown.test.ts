import { describe, expect, it } from 'vitest'
import { isPlainParagraph, parseInline, parseMarkdown, sourceOf } from '../../src/renderer/src/book/markdown'

const kinds = (text: string) => parseMarkdown(text).filter((block) => block.t !== 'gap').map((block) => block.t)

describe('book markdown', () => {
  const samples = [
    '',
    '就一句话。',
    '第一行\n第二行',
    '\n\n前后有空行\n\n',
    '脚本写好了，存在 `count.js` 里。\n\n运行结果：**148** 个。',
    '## 做了什么\n- 写了 `a.js`\n- 跑了测试\n  通过了\n\n1. 第一步\n2. 第二步',
    '```js\nconsole.log(1)\n\nconsole.log(2)\n```\n结尾',
    '```\n没写完的代码',
    '```',
    '| 文件 | 行数 |\n| --- | ---: |\n| a.js | 12 |\n| b.js | 3 |\n\n表格后',
    '> 引用一\n> 引用二\n正文',
    '上面\n\n---\n\n下面',
    '看 [文档](https://example.com/a_b) 和 *这里*、~~旧的~~。',
    'snake_case_name 和 2*3*4 不是格式',
    '**没闭合的粗体 和 `没闭合的代码',
    'Windows 换行\r\n## 标题\r\n- 项\r\n',
    '- 项\n没有缩进的下一行',
    '隔板法：$C(12, 2) = 66$，价格从 $5 到 $10',
  ]
  it('keeps every source character, so offsets on the page are offsets in the text', () => {
    for (const text of samples) expect(sourceOf(parseMarkdown(text))).toBe(text)
  })

  it('recognises the blocks models usually write', () => {
    expect(kinds('就一句话。')).toEqual(['p'])
    expect(kinds('## 做了什么\n- 写了 `a.js`\n- 跑了测试\n  通过了\n\n1. 第一步')).toEqual(['h', 'li', 'li', 'li'])
    expect(kinds('```js\nconsole.log(1)\n```\n结尾')).toEqual(['code', 'p'])
    expect(kinds('| 文件 | 行数 |\n| --- | --- |\n| a.js | 12 |')).toEqual(['table'])
    expect(kinds('> 引用\n正文')).toEqual(['quote', 'p'])
    expect(kinds('上面\n\n---\n\n下面')).toEqual(['p', 'hr', 'p'])
    expect(kinds('- 项\n没有缩进的下一行')).toEqual(['li', 'p'])
    const code = parseMarkdown('```js\nconsole.log(1)\n```')[0]
    expect(code).toMatchObject({ t: 'code', lang: 'js', body: 'console.log(1)' })
    const item = parseMarkdown('1. 第一步')[0]
    expect(item).toMatchObject({ t: 'li', ordered: true, depth: 0 })
    const table = parseMarkdown('| 文件 | 行数 |\n| --- | --- |\n| a.js | 12 |')[0]
    expect(table.t === 'table' && table.rows.map((row) => [row.head, row.hidden, row.cells.length])).toEqual([[true, false, 2], [false, true, 1], [false, false, 2]])
  })

  it('formats inline code, emphasis and links but leaves identifiers alone', () => {
    const shape = (text: string) => parseInline(text).filter((node) => node.t !== 'mark').map((node) => node.t)
    expect(shape('存在 `count.js` 里')).toEqual(['text', 'code', 'text'])
    expect(shape('**148** 个')).toEqual(['strong', 'text'])
    expect(shape('看 *这里*')).toEqual(['text', 'em'])
    expect(shape('[文档](https://example.com)')).toEqual(['link'])
    expect(shape('snake_case_name 和 2*3*4')).toEqual(['text'])
    expect(shape('**没闭合')).toEqual(['text'])
    expect(shape('总解数是 $C(12, 2) = 66$，去掉 3 种')).toEqual(['text', 'math', 'text'])
    expect(shape('从 $5 涨到 $10')).toEqual(['text'])
    expect(shape('US$5 和 $x$')).toEqual(['text', 'math'])
  })

  it('lets a plain message stay one line of inline text', () => {
    expect(isPlainParagraph(parseMarkdown('就一句话，带 `代码` 和 **粗体**。'))).toBe(true)
    expect(isPlainParagraph(parseMarkdown('第一行\n第二行'))).toBe(true)
    expect(isPlainParagraph(parseMarkdown('第一段\n\n第二段'))).toBe(false)
    expect(isPlainParagraph(parseMarkdown('- 项'))).toBe(false)
  })
})
