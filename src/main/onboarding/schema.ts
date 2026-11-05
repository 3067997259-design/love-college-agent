import { z } from 'zod'
import type { OnboardingView } from '../../shared'

const singleLine = (maximum: number) => z.string().max(1000).refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
  .transform((value) => value.trim()).refine((value) => Array.from(value).length <= maximum)
/** A few lines in the user's own words: line breaks and tabs stay; other control or invisible format characters do not. */
const multiLine = (maximum: number) => z.string().max(4000).transform((value) => value.replace(/\r\n?/g, '\n'))
  .refine((value) => !/[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Cc}\n\t]/u.test(value))
  .transform((value) => value.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()).refine((value) => Array.from(value).length <= maximum)
export const userNameInput = singleLine(20)
export const characterNameInput = singleLine(12)
export const aboutUserInput = multiLine(500)
export const onboardingProfileInput = z.strictObject({ userName: userNameInput.optional(), characterName: characterNameInput.optional(), aboutUser: aboutUserInput.optional() })
  .refine((value) => value.userName !== undefined || value.characterName !== undefined || value.aboutUser !== undefined)
export const onboardingSchema = z.strictObject({ status: z.enum(['needed', 'completed']),
  userName: userNameInput.refine((value) => value.length > 0).nullable(), characterName: characterNameInput.refine((value) => value.length > 0),
  // Optional and never empty: profiles and saves written before it existed, or without it, stay valid.
  aboutUser: aboutUserInput.refine((value) => value.length > 0).optional(),
  completedAtMs: z.number().int().nonnegative().nullable(),
}).refine((value) => value.status !== 'needed' || value.completedAtMs === null)
export const initialOnboarding = (): OnboardingView => ({ status: 'needed', userName: null, characterName: '桃子', completedAtMs: null })
export const onboardingView = (value: OnboardingView, booth: boolean): OnboardingView => ({ ...value, ...(booth ? { status: 'completed' as const } : {}) })
/** One profile edit from the book: empty names fall back to none / 桃子; an empty about-you text removes it. */
export function applyProfile(current: OnboardingView, edit: { userName?: string; characterName?: string; aboutUser?: string }): OnboardingView {
  const next: OnboardingView = { ...current, ...(edit.userName !== undefined ? { userName: edit.userName || null } : {}),
    ...(edit.characterName !== undefined ? { characterName: edit.characterName || '桃子' } : {}) }
  if (edit.aboutUser !== undefined) { if (edit.aboutUser) next.aboutUser = edit.aboutUser; else delete next.aboutUser }
  return next
}
