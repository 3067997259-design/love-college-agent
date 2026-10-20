import type { AppBridge, AppSnapshot } from '../../../shared'
import { UserSettings } from './UserSettings'
import './tools.css'

/** 设置是书里的一页：“设置”书签和其他书签一样翻到右页，回对话点“对话”书签。 */
export function SettingsPage({ bridge, snapshot, onOpenPlugins }: { bridge: AppBridge; snapshot: AppSnapshot; onOpenPlugins?: () => void }) {
  return (
    <section className="page page-right settings-page settings-surface" aria-label="设置" data-settings="user">
      <UserSettings bridge={bridge} snapshot={snapshot} onOpenPlugins={onOpenPlugins} />
    </section>
  )
}
