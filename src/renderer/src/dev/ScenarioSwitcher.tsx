import { useEffect, useState } from 'react'
import type { FakeBridge } from './fake-bridge'
import { SCENARIOS, type ScenarioId } from './scenarios'
import './dev.css'

const IDS = Object.keys(SCENARIOS) as ScenarioId[]

/** 开发用：切换假快照场景。数字键 1–9 直接切。只在纯浏览器预览时出现。 */
export function ScenarioSwitcher({ fake }: { fake: FakeBridge }) {
  const [current, setCurrent] = useState(fake.scenarioId)
  const pick = (id: ScenarioId) => {
    fake.setScenario(id)
    setCurrent(id)
    const url = new URL(location.href)
    url.searchParams.set('scenario', id)
    history.replaceState(null, '', url)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return
      const id = IDS[Number(e.key) - 1]
      if (id) pick(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <aside className="dev-switcher" aria-label="假数据场景">
      <strong>假数据</strong>
      {IDS.map((id, i) => (
        <button key={id} data-active={id === current} onClick={() => pick(id)}>{i + 1} {id}</button>
      ))}
      <button onClick={() => fake.skipPhase()} title="番茄钟的当前阶段直接到点">跳过本段</button>
      <button onClick={() => fake.simulateRestore()} title="模拟恢复存档后重启：颜色从她身上重新长回来">恢复晕染</button>
      <span className="dev-life" title="同一个 epoch 里切换，看左页的生活转场；真实的出门、睡眠和时段由主进程决定">
        <button onClick={() => fake.simulateLife('depart')}>出门</button>
        <button onClick={() => fake.simulateLife('return')}>回来</button>
        <button onClick={() => fake.simulateLife('sleep')}>入睡</button>
        <button onClick={() => fake.simulateLife('wake')}>唤醒</button>
        <button onClick={() => fake.simulateLife('daypart')}>换时段</button>
      </span>
    </aside>
  )
}
