import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import { SettingsIssue, settingStatus } from './SettingsIssue'

export function BackupControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const backup = snapshot.backup
  if (!backup) return null
  const busy = ['exporting', 'validating', 'restoring'].includes(backup.status)
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, epoch: snapshot.epoch, requestId: crypto.randomUUID(), protocolVersion: 1 } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  return <div aria-label="私人存档控制"><h2>私人存档</h2>
    <p>包含私人聊天、记忆、邮件证据、资料与交付物，请自行保管；不带应用凭据、调试配置或插件授权。</p>
    <p role="status">{backup.status === 'exported' ? '私人存档已导出' : backup.status === 'restored' ? '私人存档已恢复' : settingStatus(backup.status)}</p>
    <button type="button" disabled={busy} onClick={() => void send({ type: 'backup.export' })}>导出私人存档</button>
    <button type="button" disabled={busy} onClick={() => void send({ type: 'backup.import' })}>我已经有一本书了</button>
    {backup.status === 'awaiting-confirmation' && backup.incoming && <div role="alertdialog" aria-label="恢复私人存档确认">
      <p>{backup.incoming.source === 'fake' ? '开发存档' : '私人存档'} · {backup.incoming.pageCount} 页 · {backup.incoming.messageCount} 条聊天 · {backup.incoming.memoryCount} 条记忆 · {backup.incoming.deliveryCount} 件交付</p>
      <p>确认后会自动备份当前数据，恢复这一份存档并重启。计时按保存的剩余时长继续，不补算存档之后的空档。</p>
      <button type="button" onClick={() => void send({ type: 'backup.restore', restoreId: backup.restoreId })}>备份当前数据并恢复</button>
      <button type="button" onClick={() => void send({ type: 'backup.cancel' })}>取消恢复</button>
    </div>}
    {backup.status === 'restored' && <button type="button" onClick={() => void send({ type: 'backup.cancel' })}>完成恢复查看</button>}
    <SettingsIssue code={error || backup.error?.code} />
  </div>
}
