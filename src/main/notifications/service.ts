import { randomUUID } from 'node:crypto'
import type { AppCommand, CandidateView, NotificationRule, NotificationsView, PublicErrorCode } from '../../shared'
import type { Clock } from '../clock'
import type { Scheduler } from '../scheduler'
import type { SessionStore } from '../store/session'
import type { HarnessTool } from '../harness/tools'
import { z } from 'zod'
import { notificationRuleInput, notificationRule } from './schema'
import templates from './prompts.json'
const labels = { 'teaching-assistant': '课程助教', 'student-club': '社团活动', library: '图书馆', other: '校园信息' }
export function createNotifications(options: { clock: Clock; store: SessionStore; scheduler: Scheduler; candidates(): readonly CandidateView[]; approval(): string | undefined; synthetic: boolean; changed(): void; notify(input: { kind: 'urgent-mail' | 'flow-approval'; title: string; body: string }): void }) {
  const { clock, store } = options; const rows = () => store.history?.() ?? store.records()
  const rules = () => rows().reduce<NotificationRule[]>((result, row) => row.type === 'notification/rule' ? [...result.filter((rule) => rule.id !== row.rule.id), ...(row.enabled ? [row.rule] : [])] : result, [])
  let pending = new Map<string, { kind: 'urgent-mail' | 'flow-approval'; deadline?: number }>(); let pendingAt: number | undefined; let enabled = true
  const proposal = () => { const row = rows().findLast((row) => row.type === 'notification/proposal'); return row?.type === 'notification/proposal' ? row.rule ?? undefined : undefined }
  const sent = () => rows().filter((row) => row.type === 'notification/sent')
  const sentHour = () => sent().filter((row) => row.atMs > clock.nowMs() - 3600000).length
  const collect = () => {
    const result = new Map<string, { kind: 'urgent-mail' | 'flow-approval'; deadline?: number }>()
    if (!enabled || store.projection().lightsOut) return result
    const approvedRules = rules()
    for (const item of options.candidates()) {
      if (item.status === 'ignored') continue
      const deadline = item.deadlineIso ? clock.parse(item.deadlineIso) : NaN
      const urgent = Number.isFinite(deadline) && deadline >= clock.nowMs() && deadline - clock.nowMs() <= 86400000
      const byRule = approvedRules.some((rule) => (rule.sourceRole === 'any' || item.sourceLabel.startsWith(labels[rule.sourceRole] + ' · ')) && item.title.includes(rule.keyword))
      if (urgent || byRule || item.urgency && item.urgency !== 'normal') result.set('mail:' + item.id + ':' + (item.revision ?? 1), { kind: 'urgent-mail', ...(Number.isFinite(deadline) ? { deadline } : {}) })
    }
    const approval = options.approval(); const view = store.projection()
    if (approval && (view.pomodoro.phase === 'focus' || view.mode === 'quiet')) result.set('approval:' + approval, { kind: 'flow-approval' })
    const delivered = new Set(sent().flatMap((row) => row.type === 'notification/sent' ? row.keys : [])); for (const key of delivered) result.delete(key)
    return result
  }
  const reconcile = () => {
    pending = collect()
    if (!pending.size) { pendingAt = undefined; return }
    pendingAt ??= clock.nowMs()
    if (clock.nowMs() - pendingAt < 15000 || sentHour() >= 3) return
    const kind = [...pending.values()].some((item) => item.kind === 'flow-approval') ? 'flow-approval' as const : 'urgent-mail' as const
    const batch = [...pending].filter(([, value]) => value.kind === kind).slice(0, 32)
    const deadline = batch.map(([, value]) => value.deadline).filter((value): value is number => value !== undefined).sort((a, b) => a - b)[0]
    // Reserve deduplication before attempting OS delivery: unknown delivery is never blindly repeated.
    store.append({ type: 'notification/sent', kind, keys: batch.map(([key]) => key) })
    const title = kind === 'flow-approval' ? templates.approvalTitle : templates.urgentTitle
    const body = kind === 'flow-approval' ? templates.approvalBody : templates.urgentBody.replace('{count}', String(batch.length)).replace('{deadline}', deadline ? '最近截止：' + clock.iso(deadline) : '')
    try { options.notify({ kind, title, body }) } catch { /* Delivery is unknown; keep its durable reservation. */ }
    pendingAt = undefined; options.changed()
  }
  options.scheduler.schedule('notifications.merge', clock.nowMs() + 5000, reconcile, { everyMs: 5000 })
  return { reconcile,
    view: (): NotificationsView => ({ rules: rules(), ...(proposal() ? { proposal: proposal() } : {}), pendingCount: pending.size, sentLastHour: sentHour(), delivery: options.synthetic ? 'synthetic' : 'native' }),
    propose: (input: unknown) => { const rule = notificationRule.parse({ ...notificationRuleInput.parse(input), id: randomUUID() }); store.append({ type: 'notification/proposal', rule }); options.changed(); return rule.id },
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'notification.rule.add') {
        if (rules().length >= 20) return 'unavailable'; const rule = notificationRule.parse({ ...notificationRuleInput.parse({ sourceRole: command.sourceRole, keyword: command.keyword }), id: randomUUID() }); store.append({ type: 'notification/rule', rule, enabled: true }); options.changed(); return
      }
      if (command.type === 'notification.rule.remove') { const rule = rules().find((rule) => rule.id === command.ruleId); if (!rule) return 'invalid-command'; store.append({ type: 'notification/rule', rule, enabled: false }); options.changed(); return }
      if (command.type === 'notification.rule.confirm' || command.type === 'notification.rule.discard') { const rule = proposal(); if (!rule || rule.id !== command.ruleId) return 'invalid-command'; if (command.type === 'notification.rule.confirm') { if (rules().length >= 20) return 'unavailable'; store.append({ type: 'notification/rule', rule, enabled: true }) }; store.append({ type: 'notification/proposal', rule: null }); options.changed(); return }
      return 'invalid-command'
    }, setEnabled: (value: boolean) => { enabled = value; if (!value) { pending.clear(); pendingAt = undefined }; options.changed() }, close: () => options.scheduler.cancel('notifications.merge'),
  }
}
export type NotificationsService = ReturnType<typeof createNotifications>
export function notificationTools(service: NotificationsService): HarnessTool[] { return [{ definition: { name: 'propose_notification_rule', description: templates.ruleTool, parameters: z.toJSONSchema(notificationRuleInput) }, templateId: 'notification.propose', validate: (input) => notificationRuleInput.safeParse(input).success, run: async (input) => { const id = service.propose(input); return { ok: true, raw: { proposalId: id }, visible: { proposalId: id, requiresUserConfirmation: true } } } }] }
