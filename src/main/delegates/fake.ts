import type { DelegateModel } from './schema'
export const createFakeDelegateModel = (): DelegateModel => ({ source: 'fake', read: async ({ sources }, signal) => {
  signal.throwIfAborted()
  return { conclusion: sources[0].text.trim().slice(0, 500) || '(empty synthetic source)', refs: sources.map(({ path, sha256 }) => ({ path, sha256 })) }
} })
