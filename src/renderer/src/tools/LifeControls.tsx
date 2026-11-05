import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'
/**
 * 她的生活与书桌。日常只需要两件事：她醒着还是睡着、今天的作息怎么算。
 * 带物品 id 的清点、合成阅读材料、三步作品的控制都是工程与调试用的，收在下面一个折叠里，
 * 默认展开（自动化脚本要能直接点到），视觉上明显淡一档。
 */
export function LifeControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const life = snapshot.life; if (!life) return null
  const send = async (body: Record<string, unknown>) => { try { const result = await bridge.dispatch({ ...body, protocolVersion: 1, epoch: snapshot.epoch, requestId: crypto.randomUUID() } as AppCommand); setError(result.status === 'rejected' ? result.error.code : '') } catch { setError('connection-failed') } }
  const label: Record<string, string> = { room: '房间', coast: '海岸', swing: '秋千', bookstore: '书店', cafe: '咖啡馆', rooftop: '天台', store: '便利店' }
  const placeOf = (id: string) => label[id] ?? '外面'
  const work = life.work
  const place = placeOf(life.locationId)
  return <section aria-label="她的生活"><h2>她的生活</h2>
    <p>当前在{place} · 闲暇时她会有自己的日常</p>
    <p>{snapshot.companion.sleeping ? '她睡着了' : '她醒着'} <button onClick={() => void send({ type: 'companion.sleep', sleeping: !snapshot.companion.sleeping })}>{snapshot.companion.sleeping ? '唤醒她' : '让她睡会儿'}</button></p>
    <label>今天的作息<select value={life.userSchedule} onChange={(event) => void send({ type: 'life.schedule', schedule: event.target.value })}><option value="auto">日历兜底</option><option value="work">今天工作</option><option value="rest">今天休息</option></select></label>

    <details className="settings-advanced" open>
      <summary>生活与书桌作品详情</summary>
      <p className="settings-advanced-note">以下是她生活与后台作品的明细：带回来的每件东西、她在书桌上读写的三步进度，以及开发和排查用的合成材料。</p>
      <ul>{life.items.map((item) => <li key={item.id}>{item.kind === 'shell' ? '贝壳' : '树叶'} · {item.dayKey} · {placeOf(item.place)} · {item.display === 'desk' ? '书桌' : '抽屉'}<small> · {item.outingId.slice(-8)}</small></li>)}</ul>
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
    </details>
    {error && <p role="alert">{error}</p>}
  </section>
}
