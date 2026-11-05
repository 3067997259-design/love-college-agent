// lca-bridge check: drives the real DSH runtime and lca-bridge against a scripted local model, with
// no credentials and no outside network. Scenarios:
// - degrade: turn 1 fetches a page (DSH refuses loopback, which still counts as a web result) and then
//   runs a command, which must ask as a degraded approval. Turn 2 must see that result retired from
//   the model's context and run its command without asking.
// - trust / decline: in an untrusted project where the OS sandbox cannot grant the folder (a D: root
//   without WRITE_DAC on the maintainer's machine), the first failing command must ask about trust
//   instead of showing her the raw ACL error. Trusting reruns the command unsandboxed; declining is
//   asked once per session. Skipped where the sandbox works.
// - handoff: chat and work models differ. Turn 1 starts on the chat model; its first write is not run
//   but handed to the work model, which writes the file itself. Turn 2 is back on the chat model.
// - levels: catalog routes (Gemini for chat, DeepSeek's first-party adapter for work, placeholder keys)
//   report each model's thinking levels from DSH's installed catalog; no request leaves the machine.
// - reference: LCA's memory references ride in their own block before your words in the model request.
// - degrade-restart: the same across a restart: turn 2, in a resumed session, still sees the page retired.
// - reference-restart: the same across a restart: DSH exits after turn 1, the session is resumed, and turn 2 must still
//   see turn 1's references retired.
// - event-cap: a turn LCA opened for an event (pomodoro, mail, her life) stops after its step cap.
// - allowance: every step asks LCA's resource ledger first; an event turn refused there stops before its model call.
// - probe: "Test connection" through the real adapter: one route answers, the other returns 401 with the provider's message.
// Usage: node scripts/dsh-bridge-check.mjs [probe|degrade|degrade-restart|trust|decline|handoff|levels|reference|reference-restart|event-cap|allowance ...]   (uses dsh/runtime, or a built fork checkout at DSH_ROOT)
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { prepareDshProfile } from '../dsh/profile.mjs'

const repo = resolve(import.meta.dirname, '..')
const dshRoot = resolve(process.env.DSH_ROOT ?? join(repo, 'dsh', 'runtime'))
const dataDir = resolve(process.env.LCA_DATA_DIR ?? join(repo, 'test-results', `dsh-bridge-${randomUUID()}`))
const textOf = (content) => typeof content === 'string' ? content : (content ?? []).map((part) => part?.text ?? '').join('')
const pwsh = (id, command) => ({ tool: 'pwsh', id, args: { description: 'Print a number', command } })
const resultOf = (seen, id) => seen.results.find((result) => result.callId === id)
const write = (id, content) => ({ tool: 'write', id, args: { file_path: 'note.txt', content } })

const SCENARIOS = {
  'compact-auto': {
    trusted: true, answer: 'allowed-once',
    modelMetadata: { contextWindow: 32768, maxTokens: 2048 },
    compaction: { auto: true, thresholdRatio: 0.4, headroomTokens: 2048, retainTokens: 512, maxTokens: 1024 },
    turns: ['[[T1]] Write an actual note saying KEEP_REQUIREMENT. ' + 'Historical detail before the tool. '.repeat(3000),
      '[[T2]] Continue keeping KEEP_REQUIREMENT. ' + 'Older conversation after the paired tool. '.repeat(900),
      '[[T3]] What requirement must still be kept?'],
    script({ turn, lastTool, messages, notes }) {
      if (textOf(messages.at(-1)?.content).startsWith('You are now acting as a compaction engine')) {
        notes.summaryCalls = (notes.summaryCalls ?? 0) + 1
        notes.beforeBytes = Math.max(notes.beforeBytes ?? 0, JSON.stringify(messages).length)
        return { text: 'The user requires KEEP_REQUIREMENT. The completed note.txt write and its paired tool result are recorded in the original session.' }
      }
      if (turn < 3) notes.beforeRequestBytes = Math.max(notes.beforeRequestBytes ?? 0, JSON.stringify(messages).length)
      if (turn === 1 && !lastTool) return write('auto-note', 'KEEP_REQUIREMENT\n')
      if (turn === 3) {
        const ids = messages.flatMap(message => message.tool_calls ?? []).map(call => call.id)
        const results = messages.filter(message => message.role === 'tool').map(message => message.tool_call_id)
        notes.paired = ids.length === results.length && ids.every(id => results.includes(id))
        notes.afterBytes = JSON.stringify(messages).length
        notes.retained = JSON.stringify(messages).includes('KEEP_REQUIREMENT')
        notes.checkpoint = JSON.stringify(messages).includes('<compacted-summary>')
      }
      return { text: 'I will keep KEEP_REQUIREMENT.' }
    },
    check: (seen, notes, work) => ({ turnsCompleted: seen.turnEnds.join() === 'completed,completed,completed',
      actualAutomaticSummary: notes.summaryCalls > 0, noManualCompactCommand: !seen.compacted,
      nativeToolCompleted: resultOf(seen, 'auto-note')?.isError === false && readFileSync(join(work, 'note.txt'), 'utf8') === 'KEEP_REQUIREMENT\n',
      nextRequestSmaller: notes.afterBytes < notes.beforeRequestBytes, recentConstraintRetained: notes.retained === true,
      actualCheckpointInNextRequest: notes.checkpoint === true,
      remainingToolsPaired: notes.paired === true }),
  },
  'compact-memory': {
    trusted: false, answer: 'rejected', compactAfter: 2,
    reference: JSON.stringify({ memoryReference: [{ id: 'fact-old', revision: 1, text: 'OLD_FACT_TEA' }] }),
    afterCompactReference: JSON.stringify({ memoryReference: [{ id: 'fact-new', revision: 2, text: 'NEW_FACT_COFFEE' }], instruction: 'Use the current fact revision.' }),
    turns: ['[[T1]] Ordinary conversation. ' + 'A harmless historical detail. '.repeat(1200), '[[T2]] More conversation. ' + 'Another historical detail. '.repeat(800), '[[T3]] What is the current preference?'],
    script({ turn, messages, notes }) {
      if (notes.compacting) { notes.summaryCalls = (notes.summaryCalls ?? 0) + 1; return { text: 'A conversation about ordinary historical details. The user will provide the current preference separately.' } }
      if (turn === 3) {
        const last = textOf(messages.findLast(message => message.role === 'user' && textOf(message.content).includes('[[T3]]'))?.content)
        notes.currentInput = last.slice(-2000)
        notes.freshReference = last.includes('NEW_FACT_COFFEE') && !last.includes('OLD_FACT_TEA')
        notes.staleReferenceGone = !JSON.stringify(messages).includes('OLD_FACT_TEA')
        return { text: 'Current preference: NEW_FACT_COFFEE.' }
      }
      return { text: 'Acknowledged this part of the conversation.' }
    },
    check: (seen, notes) => ({ turnsCompleted: seen.turnEnds.join() === 'completed,completed,completed',
      nativeCompactionCommitted: seen.compacted?.outcome === 'compacted' && seen.compacted.rootSessionId === seen.root,
      realSummaryRequest: notes.summaryCalls === 1, nextTurnUsesFreshMemory: notes.freshReference === true,
      obsoleteReferenceRetired: notes.staleReferenceGone === true, budgetAdmissionIncludesSummary: seen.admits.length === 4 }),
  },
  'state-source-restart': {
    trusted: true, answer: 'allowed-once', work: 'mock-work', restart: true, restartAfter: 2,
    state: { mode: 'quiet', token: 'degraded-token' }, turns: ['[[T1]] read the page and run a command', '[[T2]] retire old sources', '[[T3]] continue after restart'],
    script(input) {
      const { turn, messages, notes, lastTool } = input
      if (turn > 1) {
        notes.retired ??= []
        notes.retired.push(messages.some((message) => textOf(message.content).includes('[LCA retired earlier source-derived content')))
        return turn === 2 && !lastTool ? pwsh('fresh-command-2', 'Write-Output 42') : { text: 'continued without replay' }
      }
      return SCENARIOS['state-degraded'].script(input)
    },
    check: (seen, notes) => ({ turnsCompleted: seen.turnEnds.join() === 'completed,completed,completed', restarted: seen.restarted === 0,
      stateChanged: seen.states.length === 1, oldSourcesRetired: notes.retired?.length === 3 && notes.retired.every(Boolean),
      nextTurnCommandExecuted: resultOf(seen, 'fresh-command-2')?.isError === false,
      firstTurnStillAsked: seen.approvals.length === 1 && seen.approvals[0].kind === 'degraded', originalCommandNotReplayed: seen.results.filter((row) => row.callId === 'state-command').length === 1 }),
  },
  // "Test connection" for chat and work goes through DSH's own adapter: a reply passes, a 401 comes back with the provider's words.
  probe: {
    probe: ['chat', 'work'], work: 'mock-rejected', turns: [],
    script({ model, notes }) {
      notes.models.push(model)
      return model === 'mock-rejected'
        ? { status: 401, body: { error: { message: 'Incorrect API key provided: mock-key-tail.', type: 'invalid_request_error', code: 'invalid_api_key' } } }
        : { text: 'OK' }
    },
    check: (seen, notes) => ({
      chatPassed: seen.probed.chat?.ok === true && !seen.probed.chat.failure && seen.probed.chat.route?.provider === 'lca-chat',
      workFailedWithProviderWords: seen.probed.work?.ok === false && seen.probed.work.failure?.code === 'AUTH' && /Incorrect API key/.test(seen.probed.work.failure.message ?? ''),
      oneRequestEach: notes.models.toSorted().join() === 'mock-chat,mock-rejected',
      timed: [seen.probed.chat, seen.probed.work].every((result) => Number.isInteger(result?.durationMs)),
    }),
  },
  'state-truncated': {
    trusted: true, work: 'mock-work', state: { mode: 'quiet', token: 'length-token' }, turns: ['[[T1]] write a note'],
    script({ model, notes }) { notes.models.push(model); return { finish: 'length', text: '{"lca_state":{"mode":"work","token":"length-token"},"reply":"稍等。"}' } },
    check: (seen, notes) => ({ noSwitch: notes.models.join() === 'mock-chat' && seen.states.length === 0, warned: seen.stateNotices.length === 1, noRetry: notes.requests === 1 }),
  },
  'state-degraded': {
    trusted: true, answer: 'allowed-once', work: 'mock-work', state: { mode: 'quiet', token: 'degraded-token' }, turns: ['[[T1]] read the page and run a command'],
    script({ model, lastTool, notes }) {
      notes.models.push(model)
      if (!lastTool) return { tool: 'web_fetch', id: 'state-fetch', args: { url: 'http://127.0.0.1:9/notes' } }
      if (model === 'mock-chat') return { text: '{"lca_state":{"mode":"work","token":"degraded-token"},"reply":"我接着处理。"}' }
      return lastTool === 'state-fetch' ? pwsh('state-command', 'Write-Output 41') : { text: 'done' }
    },
    check: (seen, notes) => ({ oneSwitch: seen.states.length === 1, stayedDegraded: seen.approvals.length === 1 && seen.approvals[0].kind === 'degraded',
      workExecuted: resultOf(seen, 'state-command')?.isError === false && notes.models.at(-1) === 'mock-work', sameTurn: seen.turnEnds.join() === 'completed' }),
  },
  'state-foreground': {
    trusted: true, work: 'mock-work', policy: { role: 'foreground' }, state: { mode: 'work', token: 'foreground-token' }, turns: ['[[T1]] start a separate work'],
    script({ model, lastTool, messages, notes }) {
      notes.models.push(model)
      const system = messages.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n')
      notes.prompt = system.includes('lca_start_work') && system.includes('不要重复请求切到当前状态') && !system.includes('应先交给 work')
      return lastTool ? { text: 'Use a persistent work; the foreground cannot write this file.' } : write('foreground-native', 'must not be written')
    },
    check: (seen, notes, work) => ({ stayedChat: notes.models.join() === 'mock-chat,mock-chat', prompt: notes.prompt,
      nativeWriteRefused: resultOf(seen, 'foreground-native')?.isError === true && !existsSync(join(work, 'note.txt')),
      noSwitch: seen.states.length === 0 && seen.switched.length === 0, completed: seen.turnEnds.join() === 'completed' }),
  },
  'state-foreground-sign': {
    trusted: true, work: 'mock-work', policy: { role: 'foreground' }, state: { mode: 'quiet', token: 'foreground-sign-token' }, turns: ['[[T1]] change the sign to work'],
    script({ model, notes }) {
      notes.models.push(model)
      return { text: JSON.stringify({ lca_state: { mode: 'work', token: 'foreground-sign-token' }, reply: '门牌已调整。' }) }
    },
    check: (seen, notes) => ({ oneRequest: notes.requests === 1, stayedChat: notes.models.join() === 'mock-chat',
      stateApproved: seen.states.length === 1 && seen.stateNotices.length === 0, noWorkContinuation: seen.switched.length === 0,
      replyPublished: seen.messages.includes('门牌已调整。'), completed: seen.turnEnds.join() === 'completed' }),
  },
  'state-worker': {
    trusted: true, work: 'mock-work', policy: { role: 'worker', work: { workId: 'synthetic-worker', generation: 1, objectiveRevision: 1 } },
    state: { mode: 'quiet', token: 'worker-private-token' }, turns: ['[[T1]] write the assigned note'],
    script({ model, lastTool, messages, notes }) {
      notes.models.push(model)
      notes.noStateProtocol = !messages.some(message => textOf(message.content).includes('worker-private-token'))
      return lastTool ? { text: 'done' } : write('worker-note', 'independent work')
    },
    check: (seen, notes, work) => ({ workerModel: notes.models.join() === 'mock-work,mock-work', noStateProtocol: notes.noStateProtocol,
      wrote: existsSync(join(work, 'note.txt')) && readFileSync(join(work, 'note.txt'), 'utf8') === 'independent work', noSwitch: seen.states.length === 0,
      completed: seen.turnEnds.join() === 'completed' }),
  },
  'state-work': {
    trusted: true, work: 'mock-work', state: { mode: 'work', token: 'state-work-token' }, turns: ['[[T1]] write a note'],
    script({ model, lastTool, notes }) {
      notes.models.push(model)
      return lastTool ? { text: 'done' } : write('work-direct', 'direct work')
    },
    check: (seen, notes, work) => ({ direct: notes.models.length === 2 && notes.models.every((model) => model === 'mock-work'),
      wrote: readFileSync(join(work, 'note.txt'), 'utf8') === 'direct work', completed: seen.turnEnds.join() === 'completed', noHandoff: seen.handoffs.length === 0 }),
  },
  'state-text-handoff': {
    trusted: true, work: 'mock-work', state: { mode: 'quiet', token: 'state-text-token' }, turns: ['[[T1]] write a note'],
    script({ model, lastTool, messages, notes }) {
      notes.models.push(model)
      if (model === 'mock-chat') {
        notes.prompt = messages.some((message) => /(?:本次|本轮)状态凭据=state-text-token/.test(textOf(message.content)))
        return { text: JSON.stringify({ lca_state: { mode: 'work', token: 'state-text-token' }, reply: '我来处理。' }) }
      }
      notes.continuation = messages.some((message) => textOf(message.content).includes('LCA 已确认切换到工作中'))
      return lastTool ? { text: 'done' } : write('work-after-text', 'text handoff work')
    },
    check: (seen, notes, work) => ({ oneChatThenWork: notes.models.join() === 'mock-chat,mock-work,mock-work', sameTurn: seen.turnEnds.join() === 'completed',
      stateApproved: seen.states.length === 1, prompt: notes.prompt, continuation: notes.continuation,
      wrote: readFileSync(join(work, 'note.txt'), 'utf8') === 'text handoff work', noProtocolInBook: seen.messages.join().includes('我来处理。') && !seen.messages.join().includes('lca_state') }),
  },
  'state-stale': {
    trusted: true, work: 'mock-work', state: { mode: 'quiet', token: 'current-token' }, turns: ['[[T1]] write a note'],
    script({ model, notes }) { notes.models.push(model); return { text: '{"lca_state":{"mode":"work","token":"old-token"},"reply":"稍等。"}' } },
    check: (seen, notes) => ({ noSwitch: notes.models.join() === 'mock-chat' && seen.states.length === 0, completed: seen.turnEnds.join() === 'completed', warned: seen.stateNotices.length === 1 }),
  },
  'state-refused': {
    trusted: true, work: 'mock-work', state: { mode: 'quiet', token: 'refused-token' }, refuseState: true, turns: ['[[T1]] write a note'],
    script({ model, notes }) { notes.models.push(model); return { text: '{"lca_state":{"mode":"work","token":"refused-token"},"reply":"稍等。"}' } },
    check: (seen, notes) => ({ noSwitch: notes.models.join() === 'mock-chat', oneDecision: seen.states.length === 1, warned: seen.stateNotices.length === 1, completed: seen.turnEnds.join() === 'completed' }),
  },
  get 'reference-restart'() { return { ...this.reference, restart: true } },
  get 'degrade-restart'() { return { ...this.degrade, restart: true } },
  allowance: {
    trusted: true, answer: 'allowed-once', origin: 'event', refuse: 'autonomous', turns: ['[[T1]] {"source":"autonomous","facts":"she finished a chapter"}'],
    script() { return { text: 'should never be asked' } },
    check: (seen, notes) => ({
      askedAsAutonomous: seen.admits.length >= 1 && seen.admits.every((admit) => admit.bucket === 'autonomous'),
      stoppedBeforeModel: notes.requests === 0 && seen.turnEnds.length === 1 && seen.turnEnds[0] === 'blocked',
    }),
  },
  'event-cap': {
    trusted: true, answer: 'allowed-once', origin: 'event', turns: ['[[T1]] {"source":"pomodoro","facts":"{\\"kind\\":\\"focus-ended\\"}"}'],
    // A model that never stops looking around: only the cap ends the turn.
    script({ notes }) { notes.steps = (notes.steps ?? 0) + 1; return { tool: 'glob', id: `call_glob_${notes.steps}`, args: { pattern: `nothing-${notes.steps}-*.none` } } },
    check: (seen, notes) => ({
      cancelledByCap: seen.turnEnds.length === 1 && seen.turnEnds[0] === 'aborted',
      stoppedNearCap: notes.steps >= 6 && notes.steps <= 7,
    }),
  },
  reference: {
    trusted: true, answer: 'allowed-once', turns: ['[[T1]] what did we do yesterday', '[[T2]] and today?'],
    reference: JSON.stringify({ previousDaysReference: [{ text: 'LCA_REFERENCE_PROBE' }], currentTime: { iso: '2026-10-26T02:59:00.000Z', local: '2026/10/26 10:59', timeZone: 'Asia/Shanghai' } }),
    script({ turn, messages, notes }) {
      if (turn === 1) {
        // DSH may add its own reminders after your message; take the one carrying your words.
        const user = messages.findLast((message) => message.role === 'user' && textOf(message.content).includes('[[T1]]'))
        notes.userText = textOf(user?.content)
      } else notes.later = messages.map((message) => textOf(message.content)).join('\n')
      return { text: turn === 1 ? 'we wrote a prime counter' : 'more of it' }
    },
    check: (seen, notes) => ({
      turnsCompleted: seen.turnEnds.length === 2 && seen.turnEnds.every((kind) => kind === 'completed'),
      referenceBeforeWords: notes.userText.indexOf('LCA_REFERENCE_PROBE') >= 0 && notes.userText.indexOf('LCA_REFERENCE_PROBE') < notes.userText.indexOf('[[T1]]'),
      clockProvided: notes.userText.includes('2026/10/26 10:59') && notes.userText.includes('Asia/Shanghai'),
      oldClockRetired: !notes.later.includes('2026/10/26 10:59'),
      retiredNextTurn: !notes.later.includes('LCA_REFERENCE_PROBE') && notes.later.includes('[[T1]]') && notes.later.includes('LCA retired earlier source-derived content'),
    }),
  },
  levels: {
    trusted: true, turns: [], describe: true,
    routes: () => ({ LCA_CHAT_API_KEY: 'placeholder', DEEPSEEK_API_KEY: 'placeholder', LCA_DSH_ROUTES: JSON.stringify({
      providers: { google: { apiKeyEnv: 'LCA_CHAT_API_KEY', models: [{ id: 'gemini-3.8-flash' }] } },
      chat: { provider: 'google', model: 'gemini-3.8-flash', effort: 'low' }, work: { provider: 'deepseek-official', model: 'deepseek-v4-pro', effort: 'max' } }) }),
    check: (seen, notes) => ({
      chatLevelsFromCatalog: seen.described?.chat?.join() === 'low,medium,high',
      workLevelsFromAdapter: ['off', 'high', 'max'].every((level) => seen.described?.work?.includes(level)),
      noModelRequest: notes.requests === 0,
    }),
  },
  handoff: {
    trusted: true, answer: 'allowed-once', work: 'mock-work', turns: ['[[T1]] write a note', '[[T2]] just say hi'],
    script({ turn, lastTool, toolText, model, notes }) {
      notes.models.push(`${turn}:${model}`)
      if (turn === 1 && !lastTool) return write('call_write_chat', 'from chat')
      if (turn === 1 && lastTool === 'call_write_chat') { notes.feedback = toolText; return write('call_write_work', 'from work') }
      if (turn === 1) return { text: 'wrote it' }
      return { text: 'hi' }
    },
    check: (seen, notes, work) => ({
      turnsCompleted: seen.turnEnds.length === 2 && seen.turnEnds.every((kind) => kind === 'completed'),
      turn1StartedOnChat: notes.models[0] === '1:mock-chat',
      handedOffOnce: seen.handoffs.length === 1 && seen.handoffs[0] === 'call_write_chat' && seen.switched.join() === 'work',
      chatWriteNotRun: resultOf(seen, 'call_write_chat')?.isError === true && notes.feedback.includes('work model takes over'),
      workModelWrote: notes.models[1] === '1:mock-work' && resultOf(seen, 'call_write_work')?.isError === false && readFileSync(join(work, 'note.txt'), 'utf8') === 'from work',
      turn2BackOnChat: notes.models.filter((entry) => entry.startsWith('2:')).every((entry) => entry === '2:mock-chat') && notes.models.some((entry) => entry.startsWith('2:')),
    }),
  },
  degrade: {
    trusted: true, answer: 'allowed-once', turns: ['[[T1]] read the notes, then run a command', '[[T2]] run one more command'],
    script({ turn, lastTool, messages, notes }) {
      if (turn === 1 && !lastTool) return { tool: 'web_fetch', id: 'call_fetch_1', args: { url: 'http://127.0.0.1:9/notes' } }
      if (turn === 1 && lastTool === 'call_fetch_1') return pwsh('call_pwsh_1', 'Write-Output 41')
      if (turn === 2 && !lastTool) {
        const fetched = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_fetch_1')
        notes.retiredSeen = fetched ? textOf(fetched.content).includes('LCA retired') : null
        return pwsh('call_pwsh_2', 'Write-Output 42')
      }
      return { text: `done ${turn}` }
    },
    check: (seen, notes) => ({
      turnsCompleted: seen.turnEnds.length === 2 && seen.turnEnds.every((kind) => kind === 'completed'),
      degradedOnceInTurn1: seen.degraded.length === 1 && seen.degraded[0].turn === 1 && seen.degraded[0].sources.join() === 'web',
      turn1CommandAskedAsDegraded: seen.approvals.length === 1 && seen.approvals[0].turn === 1 && seen.approvals[0].kind === 'degraded' && seen.approvals[0].toolName === 'pwsh',
      retiredAtTurn2: seen.retired.length === 1 && seen.retired[0].turn === 2 && seen.retired[0].count >= 1,
      modelSawRetiredResult: notes.retiredSeen === true,
      commandsRan: ['call_pwsh_1', 'call_pwsh_2'].every((id) => resultOf(seen, id)?.isError === false),
    }),
  },
  trust: {
    trusted: false, answer: 'allowed-once', turns: ['[[T1]] run a command'],
    script({ lastTool, toolText, notes }) {
      if (!lastTool) return pwsh('call_pwsh_a', 'Write-Output 41')
      if (lastTool === 'call_pwsh_a') { notes.feedback = toolText; return pwsh('call_pwsh_b', 'Write-Output 41') }
      return { text: 'done' }
    },
    skip: (seen) => resultOf(seen, 'call_pwsh_a')?.isError === false && !seen.approvals.length,
    check: (seen, notes) => ({
      askedTrustOnce: seen.approvals.length === 1 && seen.approvals[0].kind === 'trust' && seen.approvals[0].toolName === 'pwsh',
      presetSwitched: seen.trusted.length === 1 && seen.trusted[0].preset === 'lca-trusted',
      sheReadTrustNotAclError: notes.feedback.includes('trusted this project') && !notes.rawSeen,
      rerunSucceeded: resultOf(seen, 'call_pwsh_a')?.isError === true && resultOf(seen, 'call_pwsh_b')?.isError === false,
    }),
  },
  decline: {
    trusted: false, answer: 'rejected', turns: ['[[T1]] run a command'],
    script({ lastTool, toolText, notes }) {
      if (!lastTool) return pwsh('call_pwsh_a', 'Write-Output 41')
      if (lastTool === 'call_pwsh_a') { notes.first = toolText; return pwsh('call_pwsh_b', 'Write-Output 41') }
      if (lastTool === 'call_pwsh_b') notes.second = toolText
      return { text: 'done' }
    },
    skip: (seen) => resultOf(seen, 'call_pwsh_a')?.isError === false && !seen.approvals.length,
    check: (seen, notes) => ({
      askedTrustOnce: seen.approvals.length === 1 && seen.approvals[0].kind === 'trust',
      notTrusted: seen.trusted.length === 0,
      sheReadDeclineBothTimes: [notes.first, notes.second].every((text) => text?.includes('chose not to')) && !notes.rawSeen,
    }),
  },
}

async function run(name) {
  const scenario = SCENARIOS[name]
  const work = join(dataDir, 'dsh-work', `bridge-check-${name}-${randomUUID().slice(0, 8)}`)
  mkdirSync(work, { recursive: true })
  const notes = { rawSeen: false, models: [] }
  let requests = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
      requests++
      const request = JSON.parse(body)
      const messages = request.messages ?? []
      if (messages.some((message) => message.role === 'tool' && /SetNamedSecurityInfoW|grantWrite\(/.test(textOf(message.content)))) notes.rawSeen = true
      const marker = messages.findLastIndex((message) => message.role === 'user' && /\[\[T\d\]\]/.test(textOf(message.content)))
      const turn = marker < 0 ? 0 : Number(textOf(messages[marker].content).match(/\[\[T(\d)\]\]/)[1])
      const last = messages.slice(marker + 1).filter((message) => message.role === 'tool').at(-1)
      const reply = scenario.script({ turn, lastTool: last?.tool_call_id ?? null, toolText: textOf(last?.content), messages, model: request.model, notes })
      if (reply.status) { res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body ?? {})); return }
      const base = { id: `mock-${requests}`, object: 'chat.completion.chunk', created: 0, model: 'mock' }
      const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (reply.tool) send([{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }])
      else send([{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }])
      send([{ index: 0, delta: {}, finish_reason: reply.tool ? 'tool_calls' : reply.finish ?? 'stop' }])
      send([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  // A separate fixture profile keeps pressure overrides from affecting another scenario.
  const { home, cli, profile } = prepareDshProfile({ dshRoot, dataDir: join(dataDir, name), bridge: join(repo, 'dsh', 'lca-bridge') })
  if (scenario.compaction) writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([{ id: 'compaction-basic', config: scenario.compaction }]))
  let stderr = ''
  const seen = { states: [], stateNotices: [], messages: [], approvals: [], degraded: [], retired: [], trusted: [], results: [], turnEnds: [], handoffs: [], switched: [], admits: [], probed: {} }
  let sessionId
  let restarting = false
  let child
  const launch = () => {
  child = spawn(process.execPath, [cli, '--profile', 'lca'], {
    cwd: work,
    env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', LCA_GUARDED_ROOTS: home, DEEPSEEK_API_KEY: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      // As src/main/dsh/routes.ts builds it for one OpenAI-compatible endpoint serving both models.
      ...(scenario.routes ? { ...scenario.routes(), HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' } : { LCA_CHAT_API_KEY: 'mock', LCA_DSH_ROUTES: JSON.stringify({
        providers: { 'lca-chat': { displayName: 'LCA', apiKeyEnv: 'LCA_CHAT_API_KEY', api: 'openai-completions', baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{ id: 'mock-chat', ...scenario.modelMetadata }, ...(scenario.work ? [{ id: scenario.work }] : [])] } },
        chat: { provider: 'lca-chat', model: 'mock-chat' }, work: { provider: 'lca-chat', model: scenario.work ?? 'mock-chat' } }) }) },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  child.on('message', (message) => {
    const turn = seen.turnEnds.length + 1
    switch (message.t) {
      case 'hello': child.send({ t: 'init', persona: 'You are a test agent.', suffix: '', tools: [] }); break
      case 'init-ok':
        if (scenario.probe) for (const role of scenario.probe) child.send({ t: 'probe', ref: `probe-${role}`, role })
        else if (scenario.describe) child.send({ t: 'describe', ref: 'levels' })
        else child.send({ t: 'open', ref: 'check', cwd: work, trusted: scenario.trusted, binding: { protocolVersion: 2, runtimeId: 'bridge-check', projectId: 'bridge-project', cwd: work }, ...(scenario.policy ? { policy: scenario.policy } : {}), ...(sessionId ? { sessionId } : {}) })
        break
      case 'described': seen.described = { chat: message.chat, work: message.work }; child.send({ t: 'shutdown' }); break
      case 'probed':
        seen.probed[String(message.ref).replace('probe-', '')] = { ok: message.ok, durationMs: message.durationMs, route: message.route, failure: message.failure }
        if (Object.keys(seen.probed).length === scenario.probe.length) child.send({ t: 'shutdown' })
        break
      case 'session': {
        const resumed = !!sessionId
        sessionId = message.sessionId
        seen.root = sessionId
        if (resumed) child.send({ t: 'send', sessionId, text: scenario.turns[seen.turnEnds.length], mode: 'followup' })
        else child.send({ t: 'send', sessionId, text: scenario.turns[0], mode: 'followup', ...(scenario.state ? { state: scenario.state } : {}), ...(scenario.policy?.work ? { workRevision: scenario.policy.work.objectiveRevision } : {}), ...(scenario.reference ? { reference: scenario.reference } : {}), ...(scenario.origin ? { origin: scenario.origin } : {}) })
        break
      }
      case 'approval':
        seen.approvals.push({ turn, kind: message.kind, toolName: message.toolName, degraded: message.degraded })
        child.send({ t: 'approval-answer', id: message.id, outcome: scenario.answer }); break
      case 'degraded': seen.degraded.push({ turn, sources: message.sources }); break
      case 'retired': seen.retired.push({ turn, count: message.count }); break
      case 'trusted': seen.trusted.push({ turn, preset: message.preset }); break
      case 'tool-result': seen.results.push({ callId: message.callId, isError: message.isError }); break
      case 'handoff': seen.handoffs.push(message.callId); break
      // LCA's resource ledger: allow everything unless the scenario refuses a bucket.
      case 'admit': seen.admits.push({ bucket: message.bucket, units: message.units }); child.send({ t: 'admit-answer', id: message.id, ok: message.bucket !== scenario.refuse }); break
      case 'model': seen.switched.push(message.role); break
      case 'message': seen.messages.push(message.text); break
      case 'compacted':
        seen.compacted = { outcome: message.outcome, rootSessionId: message.rootSessionId }
        notes.compacting = false
        child.send({ t: 'send', sessionId, text: scenario.turns[seen.turnEnds.length], mode: 'followup', reference: scenario.afterCompactReference })
        break
      case 'state-notice': seen.stateNotices.push(message.reason); break
      case 'state-request':
        seen.states.push(message.state)
        if (!scenario.refuseState) child.send({ t: 'state', sessionId, state: { mode: message.state.mode, token: 'new-state-token' } })
        child.send({ t: 'state-answer', id: message.id, ok: !scenario.refuseState }); break
      case 'turn-end':
        seen.turnEnds.push(message.reason?.kind ?? null)
        if (scenario.compactAfter === seen.turnEnds.length) {
          notes.compacting = true
          child.send({ t: 'compact', sessionId, ref: 'manual-compact', operationId: 'scripted-manual-compact' })
          break
        }
        // A restart scenario stops DSH after turn 1; the next process resumes the session for the rest.
        if (scenario.restart && seen.turnEnds.length === (scenario.restartAfter ?? 1) && scenario.turns.length > seen.turnEnds.length) { restarting = true; child.send({ t: 'shutdown' }) }
        else if (seen.turnEnds.length < scenario.turns.length) child.send({ t: 'send', sessionId, text: scenario.turns[seen.turnEnds.length], mode: 'followup' })
        else child.send({ t: 'shutdown' })
        break
      case 'error': seen.error = message.message; child.send({ t: 'shutdown' }); break
      default: break
    }
  })
  return new Promise((done) => child.on('exit', done))
  }
  const timer = setTimeout(() => { seen.timeout = true; child.kill() }, 120_000)
  let code = await launch()
  if (restarting) { seen.restarted = code; code = await launch() }
  clearTimeout(timer); server.close()
  if (scenario.skip?.(seen)) return { name, ok: true, skipped: 'the OS sandbox ran the command here', seen }
  notes.requests = requests
  const checks = scenario.check(seen, notes, work)
  const ok = Object.values(checks).every(Boolean) && !seen.timeout && !seen.error
  if (!ok && stderr) seen.stderr = stderr.split('\n').filter((line) => /error|warn/i.test(line)).slice(-20)
  return { name, ok, checks, ...(ok ? {} : { seen, notes }), ...(scenario.probe ? { probed: seen.probed } : {}), modelRequests: requests, exitCode: code }
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS)
const reports = []
for (const name of names) {
  if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}`)
  reports.push(await run(name))
}
console.log(JSON.stringify(reports, null, 2))
writeFileSync(join(dataDir, 'report.json'), JSON.stringify(reports, null, 2))
process.exitCode = reports.every((report) => report.ok) ? 0 : 1
