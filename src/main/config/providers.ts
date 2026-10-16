import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const mailSchema = z.object({
  host: z.string().min(1), port: z.number().int().min(1).max(65535), tls: z.literal(true),
  user: z.string().min(1), auth_code: z.string().min(1), folder: z.literal('桃子'),
})
export type MailCredentials = z.infer<typeof mailSchema>

/** Main-only bootstrap. No serialized return path to renderer, logs, or debug tools. */
export async function readMailCredentials(filename: string): Promise<MailCredentials> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filename, 'utf8'))
    return z.object({ mail: mailSchema }).parse(parsed).mail
  } catch {
    throw new Error('MAIL_CONFIG_UNAVAILABLE')
  }
}
