/** Fixed-pattern removal happens before any privacy-model request, including explicit development fakes. */
export function redactFixed(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[密钥已遮盖]')
    .replace(/\b(?:sk-|AIza)[A-Za-z0-9_-]{8,}/g, '[密钥已遮盖]')
    .replace(/((?:api[_ -]?key|auth[_ -]?code|授权码|密钥|password)\s*[:=：]\s*)[^\s,;，；]+/gi, '$1[密钥已遮盖]')
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, '[长标识已遮盖]')
    .replace(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[邮箱已遮盖]')
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, '[手机已遮盖]')
    .replace(/((?:学号|student\s*id)\s*[:：]?\s*)[A-Za-z0-9-]{5,30}/gi, '$1[学号已遮盖]')
}
