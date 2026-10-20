import { Fragment, useMemo, type ReactNode } from 'react'
import type { MessageView } from '../../../shared'
import { isPlainParagraph, parseMarkdown, type MdBlock, type MdInline } from './markdown'
import questionWords from '../voice/questions.zh.json'

/** 语法符号留在 DOM 里但不显示：选中和引用时的偏移量仍对得上原文。 */
const Mark = ({ s }: { s: string }) => <span className="md-mark" aria-hidden>{s}</span>

function Inline({ nodes }: { nodes: readonly MdInline[] }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.t) {
      case 'text': return <Fragment key={index}>{node.s}</Fragment>
      case 'mark': return <Mark key={index} s={node.s} />
      case 'code': return <code key={index} className="md-code">{node.s}</code>
      case 'math': return <span key={index} className="md-math">{node.s}</span>
      case 'strong': return <strong key={index}><Inline nodes={node.c} /></strong>
      case 'em': return <em key={index}><Inline nodes={node.c} /></em>
      case 'del': return <del key={index}><Inline nodes={node.c} /></del>
      // 链接只显示文字，地址放在悬停提示里；书里不跳转
      case 'link': return <span key={index} className="md-link" title={node.url}><Inline nodes={node.c} /></span>
    }
  })
}

function Block({ block }: { block: MdBlock }): ReactNode {
  switch (block.t) {
    case 'gap': return <Mark s={block.s} />
    case 'p': return <div className="md-p"><Inline nodes={block.c} /></div>
    case 'h': return <div className="md-h" data-level={block.level}><Inline nodes={block.c} /></div>
    case 'li': return <div className="md-li" data-ordered={block.ordered} data-depth={block.depth}><Inline nodes={block.c} /></div>
    case 'quote': return <blockquote className="md-quote"><Inline nodes={block.c} /></blockquote>
    case 'hr': return <div className="md-hr"><Mark s={block.s} /></div>
    case 'code': return (
      <pre className="md-pre" data-lang={block.lang || undefined}><Mark s={block.open} /><code>{block.body}</code><Mark s={block.close} /></pre>
    )
    case 'table': {
      const [head, ...rest] = block.rows
      const row = (cells: MdInline[][], index: number, hidden: boolean, Cell: 'th' | 'td') => (
        <tr key={index} className={hidden ? 'md-mark-row' : undefined}>{cells.map((cell, at) => <Cell key={at}><Inline nodes={cell} /></Cell>)}</tr>
      )
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>{row(head.cells, 0, false, 'th')}</thead>
            <tbody>{rest.map((item, index) => row(item.cells, index + 1, item.hidden, 'td'))}</tbody>
          </table>
        </div>
      )
    }
  }
}

/**
 * 她的话：一段普通文字时仍是行内文字（外层可以照旧是 <p>）；有列表、代码块这些时返回块级内容，
 * 调用方要换成块级容器，见 `richText`。
 */
export function useMarkdown(text: string) {
  return useMemo(() => {
    const blocks = parseMarkdown(text)
    return { blocks, plain: isPlainParagraph(blocks) }
  }, [text])
}

function MarkdownBody({ blocks, plain }: { blocks: readonly MdBlock[]; plain: boolean }): ReactNode {
  if (plain) return blocks.map((block, index) => block.t === 'p' ? <span key={index} className="md-line"><Inline nodes={block.c} /></span> : <Block key={index} block={block} />)
  return blocks.map((block, index) => <Block key={index} block={block} />)
}

/** `.msg-text`：她的话按 Markdown 排（行内时是 span，有块级内容时是 div）；其他人的话照原文。 */
export function MsgText({ md, text, onMouseUp }: { md: ReturnType<typeof useMarkdown> | null; text: string; onMouseUp?: React.MouseEventHandler<HTMLElement> }) {
  if (!md) return <span className="msg-text" onMouseUp={onMouseUp}>{text}</span>
  if (md.plain) return <span className="msg-text md" onMouseUp={onMouseUp}><MarkdownBody {...md} /></span>
  return <div className="msg-text md" onMouseUp={onMouseUp}><MarkdownBody {...md} /></div>
}

/**
 * 权限请求是 LCA 替她问你的，不是她说的话：排成一张铅笔框的纸签，不带她的圆点和墨色；
 * 你点的选项排成一行"你选了"，不当成你打的一句话。
 */
export function ApprovalMessage({ view, time }: { view: MessageView; time: string }) {
  if (view.kind === 'approval-answer') return <p className="msg msg-approval-answer" data-kind="approval-answer">{fill(questionWords.approvalChosen, view.text)}<time className="msg-time">{time}</time></p>
  return (
    <div className="msg msg-approval" data-kind="approval" role="note" aria-label={questionWords.approvalTag}>
      <span className="approval-tag">{questionWords.approvalTag}</span>
      <span className="msg-text">{view.text}</span>
      <time className="msg-time">{time}</time>
    </div>
  )
}
const fill = (template: string, choice: string) => template.replace('{choice}', choice)
