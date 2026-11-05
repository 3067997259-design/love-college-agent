import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import { SettingsIssue, settingStatus } from './SettingsIssue'
export function CharacterControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const pack = snapshot.characterPack; if (!pack) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section aria-label="角色包"><h2>角色包</h2><p>{pack.name}{pack.status !== 'idle' && ` · ${settingStatus(pack.status)}`}</p>
    <p className="settings-note">角色包只有名字、人设和立绘，不带你们的经历。</p>
    <div className="settings-actions"><button disabled={pack.status === 'importing' || pack.status === 'exporting'} onClick={() => void send({ type: 'character.import' })}>导入静态角色包</button><button onClick={() => void send({ type: 'character.export' })}>导出静态角色包</button></div>
    <label>下次启用的角色<select aria-label="下次启用的角色" value={pack.selectedId} onChange={(event) => void send({ type: 'character.select', characterId: event.target.value })}>{pack.installed.map((item) => <option key={item.id} value={item.id}>{item.name}{item.builtin ? '（内置）' : ''}</option>)}</select></label>
    {pack.restartRequired && <><p className="settings-note">重启后会打开这个角色自己的聊天、记忆和房间。要恢复私人存档，先切到存档里的那个角色。</p><div className="settings-actions"><button onClick={() => void send({ type: 'app.restart' })}>重启切换角色</button></div></>}
    <SettingsIssue code={error} />
  </section>
}
