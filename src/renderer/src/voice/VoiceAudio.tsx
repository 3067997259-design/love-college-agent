import { useEffect, useRef } from 'react'
import type { AppBridge, AppSnapshot } from '../../../shared'
import { createVoicePlayer } from './player'

export function VoiceAudio({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const player = useRef<ReturnType<typeof createVoicePlayer> | null>(null)
  useEffect(() => { const current = createVoicePlayer(bridge); player.current = current; return () => { current.close(); player.current = null } }, [bridge])
  useEffect(() => { player.current?.update(snapshot) }, [snapshot])
  return null
}
