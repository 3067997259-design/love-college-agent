import { PUBLIC_ERROR_CODES } from '../../../shared'
import words from '../voice/settings.zh.json'

/** Only closed public codes are eligible for technical detail; never render arbitrary exceptions. */
export function SettingsIssue({ code }: { code: string | undefined }) {
  if (!code) return null
  const known = (PUBLIC_ERROR_CODES as readonly string[]).includes(code)
  const message = Object.hasOwn(words.errors, code) ? (words.errors as Record<string, string>)[code] : words.unknownError
  return <div role="alert" className="settings-issue"><p>{message}</p>{known && <details><summary>{words.details}</summary><code>{code}</code></details>}</div>
}
export const settingStatus = (value: string) => Object.hasOwn(words.status, value) ? (words.status as Record<string, string>)[value]
  : Object.hasOwn(words.extraStatus, value) ? (words.extraStatus as Record<string, string>)[value] : words.unknownStatus
