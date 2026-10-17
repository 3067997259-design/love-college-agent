import type { AppBridge, AppSnapshot } from '../../../shared'
import { SettingsIssue, settingStatus } from './SettingsIssue'
export function VoiceControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const voice = snapshot.voice; if (!voice) return null
  const set = () => bridge.dispatch({ type: 'voice.set', enabled: !voice.enabled, protocolVersion: 1, requestId: crypto.randomUUID(), epoch: snapshot.epoch })
  return <div aria-label="输出语音"><h2>输出语音</h2>
    <p>{voice.source === 'fake' ? '合成测试音（不是角色声音）' : voice.available ? 'AI 合成语音' : '语音服务尚未配置'} · {voice.enabled ? '开启' : '静音'}</p>
    <button type="button" disabled={!voice.available && !voice.enabled} onClick={() => void set()}>{voice.enabled ? '关闭语音' : '开启语音'}</button>
    {voice.utterance && <p data-voice-id={voice.utterance.id}>{settingStatus(voice.utterance.status)} · {settingStatus(voice.utterance.playback)}</p>}
    <SettingsIssue code={voice.error?.code} />
  </div>
}
