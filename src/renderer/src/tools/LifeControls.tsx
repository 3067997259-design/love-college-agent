import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
export function LifeControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const life = snapshot.life; if (!life) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  const label = { room: '房间', coast: '海岸', swing: '秋千' }; const proposed = life.outings.findLast((outing) => outing.status === 'proposed'); const work = life.work
  return <section aria-label="她的生活"><h2>她的生活</h2><p>{life.dayKey} · {label[life.locationId]} · 虚构生活，离线不代表实际工作</p>
    <p>{snapshot.companion.sleeping ? '她睡着了' : '她醒着'} <button onClick={() => void send({ type: 'companion.sleep', sleeping: !snapshot.companion.sleeping })}>{snapshot.companion.sleeping ? '唤醒她' : '让她休息'}</button></p>
    <label>今天的作息<select value={life.userSchedule} onChange={(event) => void send({ type: 'life.schedule', schedule: event.target.value })}><option value="auto">日历兜底</option><option value="work">今天工作</option><option value="rest">今天休息</option></select></label>
    <button onClick={() => void send({ type: 'life.propose', place: 'coast' })}>提议去海岸</button><button onClick={() => void send({ type: 'life.propose', place: 'swing' })}>提议去秋千</button>
    {proposed && <button onClick={() => void send({ type: 'life.depart', outingId: proposed.id })}>同意这次外出</button>}{life.locationId !== 'room' && <button onClick={() => void send({ type: 'life.return' })}>请她提前回来</button>}
    <ul>{life.items.map((item) => <li key={item.id}>{item.kind === 'shell' ? '贝壳' : '树叶'} · {item.dayKey} · {label[item.place]} · {item.display === 'desk' ? '书桌' : '抽屉'}<small> · {item.outingId.slice(-8)}</small></li>)}</ul>
    {work && <section aria-label="书桌作品"><h3>书桌作品</h3><p>{work.source === 'fake' ? '合成材料与 fake 模型' : work.source === 'none' ? '自主作品模型尚未接通' : '后台模型 · 合成材料'} · {work.enabled ? '已启用' : '已暂停'} · 今日调用 {work.attemptsToday}/{work.dailyAttemptLimit}</p>
      <p>她在用户工作且没有被交付任务时推进。休息、熄灯和前台任务会让出；重启后可从已落盘的一步续做。</p>
      {snapshot.runtime?.developer.mode === 'developer' && <button onClick={() => void send({ type: 'developer.life.seed' })}>放入合成阅读材料</button>}
      <button disabled={!work.enabled || !work.materials.length || work.source === 'none'} onClick={() => void send({ type: 'life.work.start', kind: 'read' })}>开始今日阅读</button>
      <button disabled={!work.enabled || !work.materials.length || work.source === 'none'} onClick={() => void send({ type: 'life.work.start', kind: 'write' })}>开始今日写作</button>
      <ul>{work.jobs.map((job) => <li key={job.id} data-work-id={job.id}>{job.dayKey} · {job.kind === 'read' ? '阅读笔记' : '写作'} · {job.status} · {job.completedSteps}/{job.totalSteps}{job.reason ? ' · ' + job.reason : ''}
        {job.output && <><small> · 书桌/{job.output.path}</small><button onClick={() => void send({ type: 'life.work.open', workId: job.id })}>查阅作品</button></>}
        {job.status !== 'completed' && <><button disabled={job.status === 'paused' && job.reason === 'user'} onClick={() => void send({ type: 'life.work.pause', workId: job.id })}>暂停作品</button><button disabled={!work.enabled || job.status === 'running'} onClick={() => void send({ type: 'life.work.resume', workId: job.id })}>续做作品</button></>}
      </li>)}</ul>
    </section>}
    {error && <p role="alert">{error}</p>}
  </section>
}
