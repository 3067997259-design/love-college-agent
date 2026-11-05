import { useState } from 'react'
import type { MemoryEngineStatus, MemorySettingsView } from '../../../shared'

/**
 * 向量与镜像连接。这两项是高级配置：普通使用不需要碰，但配置过的用户要能看到当前状态。
 * 折叠默认收起，视觉上当作“高级”一档；自动化脚本打开设置时会把它展开。
 */
export function MemorySettingsControls({ settings, engine, busy, send }: {
  settings: MemorySettingsView; engine?: MemoryEngineStatus; busy: boolean; send(body: Record<string, unknown>): Promise<boolean>
}) {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings.embedding.model ?? '')
  const [connectionString, setConnectionString] = useState('')
  const disabled = busy || settings.status === 'saving'
  const embeddingState = { unconfigured: '没配置', ready: '可用', migrating: '正在迁移', failed: '迁移或请求没完成' } as const
  const mirrorState = { unconfigured: '没连接', ready: '已连接', held: '已暂停', offline: '连接没完成' } as const
  const embeddingLine = `${engine ? embeddingState[engine.embedding.state] : '正在准备'}${settings.embedding.configured ? ` · ${settings.embedding.host} · ${settings.embedding.model}` : ''}${engine?.embedding.remaining ? ` · 还有 ${engine.embedding.remaining} 条待处理` : ''}`
  const mirrorLine = `${settings.mirror.enabled ? engine ? mirrorState[engine.mirror.state] : '正在准备' : '没开启'}${engine?.mirror.pending ? ` · 还有 ${engine.mirror.pending} 项待同步` : ''}`
  return <section aria-label="记忆连接设置">
    <details className="settings-advanced">
      <summary>高级：向量检索与外部数据库同步</summary>
      <p className="settings-advanced-note">两样都可以不配，她照样按文字记忆。密钥和连接串只存在这台电脑上，导出私人存档时不带。</p>
      <h3>向量检索</h3>
      <p className="settings-note">让她能按意思回想，不只按字面。</p>
      <p role="status">{embeddingLine}</p>
      <label>向量服务地址<input aria-label="向量服务地址" type="url" maxLength={4096} value={baseUrl} placeholder="https://…/v1/" onChange={event => setBaseUrl(event.target.value)} /></label>
      <label>向量模型<input aria-label="向量模型" maxLength={256} value={model} onChange={event => setModel(event.target.value)} /></label>
      <label>向量密钥<input aria-label="向量密钥" type="password" autoComplete="new-password" maxLength={8192} value={apiKey} placeholder={settings.embedding.configured ? '同一地址可以留空，沿用原来的' : 'API key'} onChange={event => setApiKey(event.target.value)} /></label>
      <div className="settings-actions">
        <button type="button" disabled={disabled || !baseUrl.trim() || !model.trim() || !apiKey.trim() && !settings.embedding.configured} onClick={() => void send({ type: 'memory.settings.configure', embedding: { baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } }).then(accepted => { if (accepted) { setApiKey(''); setBaseUrl('') } })}>保存并迁移向量</button>
        <button type="button" disabled={disabled || !settings.embedding.configured} onClick={() => void send({ type: 'memory.settings.retry', target: 'embedding' })}>继续向量迁移</button>
        <button type="button" disabled={disabled || !settings.embedding.configured} onClick={() => void send({ type: 'memory.settings.configure', embedding: null })}>移除向量连接</button>
      </div>
      <h3>外部数据库镜像</h3>
      <p className="settings-note">把确认过的长期记忆同步一份到你自己的数据库。</p>
      <p role="status">{mirrorLine}</p>
      <label>镜像连接串<input aria-label="镜像连接串" type="password" autoComplete="new-password" maxLength={8192} value={connectionString} placeholder="postgresql://…" onChange={event => setConnectionString(event.target.value)} /></label>
      <div className="settings-actions">
        <button type="button" disabled={disabled || !connectionString.trim() && !settings.mirror.configured} onClick={() => void send({ type: 'memory.settings.configure', mirror: { enabled: true, ...(connectionString.trim() ? { connectionString: connectionString.trim() } : {}) } }).then(accepted => { if (accepted) setConnectionString('') })}>保存并开启镜像</button>
        <button type="button" disabled={disabled || !settings.mirror.enabled} onClick={() => void send({ type: 'memory.settings.retry', target: 'mirror' })}>重试镜像同步</button>
        <button type="button" disabled={disabled || !settings.mirror.enabled} onClick={() => void send({ type: 'memory.settings.configure', mirror: { enabled: false } })}>暂停镜像</button>
        <button type="button" disabled={disabled || !settings.mirror.configured} onClick={() => void send({ type: 'memory.settings.configure', mirror: null })}>移除镜像连接</button>
      </div>
      <h3>在对话里</h3>
      <label><input type="checkbox" checked={settings.interaction.directoryEnabled} disabled={disabled} onChange={event => void send({ type: 'memory.settings.interaction', ...settings.interaction, directoryEnabled: event.target.checked })} />在对话中提供记忆目录</label>
      <label><input type="checkbox" checked={settings.interaction.toolsEnabled} disabled={disabled} onChange={event => void send({ type: 'memory.settings.interaction', ...settings.interaction, toolsEnabled: event.target.checked })} />允许通过对话读取和提出记忆更改</label>
      {settings.status === 'saving' && <p role="status">正在应用记忆设置……</p>}
      {settings.error && <p role="alert">{settings.error === 'configuration' ? '连接配置不对，检查一下填的内容。' : settings.error === 'storage' ? '设置没保存上。' : settings.error === 'embedding' ? '向量迁移没做完，进度已经存下。' : '镜像连接或同步没做完，待同步的记录都还在。'}</p>}
    </details>
  </section>
}
