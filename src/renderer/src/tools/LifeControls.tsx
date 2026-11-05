import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
import book from '../voice/book.zh.json'
import { dayKeyLabel } from '../book/life/text'
import { SettingsIssue } from './SettingsIssue'
/**
 * 她的生活与书桌。日常只需要两件事：她醒着还是睡着、今天的作息怎么算。
 * 她带回来的东西、合成阅读材料、三步作品的控制都是明细和调试用的，收在下面一个折叠里，
 * 默认收起，视觉上明显淡一档；自动化脚本打开设置时会把它展开。
 */
export function LifeControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const life = snapshot.life; if (!life) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  const label: Record<string, string> = { room: '房间', coast: '海岸', swing: '秋千', bookstore: '书店', cafe: '咖啡馆', rooftop: '天台', store: '便利店' }
  const placeOf = (id: string) => label[id] ?? '外面'
  const work = life.work
  const sleeping = snapshot.companion.sleeping
  return <section aria-label="她的生活"><h3>她的生活</h3>
    <p>她现在在{placeOf(life.locationId)}{sleeping ? '，睡着了' : ''}</p>
    <div className="settings-actions"><button onClick={() => void send({ type: 'companion.sleep', sleeping: !sleeping })}>{sleeping ? '唤醒她' : '让她睡会儿'}</button></div>
    <label>今天的作息<select value={life.userSchedule} onChange={(event) => void send({ type: 'life.schedule', schedule: event.target.value })}><option value="auto">跟着门牌和番茄钟</option><option value="work">今天工作</option><option value="rest">今天休息</option></select></label>

    <details className="settings-advanced">
      <summary>带回来的东西和书桌作品</summary>
      <p className="settings-advanced-note">她带回来的每件东西，和书桌作品每一步的进度。平时不用管。</p>
      {life.items.length > 0 && <ul>{life.items.map((item) => <li key={item.id}>{item.kind === 'shell' ? '贝壳' : '树叶'} · {dayKeyLabel(item.dayKey)}从{placeOf(item.place)}带回 · 放在{item.display === 'desk' ? '书桌上' : '抽屉里'}</li>)}</ul>}
      {work && <section aria-label="书桌作品"><h3>书桌作品</h3>
        <p>{work.source === 'fake' ? '合成材料和假模型' : work.source === 'none' ? '书桌作品的模型还没接上' : '用后台模型'} · {work.enabled ? '开着' : '停着'} · 今天用了 {work.attemptsToday}/{work.dailyAttemptLimit} 次</p>
        <p className="settings-note">你在工作、又没交给她别的事时，她才做书桌作品。你休息、熄灯或者交代了事，她就先停下。重启后从做完的那一步接着来。</p>
        <div className="settings-actions">
          {snapshot.runtime?.developer.mode === 'developer' && <button onClick={() => void send({ type: 'developer.life.seed' })}>放入合成阅读材料</button>}
          <button disabled={!work.enabled || !work.materials.length || work.source === 'none'} onClick={() => void send({ type: 'life.work.start', kind: 'read' })}>开始今日阅读</button>
          <button disabled={!work.enabled || !work.materials.length || work.source === 'none'} onClick={() => void send({ type: 'life.work.start', kind: 'write' })}>开始今日写作</button>
        </div>
        {work.jobs.length > 0 && <ul>{work.jobs.map((job) => <li key={job.id} data-work-id={job.id}>{dayKeyLabel(job.dayKey)} · {job.kind === 'read' ? '阅读笔记' : '写作'} · {book.schedule.works.status[job.status]} · {job.completedSteps}/{job.totalSteps} 步{job.reason ? ' · ' + book.schedule.works.reason[job.reason] : ''}
          {job.output && <><small> · 书桌/{job.output.path}</small><button onClick={() => void send({ type: 'life.work.open', workId: job.id })}>查阅作品</button></>}
          {job.status !== 'completed' && <><button disabled={job.status === 'paused' && job.reason === 'user'} onClick={() => void send({ type: 'life.work.pause', workId: job.id })}>暂停作品</button><button disabled={!work.enabled || job.status === 'running'} onClick={() => void send({ type: 'life.work.resume', workId: job.id })}>续做作品</button></>}
        </li>)}</ul>}
      </section>}
    </details>
    <SettingsIssue code={error} />
  </section>
}
