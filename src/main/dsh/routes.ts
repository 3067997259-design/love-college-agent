import type { ModelEfforts, ProviderConfig } from '../config/providers'
import type { ReasoningEffort } from '../../shared'
import { vendorOf } from '../config/vendors'
import type { ManualModelCapabilities } from '../../shared/model-capabilities'

/** One model DSH can select: a provider route key, the exact model id and the chosen thinking level. */
export interface DshModel { provider: string; model: string; effort?: ReasoningEffort }
export interface DshRoutes {
  /** Launch environment: `LCA_DSH_ROUTES` (routes, no keys) and one key variable per route. */
  env: Record<string, string>
  chat: DshModel
  work: DshModel
}
type Model = { id: string; contextWindow?: number; maxTokens?: number; input?: readonly ('text' | 'image')[]; reasoningEfforts?: ManualModelCapabilities['reasoning'] }
type Profile = { apiKeyEnv: string; models: Model[]; api?: string; baseURL?: string; displayName?: string }

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
  const modelOf = (config: ProviderConfig): Model => {
    const c = config.capabilities
    return { id: config.model, ...(c?.contextWindow ? { contextWindow: c.contextWindow } : {}), ...(c?.maxOutputTokens ? { maxTokens: c.maxOutputTokens } : {}),
      ...(c?.inputModalities ? { input: c.inputModalities } : {}), ...(c?.reasoning !== undefined ? { reasoningEfforts: c.reasoning } : {}) }
  }
  const addModel = (profile: Profile, config: ProviderConfig) => {
    const value = modelOf(config), old = profile.models.find((entry) => entry.id === value.id)
    if (!old) profile.models.push(value)
    else if (JSON.stringify(old) !== JSON.stringify(value)) throw new Error('CONFLICTING_MODEL_CAPABILITIES')
  }
  const place = (role: 'chat' | 'work', config: ProviderConfig): string => {
    const vendor = vendorOf(config.base_url)
    if (vendor?.catalog === 'deepseek-official') {
      if (config.capabilities) throw new Error('NATIVE_MODEL_CAPABILITIES_MANAGED_BY_ADAPTER')
      if (env.DEEPSEEK_API_KEY === undefined || env.DEEPSEEK_API_KEY === config.api_key) { env.DEEPSEEK_API_KEY = config.api_key; return 'deepseek-official' }
    } else if (vendor?.catalog) {
      const existing = providers[vendor.catalog]
      if (!existing) {
        providers[vendor.catalog] = { apiKeyEnv: keyEnv[role], models: [modelOf(config)], ...(vendor.native ? {} : { api: 'openai-completions', baseURL: config.base_url }) }
        env[keyEnv[role]] = config.api_key
        return vendor.catalog
      }
      if (env[existing.apiKeyEnv] === config.api_key && (vendor.native || existing.baseURL === config.base_url)) { addModel(existing, config); return vendor.catalog }
    }
    const shared = Object.entries(providers).find(([route, profile]) => route.startsWith('lca-') && profile.baseURL === config.base_url && env[profile.apiKeyEnv] === config.api_key)
    if (shared) { addModel(shared[1], config); return shared[0] }
    const route = `lca-${role}`
    providers[route] = { displayName: 'LCA', apiKeyEnv: keyEnv[role], api: 'openai-completions', baseURL: config.base_url, models: [modelOf(config)] }
    env[keyEnv[role]] = config.api_key
    return route
  }
  const chatRoute: DshModel = { provider: place('chat', chat), model: chat.model, ...(efforts.chat ? { effort: efforts.chat } : {}) }
  const workRoute: DshModel = { provider: place('work', work), model: work.model, ...(efforts.work ? { effort: efforts.work } : {}) }
  env.LCA_DSH_ROUTES = JSON.stringify({ providers, chat: chatRoute, work: workRoute })
  return { env, chat: chatRoute, work: workRoute }
}
