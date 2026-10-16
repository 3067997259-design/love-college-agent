import { z } from 'zod'
export const notificationRuleInput = z.strictObject({ sourceRole: z.enum(['any', 'teaching-assistant', 'student-club', 'library', 'other']), keyword: z.string().trim().max(20).refine((text) => [...text].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127) && !/[<>\r\n]/.test(text)) })
export const notificationRule = notificationRuleInput.extend({ id: z.string().uuid() })
