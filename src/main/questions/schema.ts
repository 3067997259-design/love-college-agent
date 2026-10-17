import { z } from 'zod'

const clean = (value: string) => [...value].every((char) => { const n = char.codePointAt(0)!; return !(n < 32 && ![9, 10, 13].includes(n) || n === 127 || n >= 0x202a && n <= 0x202e || n >= 0x2066 && n <= 0x2069) }) && Buffer.from(value, 'utf8').toString('utf8') === value
const singleLine = (limit: number) => z.string().trim().min(1).max(limit * 2).refine((value) => clean(value) && !/[\r\n\t]/u.test(value) && [...value].length <= limit)
export const questionInput = z.strictObject({ question: singleLine(240), choices: z.array(singleLine(60)).max(3).optional() })
export const answerInput = z.string().trim().min(1).max(2000).refine((value) => clean(value) && [...value].length <= 1000)
