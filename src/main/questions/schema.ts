import { z } from 'zod'

const clean = (value: string) => [...value].every((char) => { const n = char.codePointAt(0)!; return !(n < 32 && ![9, 10, 13].includes(n) || n === 127 || n >= 0x202a && n <= 0x202e || n >= 0x2066 && n <= 0x2069) }) && Buffer.from(value, 'utf8').toString('utf8') === value
const singleLine = (limit: number) => z.string().trim().min(1).max(limit * 2).refine((value) => clean(value) && !/[\r\n\t]/u.test(value) && [...value].length <= limit)
/** An approval LCA asks on her behalf: one line and its choices. */
export const questionInput = z.strictObject({ question: singleLine(240), choices: z.array(singleLine(60)).max(3).optional() })
export const answerInput = z.string().trim().min(1).max(2000).refine((value) => clean(value) && [...value].length <= 1000)

/** Her questions at once (DSH ask_user_question), as the book shows them: one to four, each with up to six options. */
export const itemsInput = z.array(z.strictObject({
  id: singleLine(64), header: singleLine(24).optional(), question: singleLine(400),
  options: z.array(z.strictObject({ label: singleLine(60), description: singleLine(160).optional() })).max(6),
  multiSelect: z.boolean(),
})).min(1).max(4).refine((items) => new Set(items.map((item) => item.id)).size === items.length
  && items.every((item) => new Set(item.options.map((option) => option.label)).size === item.options.length))
export type QuestionItem = z.infer<typeof itemsInput>[number]
/** Your answer, one entry per question in order: picked labels and your own words; neither is a skip. */
export const answersInput = z.array(z.strictObject({ id: z.string().min(1).max(128), selected: z.array(z.string().min(1).max(120)).max(6), custom: answerInput.optional() })).min(1).max(4)
