import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
/** Plain operator controls; Claude owns the game scene and voice. */
export function MinecraftControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [selected, setSelected] = useState(''); const [radius, setRadius] = useState(8); const [seconds, setSeconds] = useState(60); const [chat, setChat] = useState(false); const [screenshots, setScreenshots] = useState(false); const [error, setError] = useState('')
  const view = snapshot.minecraft
  if (!view || snapshot.runtime?.developer.mode === 'normal') return null
  const servers = snapshot.mcp?.servers.filter((server) => server.tools.includes('get_world_session')) ?? []; const serverId = selected || servers[0]?.id || ''
  const active = ['playing', 'checking', 'stopping'].includes(view.status)
  const send = async (body: Record<string, unknown>) => { try { const ack = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') } catch { setError('unavailable') } }
  return <section aria-label="Minecraft 展位控制"><h2>Minecraft 展位</h2>
    <p>{view.source} · {view.status} · {view.actionsUsed}/{view.maxActions} 次动作 · {view.stopVerified ? '本轮输入已释放' : '本轮输入停止尚未核实'}</p>
    <p>先在 MCP 连接并核对配置，再核对玩家。游戏对话单独保存，不进入普通记忆或私人存档。</p>
    <label>游戏 MCP<select aria-label="游戏 MCP" value={serverId} disabled={active} onChange={(event) => setSelected(event.target.value)}>{servers.map((server) => <option key={server.id} value={server.id}>{server.id} · {server.status}</option>)}</select></label>
    <button disabled={active || !serverId} onClick={() => void send({ type: 'minecraft.check', serverId })}>核对游戏玩家</button>
    {view.pilot && <p>玩家：{view.pilot.name} · {view.pilot.uuid} · {view.pilot.dimension}</p>}
    {view.features && <p>已核对的可用能力：{view.features.join(' · ') || '基础移动'}</p>}
    <p>确认的本轮范围包含附近移动／转向和可用的只读观察；公开聊天另行勾选。</p>
    <label>附近半径（格）<input aria-label="游戏半径" type="number" min={1} max={16} value={radius} disabled={active} onChange={(event) => setRadius(Number(event.target.value))} /></label>
    <label>本轮秒数<input aria-label="游戏秒数" type="number" min={1} max={600} value={seconds} disabled={active} onChange={(event) => setSeconds(Number(event.target.value))} /></label>
    <label><input type="checkbox" checked={chat} disabled={active} onChange={(event) => setChat(event.target.checked)} />允许本轮公开游戏聊天</label>
    <label><input type="checkbox" checked={screenshots} disabled={active || !view.features?.includes('screenshot')} onChange={(event) => setScreenshots(event.target.checked)} />允许本轮游戏截图交给游戏模型</label>
    <button disabled={active || view.status !== 'ready' || view.serverId !== serverId || !view.pilot} onClick={() => void send({ type: 'minecraft.start', serverId, expectedPlayerUuid: view.pilot!.uuid, scope: { radiusBlocks: radius, durationMs: seconds * 1000, allowChat: chat, allowScreenshots: screenshots } })}>确认此玩家与范围并开始</button>
    <button disabled={!active && view.stopVerified} onClick={() => void send({ type: 'minecraft.stop' })}>停止游戏轮次</button>
    {view.lastAction && <p>最近动作：{view.lastAction.kind} · {view.lastAction.status}</p>}
    {(error || view.error) && <p role="alert">{error || view.error?.code}</p>}
  </section>
}
