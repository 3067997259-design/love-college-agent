import type { OnboardingView } from '../../shared'
import type { ContextMessage } from '../journal/schema'
import prompts from './prompts.json'

/** Stable system layers are not eligible for experience extraction. Values remain quoted data. */
export function profileContext(profile: OnboardingView): ContextMessage[] {
  return [{ role: 'system', content: prompts.character.replace('{profile}', JSON.stringify({ characterName: profile.characterName })) },
    ...(profile.userName ? [{ role: 'system' as const, content: prompts.aboutYou.replace('{profile}', JSON.stringify({ userName: profile.userName })) }] : [])]
}
