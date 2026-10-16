import type { AppBridge } from '../../../shared'
import { createFakeBridge, scenarioFromUrl, type FakeBridge } from '../dev/fake-bridge'

/**
 * Electron 里一律走 preload 提供的真实接口。
 * 只有开发时在纯浏览器里预览（没有 preload）才用假接口，界面右下角会标明“假数据”。
 */
export function resolveBridge(): { bridge: AppBridge; fake: FakeBridge | null } {
  const real = (window as Partial<Window>).lca
  if (real) return { bridge: real, fake: null }
  if (!import.meta.env.DEV) throw new Error('preload bridge missing')
  const fake = createFakeBridge(scenarioFromUrl(location.search))
  return { bridge: fake, fake }
}
