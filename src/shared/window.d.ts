import type { AppBridge } from './bridge'

declare global {
  interface Window { readonly lca: AppBridge }
}

export {}
