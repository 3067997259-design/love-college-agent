import { useState } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { sendCommand, type CommandBody } from './command'

/**
 * 卡片上的一次操作（批准、拒绝、回答、取消）：
 * 发出去到主进程回话之间按钮停住；主进程收下以后，再等到下一张快照（状态真的变了）才放开，避免空档里重复点。
 * 被拒绝就在原地说明。状态按“epoch＋对象 id”记，换了对象或恢复了存档都不串。
 * accepted 只表示收到，做没做成看后续快照（src/shared/README.md）。
 */
export function useAct(bridge: AppBridge, snapshot: Pick<AppSnapshot, 'epoch' | 'revision'>, key: string | undefined) {
  const [state, setState] = useState<{ id: string; phase: 'sending' | 'accepted' | 'failed'; revision: number } | null>(null)
  const id = key === undefined ? undefined : `${snapshot.epoch}:${key}`
  const mine = state && state.id === id ? state : null
  const busy = !!mine && (mine.phase === 'sending' || (mine.phase === 'accepted' && mine.revision === snapshot.revision))
  async function send(body: CommandBody) {
    if (!id || busy) return
    setState({ id, phase: 'sending', revision: snapshot.revision })
    const result = await sendCommand(bridge, snapshot.epoch, body)
    setState((current) => current?.id === id ? { id, phase: result.ok ? 'accepted' : 'failed', revision: current.revision } : current)
  }
  return { busy, failed: mine?.phase === 'failed', send }
}
