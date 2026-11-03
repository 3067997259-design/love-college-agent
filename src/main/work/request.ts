import type { ToolContext } from '../harness/tools'
import type { WorkDecision, WorkRecord } from './journal'

export interface WorkRequest { decisions: WorkDecision[]; text: string; latest: WorkDecision }

/** Only this root's delivered originals can authorize a mutation. A committed,
 * non-approval answer can complete the preceding request in the same turn.
 * Neither the model's question nor an old conversation supplies missing detail. */
export function authoredWorkRequest(context: ToolContext): WorkRequest | null {
  const rows = context.store.records()
  const ids = [...new Set(context.userMessageIds ?? [context.userMessageId].filter((id): id is string => !!id))]
  if (!context.userMessageId || ids.at(-1) !== context.userMessageId) return null
  const approvals = new Set(rows.flatMap(row => row.type === 'question/requested' && row.approval ? [row.id] : []))
  const decisions: WorkDecision[] = []
  for (const id of ids.toReversed()) {
    const row = rows.find(item => item.type === 'user/message' && item.id === id)
    if (row?.type !== 'user/message') return null
    const answer = rows.find(item => item.type === 'question/answered' && item.answerMessageId === id)
    if (answer?.type === 'question/answered') {
      if (answer.turnId !== context.turnId || approvals.has(answer.id) || !rows.some(item => item.type === 'question/committed' && item.id === answer.id && item.turnId === context.turnId && item.answerMessageId === id)) return null
    }
    decisions.unshift({ id, text: row.text, atMs: row.atMs })
    if (!answer) break
  }
  if (!decisions.length || decisions.length > 8) return null
  const text = decisions.map(item => item.text).join('\n')
  return text.length <= 20_000 ? { decisions, text, latest: decisions.at(-1)! } : null
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const contains = (text: string, quote: string) => /^[\w-]+$/.test(quote)
  ? new RegExp(`(?<![\\w-])${escape(quote)}(?![\\w-])`, 'i').test(text) : text.includes(quote)
const withdrawn = (text: string) => /^(?:先|暂时|暂且|现在|都|那就|还是|请|两个|这两个|这两项|所有|任务|工作|\s)*(?:(?:别|不要|不用|不必|不)(?:改|修改|调整|变更)|取消修改|保持原|算了)/u.test(text)
  || /^(?:please\s+)?(?:never mind|leave .*(?:unchanged|as is)|keep .*(?:unchanged|as is)|(?:do not|don't) (?:change|modify|update)|no changes\b)/i.test(text.trim())
const readOnly = (text: string) => /^(?:请|帮我|现在|\s)*(?:查一下|查看|查询|看看|汇报|介绍|说说)/u.test(text) || /^(?:what|how|show|inspect|query|tell me)\b/i.test(text.trim())

/** This is deliberately a conservative routing vocabulary, not a natural-
 * language authorization classifier. References and generic routing words do
 * not constitute a new requirement. Unrecognized references need clarification;
 * quoted concrete details are still interpreted by DSH from the exact original. */
function concrete(text: string, references: readonly string[] = []) {
  let detail = text
  for (const ref of [...references].filter(Boolean).sort((a, b) => b.length - a.length)) detail = detail.replace(new RegExp(escape(ref), 'gi'), '')
  detail = detail.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '')
    .replace(/(?:^|\n)\s*(?:好|好的|嗯|行|可以|是|是的|同意|确认|没问题|yes|ok|okay|sure|correct)[。.!\s]*(?=\n|$)/giu, '')
    .replace(/(?:按|照|和)?(?:之前|原来|刚才|上次)(?:的)?(?:一样|要求|做法)?/gu, '')
    .replace(/你(?:自己)?(?:看着办|决定)|随便|随意|稍微|一些|一点|一下子|一下|一项|一个|独立|新的|那个|这个|这项|那项|某个|任务|工作|要求|内容|目标|细节|地方|请|帮我|麻烦|把|给|对|将|再|做|弄|修改|改动|改成|改为|改变|调整|更新|更正|补充|追加|增加|新增|创建|新建|启动|开始|改|修|吧|呢|呀|就|了|的/gu, '')
    .replace(/\b(?:please|could|would|can|you|help|me|the|that|this|it|task|work|job|change|update|modify|adjust|amend|supplement|create|start|new|another|a|an|some|something|slightly|again|as|before|same)\b/gi, '')
    .replace(/[\p{P}\p{Z}\s]/gu, '')
  return /[\p{L}\p{N}]/u.test(detail)
}

function references(request: WorkRequest, works: readonly WorkRecord[], hint?: string) {
  const text = request.text
  const ids = works.filter(work => contains(text, work.identity.workId))
  if (ids.length || /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(text)) return { matches: ids, quotes: ids.map(work => work.identity.workId), specified: true }
  // Names must have been declared as a work/task name in the original start
  // request. An arbitrary matching substring (e.g. COFFEE in an old output
  // requirement) is not a work name. The exact original label also remains usable.
  const named = works.flatMap(work => {
    const original = work.decisions[0]?.text ?? ''
    const name = /(?:工作|任务|\b(?:task|work|job)\s+)\s*(?:[「“"『]([^」”"』\n]{1,80})[」”"』]|([A-Za-z][\w-]{0,79})(?=[：:，,。.!?\s]|$)|([^\s：:，,。.!?「」“"『』]{1,40})(?=[：:]))/iu.exec(original)
    const aliases = [work.label, name?.[1] ?? name?.[2] ?? name?.[3]].filter((alias): alias is string => !!alias && concrete(alias))
    return aliases.filter(alias => (!hint || alias === hint) && contains(text, alias)).map(quote => ({ quote, work }))
  })
  const matches = [...new Map(named.map(item => [item.work.identity.workId, item.work])).values()]
  return { matches, quotes: named.map(item => item.quote), specified: !!hint || named.length > 0 }
}

export type WorkRequestIssue = 'request-withdrawn' | 'current-request-required' | 'target-required' | 'requirement-required' | 'existing-work-request' | 'quote-not-in-request'
export function checkWorkRequest(request: WorkRequest, works: readonly WorkRecord[], input: {
  action: 'create' | 'supplement' | 'pause' | 'stop' | 'resume'; workId?: string; targetQuote?: string; requirementQuote?: string
}): WorkRequestIssue | null {
  if (withdrawn(request.latest.text)) return 'request-withdrawn'
  if (input.action !== 'create' && readOnly(request.latest.text) && !/修改|修复|改成|改为|新增|增加|删除|\b(?:fix|change|update|create|write)\b/iu.test(request.latest.text)) return 'current-request-required'
  if ([input.targetQuote, input.requirementQuote].some(quote => quote && !request.decisions.some(item => contains(item.text, quote)))) return 'quote-not-in-request'
  const target = references(request, works, input.targetQuote)
  if (input.action === 'create') {
    const explicitNew = /(?:^|[。！？\n])\s*(?:请|帮我|麻烦)?(?:另外|再|另)?(?:新建|创建|启动|开|做|开始)(?:一个|一项|新的|独立的?|另外的?)*\s*(?:任务|工作)/u.test(request.text)
      || /\b(?:start|create) (?:a |an )?(?:new |independent )?(?:work|task|job)\b/i.test(request.text)
    if (!explicitNew && (target.matches.length || /(?:那个|这个|刚才|之前|原来|上述|上面|现有|当前|该|这个|同一个).{0,6}(?:任务|工作)|(?:补充|修改|调整|更正|更新|追加).{0,10}(?:任务|工作)|\b(?:that|this|existing) (?:task|work|job)\b/iu.test(request.text))) return 'existing-work-request'
    return concrete(request.text) ? null : 'requirement-required'
  }
  // No recency heuristic. A sole unfinished work can be referred to implicitly;
  // multiple works or an explicit conflicting name/ID require a unique binding.
  const unfinished = works.filter(work => !['completed', 'stopped', 'failed'].includes(work.status))
  const matches = target.specified ? target.matches : unfinished
  if (matches.length !== 1 || matches[0].identity.workId !== input.workId) return 'target-required'
  if (input.action === 'supplement') {
    const detail = input.requirementQuote ?? request.text
    return concrete(detail, [...target.quotes, input.targetQuote ?? '']) ? null : 'requirement-required'
  }
  const verbs = { pause: /暂停|暂缓|停一下|\b(?:pause|hold)\b/iu, stop: /停止|取消|终止|别做|不用做|\b(?:stop|cancel|abort)\b/iu,
    resume: /继续|恢复|重新开始|\b(?:resume|continue|restart)\b/iu }
  return verbs[input.action].test(request.text) ? null : 'current-request-required'
}
