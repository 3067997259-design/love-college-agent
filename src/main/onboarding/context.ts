import type { OnboardingView } from '../../shared'
import type { ContextMessage } from '../journal/schema'
import prompts from './prompts.json'

/**
 * Stable system layers are not eligible for experience extraction. Values remain quoted data, and the replacement is
 * a function so a `$&` or `$$` the user typed stays as typed instead of being read as a replacement pattern.
 */
export function profileContext(profile: OnboardingView): ContextMessage[] {
  const about = { ...(profile.userName ? { userName: profile.userName } : {}), ...(profile.aboutUser ? { aboutUser: profile.aboutUser } : {}) }
  return [{ role: 'system', content: prompts.character.replace('{profile}', () => JSON.stringify({ characterName: profile.characterName })) },
    ...(Object.keys(about).length ? [{ role: 'system' as const, content: prompts.aboutYou.replace('{profile}', () => JSON.stringify(about)) }] : [])]
}
