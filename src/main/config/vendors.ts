/**
 * Model vendors LCA recognises by API host. The book shows their name instead of the address, and
 * DSH routes them through its installed model catalog, which knows each model's thinking levels.
 * `native`: DSH talks the vendor's own protocol at the catalog's endpoint, so the configured path
 * (often an OpenAI-compatible one for LCA's own client) is not used. Otherwise DSH keeps the
 * configured address and speaks OpenAI chat completions there, with the catalog's model facts.
 */
export interface Vendor { label: string; catalog: string | null; native: boolean }
const VENDORS: Readonly<Record<string, Vendor>> = {
  'api.deepseek.com': { label: 'DeepSeek', catalog: 'deepseek-official', native: true },
  'api.openai.com': { label: 'OpenAI', catalog: 'openai', native: true },
  'generativelanguage.googleapis.com': { label: 'Google', catalog: 'google', native: true },
  'api.anthropic.com': { label: 'Anthropic', catalog: 'anthropic', native: true },
  'api.x.ai': { label: 'xAI', catalog: 'xai', native: true },
  'api.mistral.ai': { label: 'Mistral', catalog: 'mistral', native: true },
  'api.moonshot.cn': { label: 'Kimi', catalog: 'moonshotai-cn', native: false },
  'api.moonshot.ai': { label: 'Kimi', catalog: 'moonshotai', native: false },
  'api.kimi.com': { label: 'Kimi', catalog: 'kimi-coding', native: false },
  'open.bigmodel.cn': { label: '智谱', catalog: 'zai-coding-cn', native: false },
  'api.z.ai': { label: 'Z.ai', catalog: 'zai', native: false },
  'openrouter.ai': { label: 'OpenRouter', catalog: 'openrouter', native: false },
  'api.groq.com': { label: 'Groq', catalog: 'groq', native: false },
  'api.xiaomimimo.com': { label: '小米 MiMo', catalog: 'xiaomi', native: false },
  'api.siliconflow.cn': { label: '硅基流动', catalog: null, native: false },
}

export function vendorOf(baseUrl: string): Vendor | null {
  try { return VENDORS[new URL(baseUrl).hostname.toLowerCase()] ?? null } catch { return null }
}

/** A host the book may show: loopback in full, anything else with its middle hidden (private proxies can be identifying). */
export function maskedHost(baseUrl: string): string {
  let host: string
  try { host = new URL(baseUrl).hostname.toLowerCase() } catch { return '' }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return host
  const labels = host.split('.')
  const tld = labels.length > 1 ? '.' + labels[labels.length - 1] : ''
  const head = labels.length > 1 ? labels.slice(0, -1).join('.') : host
  return head.slice(0, 3) + '•••' + tld
}
