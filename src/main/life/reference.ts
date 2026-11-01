import type { LifeView, OutingView } from '../../shared'
import type { Clock } from '../clock'

const statusMeaning: Record<OutingView['status'], string> = {
  proposed: '尚未出发的计划', away: '已经出发，尚未返回', returned: '已经返回',
  cut_short: '提前结束并已返回', cancelled: '计划已取消，没有因此出发',
}
export const worldFactsNote = '生活状态以本轮记录为准。计划时间经过、当前在房间，都不代表已经出行或返回。possibleSouvenir 仅是计划可能带回的物品；只有 broughtItems 和 items 是实际取得的物品。可自然讲述，但不要把计划、预期或旧回复说成已发生的经历。生活记录属于虚构角色生活，不是现实工作证明。'

/** A model projection, not a storage migration. In particular acquiredAtMs on an
 * outing is a scheduled threshold, NOT evidence of acquisition. */
export function outingReference(outing: OutingView, items: LifeView['items'], clock: Clock) {
  const time = (at: number) => clock.iso(at + 8 * 3600000).replace('Z', '+08:00')
  const ended = outing.status === 'returned' || outing.status === 'cut_short'
  const departed = ended || outing.status === 'away'
  return {
    id: outing.id, place: outing.place, status: outing.status, statusMeaning: statusMeaning[outing.status], offline: outing.offline,
    ...(departed ? { departedAt: time(outing.startsAtMs) } : { plannedDepartureAt: time(outing.startsAtMs) }),
    ...(ended ? { returnedAt: outing.settledAtMs === null ? null : time(outing.settledAtMs) }
      : outing.status === 'cancelled' ? {} : { plannedReturnAt: time(outing.returnsAtMs), possibleSouvenir: outing.item }),
    broughtItems: ended ? items.filter(item => item.outingId === outing.id).map(item => ({ kind: item.kind, acquiredAt: time(item.acquiredAtMs), display: item.display })) : [],
  }
}

export function lifeReference(world: LifeView, clock: Clock) {
  const outings = world.outings.slice(-3).map(outing => outingReference(outing, world.items, clock))
  return {
    worldFacts: {
      locationId: world.locationId,
      plannedOutings: outings.filter(outing => outing.status === 'proposed'),
      currentOutings: outings.filter(outing => outing.status === 'away'),
      completedOutings: outings.filter(outing => outing.status === 'returned' || outing.status === 'cut_short'),
      cancelledOutings: outings.filter(outing => outing.status === 'cancelled'),
      ownedItemCount: world.items.length, items: world.items.slice(-3),
      coverage: '最近三次出行与最近三件实际物品，非完整生活历史',
    },
    worldFactsNote,
    actualWorks: world.work?.jobs.slice(-6).map(({ id, kind, source, materialId, status, completedSteps, totalSteps, completedAtMs }) => ({ id, kind, source, materialSource: world.work?.materials.find(material => material.id === materialId)?.source ?? 'unknown', status, completedSteps, totalSteps, completedAtMs })),
    fictional: true, actualOfflineWork: false,
  }
}
