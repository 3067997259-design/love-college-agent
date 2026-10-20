import type { ModelEfforts, ProviderConfig } from '../config/providers'
import type { ReasoningEffort } from '../../shared'
import { vendorOf } from '../config/vendors'

/** One model DSH can select: a provider route key, the exact model id and the chosen thinking level. */
export interface DshModel { provider: string; model: string; effort?: ReasoningEffort }
export interface DshRoutes {
  /** Launch environment: `LCA_DSH_ROUTES` (routes, no keys) and one key variable per route. */
  env: Record<string, string>
  chat: DshModel
  work: DshModel
}
type Profile = { apiKeyEnv: string; models: { id: string }[]; api?: string; baseURL?: string; displayName?: string }

/**
 * DSH routes for her chat and work models. A vendor DSH's catalog describes gets that catalog route,
 * so DSH knows the model's thinking levels; DeepSeek's official API keeps DSH's first-party adapter;
 * any other endpoint is an OpenAI-compatible route of its own. Two roles share a route when it is
 * the same endpoint and key; keys never enter the routes JSON.
 */
export function dshRoutes(chat: ProviderConfig, work: ProviderConfig, efforts: ModelEfforts): DshRoutes {
  const env: Record<string, string> = {}
  const providers: Record<string, Profile> = {}
  const keyEnv = { chat: 'LCA_CHAT_API_KEY', work: 'LCA_WORK_API_KEY' } as const
  const addModel = (profile: Profile, model: string) => { if (!profile.models.some((entry) => entry.id === model)) profile.models.push({ id: model }) }
  const place = (role: 'chat' | 'work', config: ProviderConfig): string => {
    const vendor = vendorOf(config.base_url)
    if (vendor?.catalog === 'deepseek-official') {
      if (env.DEEPSEEK_API_KEY === undefined || env.DEEPSEEK_API_KEY === config.api_key) { env.DEEPSEEK_API_KEY = config.api_key; return 'deepseek-official' }
    } else if (vendor?.catalog) {
      const existing = providers[vendor.catalog]
      if (!existing) {
        providers[vendor.catalog] = { apiKeyEnv: keyEnv[role], models: [{ id: config.model }], ...(vendor.native ? {} : { api: 'openai-completions', baseURL: config.base_url }) }
        env[keyEnv[role]] = config.api_key
        return vendor.catalog
      }
      if (env[existing.apiKeyEnv] === config.api_key && (vendor.native || existing.baseURL === config.base_url)) { addModel(existing, config.model); return vendor.catalog }
    }
    const shared = Object.entries(providers).find(([route, profile]) => route.startsWith('lca-') && profile.baseURL === config.base_url && env[profile.apiKeyEnv] === config.api_key)
    if (shared) { addModel(shared[1], config.model); return shared[0] }
    const route = `lca-${role}`
    providers[route] = { displayName: 'LCA', apiKeyEnv: keyEnv[role], api: 'openai-completions', baseURL: config.base_url, models: [{ id: config.model }] }
    env[keyEnv[role]] = config.api_key
    return route
  }
  const chatRoute: DshModel = { provider: place('chat', chat), model: chat.model, ...(efforts.chat ? { effort: efforts.chat } : {}) }
  const workRoute: DshModel = { provider: place('work', work), model: work.model, ...(efforts.work ? { effort: efforts.work } : {}) }
  env.LCA_DSH_ROUTES = JSON.stringify({ providers, chat: chatRoute, work: workRoute })
  return { env, chat: chatRoute, work: workRoute }
}
