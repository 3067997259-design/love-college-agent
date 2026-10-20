import { expect, it } from 'vitest'
import { dshRoutes } from '../../src/main/dsh/routes'
import { maskedHost, vendorOf } from '../../src/main/config/vendors'

const config = (base_url: string, model: string, api_key = 'synthetic-key') => ({ base_url, model, api_key })
const routesOf = (env: Record<string, string>) => JSON.parse(env.LCA_DSH_ROUTES!) as { providers: Record<string, Record<string, unknown>>; chat: unknown; work: unknown }

it('routes a recognised vendor through DSH\'s catalog and DeepSeek through its first-party adapter, keys only in env', () => {
  const routes = dshRoutes(config('https://generativelanguage.googleapis.com/v1beta/openai/', 'gemini-3.8-flash', 'synthetic-google'), config('https://api.deepseek.com/v1', 'deepseek-v4-pro', 'synthetic-deepseek'), { chat: 'low', work: 'max' })
  expect(routes.chat).toEqual({ provider: 'google', model: 'gemini-3.8-flash', effort: 'low' })
  expect(routes.work).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' })
  // Native protocol at the catalog's endpoint: the OpenAI-compatible path LCA's own client uses is not passed.
  expect(routesOf(routes.env).providers).toEqual({ google: { apiKeyEnv: 'LCA_CHAT_API_KEY', models: [{ id: 'gemini-3.8-flash' }] } })
  expect(routes.env.LCA_CHAT_API_KEY).toBe('synthetic-google'); expect(routes.env.DEEPSEEK_API_KEY).toBe('synthetic-deepseek')
  expect(routes.env.LCA_DSH_ROUTES).not.toContain('synthetic-')
})

it('keeps the configured address for an OpenAI-compatible vendor and shares one route between the roles', () => {
  const kimi = config('https://api.moonshot.cn/v1', 'kimi-k3')
  const routes = dshRoutes(kimi, { ...kimi, model: 'kimi-k2.7-code' }, {})
  expect(routes.chat.provider).toBe('moonshotai-cn'); expect(routes.work.provider).toBe('moonshotai-cn')
  expect(routesOf(routes.env).providers).toEqual({ 'moonshotai-cn': { apiKeyEnv: 'LCA_CHAT_API_KEY', models: [{ id: 'kimi-k3' }, { id: 'kimi-k2.7-code' }], api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1' } })
  expect(routes.chat).not.toHaveProperty('effort')
})

it('gives unknown endpoints their own OpenAI-compatible routes, and separates two keys for one vendor', () => {
  const same = dshRoutes(config('http://127.0.0.1:11434/v1', 'llama3.1'), config('http://127.0.0.1:11434/v1', 'llama3.1'), { work: 'high' })
  expect(same.chat).toEqual({ provider: 'lca-chat', model: 'llama3.1' }); expect(same.work).toEqual({ provider: 'lca-chat', model: 'llama3.1', effort: 'high' })
  expect(Object.keys(routesOf(same.env).providers)).toEqual(['lca-chat'])
  const keys = dshRoutes(config('https://api.deepseek.com/v1', 'deepseek-flash', 'synthetic-a'), config('https://api.deepseek.com/v1', 'deepseek-v4-pro', 'synthetic-b'), {})
  expect(keys.chat.provider).toBe('deepseek-official'); expect(keys.work.provider).toBe('lca-work')
  expect(keys.env.DEEPSEEK_API_KEY).toBe('synthetic-a'); expect(keys.env.LCA_WORK_API_KEY).toBe('synthetic-b')
})

it('names known vendors and masks other hosts', () => {
  expect(vendorOf('https://open.bigmodel.cn/api/paas/v4')).toEqual({ label: '智谱', catalog: 'zai-coding-cn', native: false })
  expect(vendorOf('https://my-proxy.example.com/v1')).toBeNull(); expect(vendorOf('not a url')).toBeNull()
  expect(maskedHost('https://my-proxy.example.com/v1')).toBe('my-•••.com')
  expect(maskedHost('http://127.0.0.1:11434/v1')).toBe('127.0.0.1')
  expect(maskedHost('https://intranet/v1')).toBe('int•••')
})
