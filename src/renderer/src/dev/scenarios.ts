/**
 * 假快照：按体验设计 §3 的状态表，每种状态一份完整的 AppSnapshot。
 * 只在没有 preload（纯浏览器预览）时使用，内容取自 docs/demo-emails.md。
 * 这些数据是演示数据，capabilities 一律标 source: 'fake'，不代表任何真实调用通过。
 */
import type {
  ActivityView, AppSnapshot, CandidateView, CapabilityView, DeliveryView, EvidenceView, MessageView, PomodoroPlanView,
} from '../../../shared'

// 2026-10-17（周六）各时刻，UTC+8
const T = {
  fri2105: 1792155900000,
  sat0810: 1792195800000,
  sat1420: 1792218000000,
  sat1445: 1792219500000,
  sat1910: 1792235400000,
  sat2240: 1792248000000,
  sun0430: 1792269000000,
} as const
const MIN = 60_000

const capabilities = (overrides: Partial<Record<CapabilityView['id'], Partial<CapabilityView>>> = {}): CapabilityView[] =>
  (['chat', 'pomodoro', 'mail', 'privacy', 'memory', 'backup', 'mcp', 'rodin', 'heart-flow'] as const).map((id) => ({
    id, status: 'ready', source: 'fake', ...overrides[id],
  }))

const act = (id: string, templateId: string, status: ActivityView['status'], fields: ActivityView['fields'] = {}, extra: Partial<ActivityView> = {}): ActivityView =>
  ({ id, taskId: 'task-mail', toolCallId: `tc-${id}`, templateId, status, fields, ...extra })

const msg = (id: string, role: MessageView['role'], text: string, createdAtMs: number, extra: Partial<MessageView> = {}): MessageView =>
  ({ id, role, text, createdAtMs, status: 'complete', ...extra })

/** 下午的计划：路演用演示节奏（专注 1 分钟、休息 20 秒），界面上写明“演示节奏” */
const afternoonPlan = (status: PomodoroPlanView['status']): PomodoroPlanView => ({
  id: 'plan-sat-pm', createdAtMs: T.sat1420 - 3 * MIN, status, source: 'assistant',
  label: '下午：作业和邮件', plannedCount: 4, timing: 'demo',
  focusDurationMs: 60_000, shortBreakDurationMs: 20_000, longBreakDurationMs: 20_000, longBreakEvery: 4,
})

/* —— 休息段她带来的东西：三封邮件 → 两张候选卡、一张已确认，加两份交付 —— */
const candidates: CandidateView[] = [
  {
    id: 'cand-hw3', createdAtMs: T.sat1445 - 40_000, kind: 'deadline',
    title: '数据结构与算法基础 · 第三次作业',
    deadlineIso: '2026-10-26T23:59:00+08:00', plannedCompletionIso: '2026-10-24T21:00:00+08:00',
    status: 'changed', sourceLabel: '课程助教 · 截止时间更正', evidenceRef: 'ev-hw3-change',
    change: { previousDeadlineIso: '2026-10-24T23:59:00+08:00', previousEvidenceRef: 'ev-hw3' },
  },
  {
    id: 'cand-talk', createdAtMs: T.sat1445 - 30_000, kind: 'event',
    title: '流萤学社经验分享会（需报名）',
    deadlineIso: '2026-10-21T12:00:00+08:00', plannedCompletionIso: '2026-10-19T20:00:00+08:00',
    eventStartIso: '2026-10-22T19:00:00+08:00', locationText: '东区第二教学楼 316',
    status: 'candidate', sourceLabel: '流萤学社 · 活动报名', evidenceRef: 'ev-talk',
  },
]
const deliveries: DeliveryView[] = [
  {
    id: 'dlv-ics', createdAtMs: T.sat1445 - 20_000, artifactId: 'art-ics',
    displayName: '本周日程.ics', kind: 'calendar', status: 'ready', sourceRefs: ['cand-hw3', 'cand-talk'],
  },
  {
    id: 'dlv-notes', createdAtMs: T.sat1445 - 10_000, artifactId: 'art-notes',
    displayName: '第三次作业要求 · 整理.md', kind: 'markdown', status: 'ready', sourceRefs: ['ev-hw3'],
  },
]

type Field = EvidenceView['highlights'][number]['field']
/** 高亮按原文里的子串算 UTF-16 偏移，找不到就直接报错，免得假数据悄悄错位 */
const ev = (subject: string, senderName: string, receivedAtMs: number, excerpt: string, marks: [string, Field][]): EvidenceView => ({
  subject, senderName, receivedAtMs, excerpt,
  highlights: marks.map(([text, field]) => {
    const start = excerpt.indexOf(text)
    if (start < 0) throw new Error(`evidence highlight not found: ${text}`)
    return { start, end: start + text.length, field }
  }),
})

export const evidence: Record<string, EvidenceView> = {
  'ev-hw3': ev(
    '【作业通知】《数据结构与算法基础》第三次作业（10 月 24 日 23:59 截止）', '宋亦舟（课程助教）', T.fri2105 - 26 * 60 * MIN,
    '提交截止时间：2026 年 10 月 24 日（周六）23:59，以课程平台服务器时间为准。逾期提交按课程规定不计分。',
    [['2026 年 10 月 24 日（周六）23:59', 'deadlineIso']],
  ),
  'ev-hw3-change': ev(
    '【更正】《数据结构与算法基础》第三次作业截止时间延至 10 月 26 日 23:59', '宋亦舟（课程助教）', T.fri2105 + 12 * MIN,
    '因课程平台将于 10 月 24 日至 25 日进行例行维护，现将截止时间调整为 2026 年 10 月 26 日（周一）23:59。',
    [['2026 年 10 月 26 日（周一）23:59', 'deadlineIso']],
  ),
  'ev-talk': ev(
    '【活动报名】流萤学社经验分享会（10 月 22 日 19:00，需报名）', '流萤学社', T.fri2105 + 6 * MIN,
    '时间：2026 年 10 月 22 日（周四）19:00–20:30\n地点：东区第二教学楼 316 教室\n报名截止：下周三中午前；座位有限，先报先得。',
    [['2026 年 10 月 22 日（周四）19:00–20:30', 'eventStartIso'], ['东区第二教学楼 316 教室', 'locationText'], ['下周三中午前', 'deadlineIso']],
  ),
}

const base: AppSnapshot = {
  protocolVersion: 1,
  epoch: 'fake-epoch',
  revision: 1,
  scope: { userId: 'demo-user', characterId: 'taozi', sessionId: 'fake-session' },
  clock: { nowMs: T.sat1420, timeZone: 'Asia/Shanghai', rate: 1, frozen: false },
  companion: {
    mode: 'rest', lightsOut: false, locationId: 'room', pose: 'facing-user', expression: 'calm',
    daypart: 'day', mailboxUnseen: 0,
  },
  pomodoro: { phase: 'idle', status: 'idle', remainingMs: 0, endsAtMs: null, focusIndex: 0, phaseDurationMs: 0, plannedCount: 0 },
  task: null,
  messages: [],
  activities: [],
  candidates: [],
  deliveries: [],
  capabilities: capabilities(),
  privacy: { mode: 'isolated', fileFilteringEnabled: true },
}

const scenario = (patch: (s: AppSnapshot) => Partial<AppSnapshot>): AppSnapshot => ({ ...base, ...patch(base) })

export const SCENARIOS = {
  /** 早晨，她在房间里，面向你；有一封新邮件，信箱口露出一封信 */
  'morning-idle': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat0810 },
    companion: { ...s.companion, daypart: 'morning', mailboxUnseen: 1 },
    messages: [msg('m1', 'assistant', '早。昨晚的三封邮件我还没拆，等你开始专注再看。', T.sat0810 - 2 * MIN, { emotion: 'calm' })],
  })),

  /** 排计划：你说了下午要做的事，她排成四个番茄，等你确认才生效（技术方案 §3.5） */
  'plan-proposed': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1420 - 2 * MIN },
    companion: { ...s.companion, mode: 'rest', pose: 'facing-user', expression: 'smile', mailboxUnseen: 3 },
    pomodoro: { ...s.pomodoro, plannedCount: 4, plan: afternoonPlan('proposed') },
    messages: [
      msg('m1', 'user', '下午要写数据结构第三次作业，那几封邮件也还没看。', T.sat1420 - 5 * MIN),
      msg('m2', 'assistant', '排了四个：前三个你写作业，最后一个我们一起过邮件。你写的时候，邮件我先读着。', T.sat1420 - 3 * MIN - 20_000, { emotion: 'smile' }),
    ],
  })),

  /** 专注段：她坐在电脑前干活，不开口；右页只有手写体的活动小字和任务卡 */
  'focus-working': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1420 + 35_000 },
    companion: { ...s.companion, mode: 'quiet', pose: 'desk-computer', expression: 'think', mailboxUnseen: 3 },
    pomodoro: {
      phase: 'focus', status: 'running', remainingMs: 25_000, endsAtMs: T.sat1420 + 60_000,
      focusIndex: 1, phaseDurationMs: 60_000, plannedCount: 4, plan: afternoonPlan('confirmed'),
    },
    task: {
      id: 'task-mail', status: 'running', steps: [
        { id: 's1', text: '读“桃子”文件夹里的三封新邮件', status: 'done' },
        { id: 's2', text: '把作业要求 PDF 交给学校的模型整理', status: 'active' },
        { id: 's3', text: '把截止时间排进日程文件', status: 'pending' },
      ],
    },
    messages: [
      msg('m1', 'user', '开始专注吧，邮件交给你。', T.sat1420 - 30_000),
      msg('m2', 'assistant', '好。铃响之前我不说话。', T.sat1420 - 20_000, { emotion: 'calm' }),
    ],
    activities: [
      act('a1', 'mail.check', 'completed', { newCount: 3 }),
      act('a2', 'privacy.extract', 'running', { fileName: 'CS2041-第三次作业要求.pdf' }),
    ],
  })),

  /** 休息段：铃响，她转过来，交付卡和候选卡越过中缝来到右页 */
  'break-delivery': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1445 },
    companion: { ...s.companion, mode: 'rest', pose: 'facing-user', expression: 'smile' },
    pomodoro: {
      phase: 'short-break', status: 'running', remainingMs: 14_000, endsAtMs: T.sat1445 + 14_000,
      focusIndex: 1, phaseDurationMs: 20_000, plannedCount: 4, plan: afternoonPlan('confirmed'),
    },
    task: {
      id: 'task-mail', status: 'completed', steps: [
        { id: 's1', text: '读“桃子”文件夹里的三封新邮件', status: 'done' },
        { id: 's2', text: '把作业要求 PDF 交给学校的模型整理', status: 'done' },
        { id: 's3', text: '把截止时间排进日程文件', status: 'done' },
      ],
    },
    messages: [
      msg('m1', 'user', '开始专注吧，邮件交给你。', T.sat1420 - 30_000),
      msg('m2', 'assistant', '好。铃响之前我不说话。', T.sat1420 - 20_000, { emotion: 'calm' }),
      msg('m3', 'assistant', '三封都看完了。作业的截止时间改过一次，现在是 26 号；我按你周五晚上的空档排在了 24 号。分享会要报名，截止是周三中午。', T.sat1445 - 50_000, { emotion: 'smile' }),
    ],
    activities: [
      act('a1', 'mail.check', 'completed', { newCount: 3 }),
      act('a2', 'privacy.extract', 'completed', { fileName: 'CS2041-第三次作业要求.pdf' }),
      act('a3', 'calendar.write', 'completed', { count: 2 }),
    ],
    candidates,
    deliveries,
    quill: { id: 'quill:fake', kind: 'quill', state: 'given', createdAtMs: T.sat1445 - 8_000, givenAtMs: T.sat1445 - 5_000, sourceMemoryId: 'mem:fake-first-work', sourceEventId: 'first-work:fake' },
  })),

  /** 她说到一半：流式输出 */
  'streaming': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1910 },
    companion: { ...s.companion, daypart: 'evening', expression: 'calm' },
    messages: [
      msg('m1', 'user', '今天过得怎么样？', T.sat1910 - 40_000),
      msg('m2', 'assistant', '下午把你的作业要求读了两遍。有一处评分要点写得', T.sat1910 - 5_000, { status: 'streaming', emotion: 'think' }),
    ],
  })),

  /** 夜里：台灯亮着，她低头写自己的东西（安静陪伴） */
  'night-lamp': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat2240 },
    companion: { ...s.companion, mode: 'quiet', daypart: 'night', pose: 'desk-writing', expression: 'calm' },
    messages: [msg('m1', 'assistant', '你先忙。我在写今天的事。', T.sat2240 - 15 * MIN, { emotion: 'calm' })],
  })),

  /** 熄灯：暂停所有后台活动和计时 */
  'lights-out': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat2240 + 20 * MIN },
    companion: { ...s.companion, mode: 'quiet', daypart: 'night', lightsOut: true, pose: 'desk-writing' },
  })),

  /** 外出：保留空房间，去向写在桌上纸条（2026-10-16 用户定） */
  'out-shore': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1910 - 2 * 60 * MIN },
    companion: { ...s.companion, locationId: 'shore', pose: 'facing-user', expression: 'smile' },
  })),

  /** 凌晨四点以后，她睡着了，房间暗下来 */
  'asleep': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sun0430 },
    companion: { ...s.companion, mode: 'quiet', daypart: 'night', pose: 'sleeping', expression: 'calm' },
  })),

  /** 邮箱登录失效 ≠ 没有新邮件（体验设计 §9）：她如实说，消息后带“！” */
  'mail-failed': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1445 },
    companion: { ...s.companion, expression: 'worried' },
    capabilities: capabilities({ mail: { status: 'failed', error: { code: 'connection-failed', retryable: true, detailsId: 'diag-17' } } }),
    activities: [
      act('a1', 'mail.check', 'failed', {}, { error: { code: 'connection-failed', retryable: true, detailsId: 'diag-17' } }),
    ],
    messages: [msg('m1', 'assistant', '邮箱登不上了，所以我不知道有没有新邮件。不是没有，是我看不到。', T.sat1445 - MIN, { emotion: 'worried' })],
  })),
} satisfies Record<string, AppSnapshot>

export type ScenarioId = keyof typeof SCENARIOS
export const DEFAULT_SCENARIO: ScenarioId = 'break-delivery'
