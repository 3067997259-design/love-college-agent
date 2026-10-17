import { z } from 'zod'
export const deskCommandInput = z.strictObject({
  command: z.string().trim().min(1).max(6000).refine((text) => [...text].every((char) => { const n = char.codePointAt(0)!; return n >= 32 && n !== 127 && !(n >= 0x202a && n <= 0x202e || n >= 0x2066 && n <= 0x2069) }) && Buffer.from(text).toString('utf8') === text),
  timeoutMs: z.number().int().min(500).max(30000).default(5000),
})
export const commandOutcome = z.strictObject({ exitCode: z.number().int().nullable(), elapsedMs: z.number().int().nonnegative(), processTreeTerminated: z.boolean(), publication: z.enum(['unchanged', 'applied', 'not-applied', 'partial']), changedFiles: z.number().int().nonnegative(), appliedFiles: z.number().int().nonnegative() })
