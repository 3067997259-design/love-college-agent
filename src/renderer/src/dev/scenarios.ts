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
  items: [{ text: '数据结构第三次作业', count: 3, assist: false }, { text: '一起过一遍新邮件', count: 1, assist: true }],
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
    pomodoro: { ...s.pomodoro, proposal: afternoonPlan('proposed') },
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

  /** 外出：保留空房间，去向和回来的时间写在桌上纸条（2026-10-16 用户定；地点、时间都由主进程给） */
  'out-shore': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1910 - 2 * 60 * MIN },
    companion: { ...s.companion, locationId: 'coast', pose: 'facing-user', expression: 'smile' },
    life: {
      dayKey: '2026-10-17', userSchedule: 'rest', locationId: 'coast', settledUntilMs: T.sat1910 - 2 * 60 * MIN, agenda: [],
      outings: [{ id: 'out-coast', place: 'coast', startsAtMs: T.sat1445 + 15 * MIN, returnsAtMs: T.sat1910 - 45 * MIN, acquiredAtMs: T.sat1910 - 90 * MIN, item: 'shell', status: 'away', settledAtMs: null, offline: false }],
      items: [{ id: 'item-leaf', outingId: 'out-swing', dayKey: '2026-10-16', place: 'swing', kind: 'leaf', acquiredAtMs: T.fri2105 - 4 * 60 * MIN, display: 'desk' }],
    },
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

  /** 书桌心流：可写执行中，她要运行一段代码等你批准；一个分身在查、一个已交回（右页工作视图） */
  'flow-working': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1420 + 12 * MIN },
    companion: { ...s.companion, mode: 'work', pose: 'desk-computer', expression: 'think' },
    heartFlow: {
      activeId: 'flow-1', mode: 'execute', execution: 'javascript-sandbox',
      pending: { id: 'run-2', code: "const due = ['10-21 12:00', '10-26 23:59', '10-19 20:00']\nreturn due.sort().join('\\n')" },
      files: [{ path: '整理/作业清单.md', byteLength: 420 }, { path: 'answer.js', byteLength: 9 }],
      changes: [{ id: 'c1', path: 'answer.js', undone: true }, { id: 'c2', path: '整理/作业清单.md', undone: false }],
      sessions: [{ id: 'flow-1', startedAtMs: T.sat1420, endedAtMs: null, summary: null }],
      lastRun: { ok: true, output: '3 项待办，最早的周一 20:00' },
      delegates: [
        { id: 'd1', flowId: 'flow-1', status: 'completed', source: 'fake', sourceCount: 2, createdAtMs: T.sat1420 + 4 * MIN, updatedAtMs: T.sat1420 + 6 * MIN },
        { id: 'd2', flowId: 'flow-1', status: 'running', source: 'fake', sourceCount: 3, createdAtMs: T.sat1420 + 10 * MIN, updatedAtMs: T.sat1420 + 11 * MIN },
      ],
    },
    messages: [
      msg('m1', 'user', '把这周的作业整理成一张清单，放在书桌上。', T.sat1420),
      msg('m2', 'assistant', '先列计划：读三封邮件里的要求，按截止时间排，写进“整理/作业清单.md”。批准了我再动笔。', T.sat1420 + MIN, { emotion: 'think' }),
      msg('m3', 'assistant', '清单写好了。我想再核对一遍时间顺序，这一段要运行一下，等你点头。', T.sat1420 + 11 * MIN, { emotion: 'calm' }),
    ],
  })),

  /**
   * 傍晚，她从海边回来：窗台上两件带回来的东西，休息时送了你一只杯子，纸桥还在做；
   * 前天的日记解锁了，钥匙夹在丝带上（书签页：?scenario=evening-home&tab=gifts）
   */
  'evening-home': scenario((s) => ({
    clock: { ...s.clock, nowMs: T.sat1910 },
    companion: { ...s.companion, mode: 'rest', daypart: 'evening', pose: 'facing-user', expression: 'smile' },
    pomodoro: { ...s.pomodoro, focusIndex: 4, plannedCount: 4, completedCount: 4, plan: afternoonPlan('finished') },
    candidates: candidates.map((c) => ({ ...c, status: 'confirmed' as const })),
    messages: [
      msg('m1', 'assistant', '回来了。海边风很大，捡了一个贝壳，放在窗台上了。', T.sat1910 - 40 * MIN, { emotion: 'smile' }),
      msg('m2', 'user', '杯子很好看。', T.sat1910 - 6 * MIN),
      msg('m3', 'assistant', '嗯。你说过想喝点热的。', T.sat1910 - 5 * MIN, { emotion: 'calm' }),
    ],
    quill: { id: 'quill:fake', kind: 'quill', state: 'given', createdAtMs: T.fri2105 - 8_000, givenAtMs: T.fri2105, sourceMemoryId: 'mem:fake-first-work', sourceEventId: 'first-work:fake' },
    memory: {
      status: 'idle', source: 'fake', shortTermCount: 2, longTermCount: 0, contextChars: 0, lastExtractedAtMs: null, lastCompactedAtMs: null,
      items: [
        { id: 'mem-tea', text: '周五晚上写完作业，你说想喝一杯热的。', kind: 'experience', tier: 'short_term', reviewStatus: 'unreviewed', createdAtMs: T.fri2105, accessCount: 1, sourceSessionCount: 1 },
        { id: 'mem-bridge', text: '你把纸桥放在书桌上，给它取名叫周五桥。', kind: 'experience', tier: 'short_term', reviewStatus: 'unreviewed', createdAtMs: T.sat1445, accessCount: 0, sourceSessionCount: 1 },
      ],
    },
    gifts: {
      configured: true, dailyLimit: 1,
      items: [
        { id: 'gift-cup', sourceMemoryId: 'mem-tea', objectId: 'cup', motif: 'sakura', status: 'given', source: 'fake', createdAtMs: T.sat1420, readyAtMs: T.sat1445, givenAtMs: T.sat1910 - 8 * MIN },
        { id: 'gift-bridge', sourceMemoryId: 'mem-bridge', objectId: 'paper-bridge', motif: 'plain', status: 'proposed', source: 'fake', createdAtMs: T.sat1910 - 2 * MIN, readyAtMs: null, givenAtMs: null },
      ],
    },
    life: {
      dayKey: '2026-10-17', userSchedule: 'rest', locationId: 'room', settledUntilMs: T.sat1910,
      agenda: [
        { kind: 'read', atMs: T.sat0810 + 60 * MIN, state: 'settled' },
        { kind: 'walk', atMs: T.sat1420 + 30 * MIN, state: 'settled' },
        { kind: 'write', atMs: T.sat2240, state: 'planned' },
      ],
      outings: [
        { id: 'out-coast', place: 'coast', startsAtMs: T.sat1445 + 15 * MIN, returnsAtMs: T.sat1910 - 45 * MIN, acquiredAtMs: T.sat1910 - 90 * MIN, item: 'shell', status: 'returned', settledAtMs: T.sat1910 - 45 * MIN, offline: false },
      ],
      items: [
        { id: 'item-leaf', outingId: 'out-swing', dayKey: '2026-10-16', place: 'swing', kind: 'leaf', acquiredAtMs: T.fri2105 - 4 * 60 * MIN, display: 'desk' },
        { id: 'item-shell', outingId: 'out-coast', dayKey: '2026-10-17', place: 'coast', kind: 'shell', acquiredAtMs: T.sat1910 - 90 * MIN, display: 'desk' },
      ],
      // 书桌作品：读完一份、写了一步被你叫停（只有元数据；正文在她的书桌里，预览里看不了）
      work: {
        enabled: true, source: 'fake', runningId: null, attemptsToday: 2, dailyAttemptLimit: 4,
        materials: [
          { id: 'mat-town', path: '书桌/材料/海边的小镇.md', sha256: 'f'.repeat(64), source: 'fake' },
          { id: 'mat-autumn', path: '书桌/材料/十月的风.md', sha256: 'e'.repeat(64), source: 'fake' },
        ],
        jobs: [
          { id: 'work-read', dayKey: '2026-10-17', kind: 'read', source: 'fake', materialId: 'mat-town', status: 'completed', completedSteps: 3, totalSteps: 3, createdAtMs: T.sat0810, updatedAtMs: T.sat0810 + 40 * MIN, completedAtMs: T.sat0810 + 40 * MIN, output: { path: '书桌/读书笔记/海边的小镇.md', sha256: 'a'.repeat(64), byteLength: 1820 } },
          { id: 'work-write', dayKey: '2026-10-17', kind: 'write', source: 'fake', materialId: 'mat-autumn', status: 'paused', completedSteps: 1, totalSteps: 3, createdAtMs: T.sat1420, updatedAtMs: T.sat1445, completedAtMs: null, reason: 'user', output: { path: '书桌/草稿/十月的风-1.md', sha256: 'b'.repeat(64), byteLength: 640 } },
        ],
      },
    },
    diary: {
      status: 'idle', source: 'fake',
      entries: [
        { id: 'diary-1015', dayKey: '2026-10-15', createdAtMs: T.fri2105 - 12 * 60 * MIN, unlocked: true, clue: 'next-bookmark', source: 'fake' },
        { id: 'diary-1016', dayKey: '2026-10-16', createdAtMs: T.sat0810, unlocked: false, clue: 'next-bookmark', source: 'fake' },
      ],
    },
    // 往回翻：前两天各一页（内容在 fakePages，经假桥的 readSession 读）
    session: {
      dayKey: '2026-10-17', rolloverPending: false,
      pages: [
        { sessionId: 's-1015', dayKey: '2026-10-15', messageCount: 4, summarized: true },
        { sessionId: 's-1016', dayKey: '2026-10-16', messageCount: 4, summarized: true },
        { sessionId: 'fake-session', dayKey: '2026-10-17', messageCount: 3, summarized: false },
      ],
    },
    history: { photos: [], captureStatus: 'idle', recall: { status: 'idle' } },
    // 可选光学记忆：10-16 那页封成一张，四档读回来（印象内容在 fakeImpressions，经假桥 readOpticalMemory 读）
    opticalMemory: {
      enabled: true, source: 'fake', status: 'idle',
      frames: [{ id: 'frame-1016', sessionId: 's-1016', createdAtMs: T.sat0810, sourceCount: 4, pageIndex: 0, pageCount: 1 }],
      impressions: (['large', 'base', 'small', 'tiny'] as const).map((tier, index) => ({
        frameId: 'frame-1016', tier, createdAtMs: T.sat0810, status: index < 2 ? 'guarded' as const : 'rejected' as const, verifiedLineCount: Math.max(0, 3 - index), rejectedLineCount: index,
      })),
    },
  })),
} satisfies Record<string, AppSnapshot>

export type ScenarioId = keyof typeof SCENARIOS
export const DEFAULT_SCENARIO: ScenarioId = 'break-delivery'

/**
 * 预览用的旧页（fake-bridge.readSession）：recallable 模拟主进程核对过“她当时看见”的句子，
 * 每页最后一句回复没有被再次看见，所以不能引用；photoPose 是借来当照片的整景图，10-15 那页故意没有照片。
 */
export const fakePages: Record<string, { dayKey: string; messages: MessageView[]; recallable: string[]; photoPose: string | null }> = {
  's-1015': {
    dayKey: '2026-10-15', photoPose: null, recallable: ['h1', 'h2', 'h3'],
    messages: [
      msg('h1', 'user', '你好。', T.fri2105 - 2 * 24 * 60 * MIN),
      msg('h2', 'assistant', '你好。我住在这本书里。', T.fri2105 - 2 * 24 * 60 * MIN + MIN),
      msg('h3', 'user', '这个房间是我画的？', T.fri2105 - 2 * 24 * 60 * MIN + 2 * MIN),
      msg('h4', 'assistant', '嗯。线条是你的，颜色是我上的。', T.fri2105 - 2 * 24 * 60 * MIN + 3 * MIN),
    ],
  },
  's-1016': {
    dayKey: '2026-10-16', photoPose: 'desk-computer_calm', recallable: ['k1', 'k2', 'k3'],
    messages: [
      msg('k1', 'user', '明天要写数据结构的作业。', T.fri2105 - 30 * MIN),
      msg('k2', 'assistant', '好。邮件我先读着，你写的时候我不说话。', T.fri2105 - 29 * MIN),
      msg('k3', 'user', '写完了想喝点热的。', T.fri2105 - 5 * MIN),
      msg('k4', 'assistant', '记下了。', T.fri2105 - 4 * MIN),
    ],
  },
}

/** 预览用的光学印象：每档还能对上原话的整行残片（假数据；真实的由主进程的守卫回查当时可见的来源） */
export const fakeImpressions: Record<string, { tier: 'large' | 'base' | 'small' | 'tiny'; status: 'guarded' | 'rejected'; fragments: string[]; rejectedLineCount: number }[]> = {
  'frame-1016': [
    { tier: 'large', status: 'guarded', fragments: ['明天要写数据结构的作业。', '写完了想喝点热的。', '记下了。'], rejectedLineCount: 0 },
    { tier: 'base', status: 'guarded', fragments: ['写完了想喝点热的。'], rejectedLineCount: 1 },
    { tier: 'small', status: 'rejected', fragments: [], rejectedLineCount: 2 },
    { tier: 'tiny', status: 'rejected', fragments: [], rejectedLineCount: 3 },
  ],
}

/** 预览用的日记正文：假数据，不是她最终的声音；只有解锁的才读得到（fake-bridge.readDiary） */
export const fakeDiary: Record<string, string> = {
  'diary-1015': '主观日记（预览用的假数据）\n今天书里来了一个人。名字写得很用力，铅笔差点把纸划破。\n房间是那个人画的，颜色是我涂的。窗台上还空着。\n明天想去海边看看。不知道会不会有人问我去了哪里。',
}
