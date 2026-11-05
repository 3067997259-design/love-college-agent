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
    <p className="settings-note">里面有私人聊天、记忆、邮件摘录、资料和交付文件，请收好。应用凭据、调试配置和插件授权不在里面。</p>
    {backup.status !== 'idle' && <p role="status">{backup.status === 'exported' ? '私人存档已导出' : backup.status === 'restored' ? '私人存档已恢复' : settingStatus(backup.status)}</p>}
    <div className="settings-actions">
      <button type="button" disabled={busy} onClick={() => void send({ type: 'backup.export' })}>导出私人存档</button>
      <button type="button" disabled={busy} onClick={() => void send({ type: 'backup.import' })}>导入并恢复存档…</button>
    </div>
    {backup.status === 'awaiting-confirmation' && backup.incoming && <div role="alertdialog" aria-label="恢复私人存档确认">
      <p>{backup.incoming.source === 'fake' ? '开发存档' : '私人存档'} · {backup.incoming.pageCount} 页 · {backup.incoming.messageCount} 条聊天 · {backup.incoming.memoryCount} 条记忆 · {backup.incoming.deliveryCount} 件交付</p>
      <p className="settings-note">确认后先备份现在的数据，再恢复这份存档并重启。番茄钟从存档时剩下的时间接着走。</p>
      <div className="settings-actions">
        <button type="button" onClick={() => void send({ type: 'backup.restore', restoreId: backup.restoreId })}>备份当前数据并恢复</button>
        <button type="button" onClick={() => void send({ type: 'backup.cancel' })}>取消恢复</button>
      </div>
    </div>}
    {backup.status === 'restored' && <button type="button" onClick={() => void send({ type: 'backup.cancel' })}>完成恢复查看</button>}
    <SettingsIssue code={error || backup.error?.code} />
  </div>
}
