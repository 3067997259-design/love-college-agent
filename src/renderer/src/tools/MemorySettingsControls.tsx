import { useState } from 'react'
import type { MemoryEngineStatus, MemorySettingsView } from '../../../shared'

/**
 * 向量与镜像连接。这两项是高级配置：普通使用不需要碰，但配置过的用户要能看到当前状态。
 * 折叠默认展开（自动化脚本直接填写这些输入框），视觉上当作“高级”一档处理。
 */
export function MemorySettingsControls({ settings, engine, busy, send }: {
  settings: MemorySettingsView; engine?: MemoryEngineStatus; busy: boolean; send(body: Record<string, unknown>): Promise<boolean>
}) {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(settings.embedding.model ?? '')
  const [connectionString, setConnectionString] = useState('')
  const disabled = busy || settings.status === 'saving'
  const embeddingState = { unconfigured: '未配置', ready: '可用', migrating: '正在迁移', failed: '迁移或请求未完成' } as const
  const mirrorState = { unconfigured: '未连接', ready: '已连接', held: '已暂停', offline: '连接未完成' } as const
  const embeddingLine = `向量：${engine ? embeddingState[engine.embedding.state] : '正在准备'}${settings.embedding.configured ? ` · ${settings.embedding.host} · ${settings.embedding.model}` : ''}`
  const mirrorLine = `镜像：${settings.mirror.enabled ? engine ? mirrorState[engine.mirror.state] : '正在准备' : '未开启'}`
  return <section aria-label="记忆连接设置">
    <details className="settings-advanced" open>
      <summary>高级：向量检索与外部数据库同步</summary>
      <p className="settings-advanced-note">向量用于按含义回忆，镜像把已确认的长期记忆同步到你自己的数据库。两者都可以不配，不配时她仍按文字记忆工作。凭据只留在本机，不随私人存档导出。</p>
      <p role="status">{embeddingLine}{!!engine?.embedding.remaining && ` · 待处理 ${engine.embedding.remaining} 条`}</p>
      <label>向量服务地址<input aria-label="向量服务地址" type="url" maxLength={4096} value={baseUrl} placeholder="https://…/v1/" onChange={event => setBaseUrl(event.target.value)} /></label>
      <label>向量模型<input aria-label="向量模型" maxLength={256} value={model} onChange={event => setModel(event.target.value)} /></label>
      <label>向量密钥<input aria-label="向量密钥" type="password" autoComplete="new-password" maxLength={8192} value={apiKey} placeholder={settings.embedding.configured ? '同一地址可留空沿用' : 'API key'} onChange={event => setApiKey(event.target.value)} /></label>
      <button type="button" disabled={disabled || !baseUrl.trim() || !model.trim() || !apiKey.trim() && !settings.embedding.configured} onClick={() => void send({ type: 'memory.settings.configure', embedding: { baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } }).then(accepted => { if (accepted) { setApiKey(''); setBaseUrl('') } })}>保存并迁移向量</button>
      <button type="button" disabled={disabled || !settings.embedding.configured} onClick={() => void send({ type: 'memory.settings.retry', target: 'embedding' })}>继续向量迁移</button>
      <button type="button" disabled={disabled || !settings.embedding.configured} onClick={() => void send({ type: 'memory.settings.configure', embedding: null })}>移除向量连接</button>
      <h3>外部数据库镜像</h3>
      <p role="status">{mirrorLine} · 待同步 {engine?.mirror.pending ?? 0} 项</p>
      <label>镜像连接串<input aria-label="镜像连接串" type="password" autoComplete="new-password" maxLength={8192} value={connectionString} placeholder="postgresql://…" onChange={event => setConnectionString(event.target.value)} /></label>
      <button type="button" disabled={disabled || !connectionString.trim() && !settings.mirror.configured} onClick={() => void send({ type: 'memory.settings.configure', mirror: { enabled: true, ...(connectionString.trim() ? { connectionString: connectionString.trim() } : {}) } }).then(accepted => { if (accepted) setConnectionString('') })}>保存并开启镜像</button>
      <button type="button" disabled={disabled || !settings.mirror.enabled} onClick={() => void send({ type: 'memory.settings.retry', target: 'mirror' })}>重试镜像同步</button>
      <button type="button" disabled={disabled || !settings.mirror.enabled} onClick={() => void send({ type: 'memory.settings.configure', mirror: { enabled: false } })}>暂停镜像</button>
      <button type="button" disabled={disabled || !settings.mirror.configured} onClick={() => void send({ type: 'memory.settings.configure', mirror: null })}>移除镜像连接</button>
      <label><input type="checkbox" checked={settings.interaction.directoryEnabled} disabled={disabled} onChange={event => void send({ type: 'memory.settings.interaction', ...settings.interaction, directoryEnabled: event.target.checked })} />在对话中提供记忆目录</label>
      <label><input type="checkbox" checked={settings.interaction.toolsEnabled} disabled={disabled} onChange={event => void send({ type: 'memory.settings.interaction', ...settings.interaction, toolsEnabled: event.target.checked })} />允许通过对话读取和提出记忆更改</label>
      {settings.status === 'saving' && <p role="status">正在应用记忆设置……</p>}
      {settings.error && <p role="alert">{settings.error === 'configuration' ? '连接配置无效，请检查输入。' : settings.error === 'storage' ? '设置未能保存。' : settings.error === 'embedding' ? '向量迁移未完成，已保存进度。' : '镜像连接或同步未完成，待同步记录已保留。'}</p>}
    </details>
  </section>
}
