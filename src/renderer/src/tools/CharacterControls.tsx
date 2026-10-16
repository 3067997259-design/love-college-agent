import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
export function CharacterControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const pack = snapshot.characterPack; if (!pack) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  return <section aria-label="角色包"><h2>角色包</h2><p>{pack.name} · {pack.status} · 静态名字、人设和 PNG，不含个人经历</p>
    <button disabled={pack.status === 'importing' || pack.status === 'exporting'} onClick={() => void send({ type: 'character.import' })}>导入静态角色包</button><button onClick={() => void send({ type: 'character.export' })}>导出静态角色包</button>
    <label>下次启用的角色<select aria-label="下次启用的角色" value={pack.selectedId} onChange={(event) => void send({ type: 'character.select', characterId: event.target.value })}>{pack.installed.map((item) => <option key={item.id} value={item.id}>{item.name}{item.builtin ? '（内置）' : ''}</option>)}</select></label>
    {pack.restartRequired && <><p>重启后打开这个角色独立的聊天、记忆和房间。要恢复私人存档，请先启用同一角色。</p><button onClick={() => void send({ type: 'app.restart' })}>重启切换角色</button></>}
    {error && <p role="alert">{error}</p>}
  </section>
}
