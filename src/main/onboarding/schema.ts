import { z } from 'zod'
import type { OnboardingView } from '../../shared'

const singleLine = (maximum: number) => z.string().max(1000).refine((value) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value))
  .transform((value) => value.trim()).refine((value) => Array.from(value).length <= maximum)
export const userNameInput = singleLine(20)
export const characterNameInput = singleLine(12)
export const onboardingProfileInput = z.strictObject({ userName: userNameInput.optional(), characterName: characterNameInput.optional() })
  .refine((value) => value.userName !== undefined || value.characterName !== undefined)
export const onboardingSchema = z.strictObject({ status: z.enum(['needed', 'completed']),
  userName: userNameInput.refine((value) => value.length > 0).nullable(), characterName: characterNameInput.refine((value) => value.length > 0),
  completedAtMs: z.number().int().nonnegative().nullable(),
}).refine((value) => value.status !== 'needed' || value.completedAtMs === null)
export const initialOnboarding = (): OnboardingView => ({ status: 'needed', userName: null, characterName: '桃子', completedAtMs: null })
export const onboardingView = (value: OnboardingView, booth: boolean): OnboardingView => ({ ...value, ...(booth ? { status: 'completed' as const } : {}) })
