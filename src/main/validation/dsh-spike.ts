import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Clock } from '../clock'
import { readModelProviders } from '../config/providers'
import { startDshHost, type DshEvent } from '../dsh/host'
import { dshLocations } from '../dsh/locations'
import { dshRoutes } from '../dsh/routes'

/**
 * DSH spike probe: her chat and work turns on the forked DSH runtime, driven from LCA's main process.
 * Synthetic prompts in a scratch workspace inside the probe data dir. The report carries numbers,
 * booleans, static tool names and error enums; credentials, URLs and model names stay in main. The
 * local transcript (synthetic session only) stays in the probe data dir. Bounded by MAX_STEPS and
 * MAX_INPUT_TOKENS, never retries, and only calls a model when the operator opted in with
 * LCA_REAL_MODEL=1; otherwise it only hosts the runtime and opens a session.
 */
const MAX_STEPS = 30
const MAX_INPUT_TOKENS = 600_000
const TURN_TIMEOUT_MS = 240_000
const PERSONA = '你是住在 LCA 这本书里的角色，正在陪用户过这一天。用简短自然的中文说话；需要动手时直接用工具做完，再用一两句话告诉用户结果。'
const TURNS = [
  { text: '帮我写个小脚本，算一下1到10000里有多少个质数，存成文件再运行一下给我看结果' },
  { text: '顺便问下，番茄钟还剩多久？' },
  { text: '把脚本改成同时统计 1 到 100000，再写个 README.md 说明怎么运行', steer: '对了，README 用中文写' },
]
const code = (error: unknown, fallback: string) => error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : fallback

/** Without real-model consent: host the runtime from Electron main, open one session, close. No model call. */
async function bootOnly(dataDir: string, appPath: string, clock: Clock) {
  const started = clock.nowMs()
  const events: string[] = []
  const workspace = join(dataDir, 'dsh-work', 'boot')
  const host = startDshHost({ clock, dshRoot: dshLocations().root, dataDir, bridge: dshLocations().bridge, workspace,
    routes: null, guardedRoots: [join(dataDir, 'dsh-home')], persona: PERSONA, tools: [], onEvent: (event) => { events.push(event.t) },
    onCall: async () => { throw new Error('UNUSED') }, onApproval: async () => 'rejected' })
  try {
    await host.started
    const hostStartMs = clock.nowMs() - started
    const sessionOpened = !!await host.open(workspace)
    const exitCode = await host.close()
    return { ok: sessionOpened && exitCode === 0, probe: 'dsh-spike', bootOnly: true, hostStartMs, sessionOpened, exitCode, eventKinds: [...new Set(events)] }
  } catch (error) {
    await host.close().catch(() => {})
    return { ok: false, probe: 'dsh-spike', bootOnly: true, errors: [code(error, 'DSH_BOOT_FAILED')], eventKinds: [...new Set(events)] }
  }
}

export async function probeDshSpike(dataDir: string, providersFile: string, appPath: string, clock: Clock) {
  const errors: string[] = []
  const report = { ok: false, probe: 'dsh-spike', route: 'none' as 'deepseek-official' | 'catalog' | 'openai-compatible' | 'none', hostStartMs: 0, turns: 0, steps: 0, toolCalls: {} as Record<string, number>,
    toolErrors: 0, approvals: 0, lcaCalls: 0, steerSent: false, steerUserMessages: 0, primesAnswered: false, timerAnswered: false,
    scriptFiles: 0, readmeCjk: false, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, budgetStopped: false, errors }
  if (process.env.LCA_REAL_MODEL !== '1') return await bootOnly(dataDir, appPath, clock)
  const chat = (await readModelProviders(providersFile)).get('chat')
  if (!chat) return { ...report, errors: ['CHAT_PROVIDER_MISSING'] }
  try { new URL(chat.base_url) } catch { return { ...report, errors: ['CHAT_PROVIDER_INVALID'] } }
  // The probe runs one model for chat and work, as a user who configured only one would.
  const routes = dshRoutes(chat, chat, {})
  report.route = routes.chat.provider === 'deepseek-official' ? 'deepseek-official' : routes.chat.provider.startsWith('lca-') ? 'openai-compatible' : 'catalog'

  const workspace = join(dataDir, 'dsh-work', 'newbie')
  const transcript: DshEvent[] = []
  const replies: string[][] = TURNS.map(() => [])
  const wait = (ms: number) => new Promise<'timeout'>((resolve) => { clock.after(ms, () => resolve('timeout')) })
  let current = -1
  let turnEnded: (() => void) | undefined
  let steerArmed: string | undefined
  const started = clock.nowMs()
  const host = startDshHost({
    clock, dshRoot: dshLocations().root, dataDir, bridge: dshLocations().bridge, workspace,
    routes, guardedRoots: [join(dataDir, 'dsh-home'), join(dataDir, 'journals'), join(dataDir, 'connections')], persona: PERSONA,
    tools: [{ name: 'lca_get_timer', description: 'Read the pomodoro timer of the LCA book: phase and minutes left.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
    onCall: async (name) => { report.lcaCalls++; if (name !== 'lca_get_timer') throw new Error('UNKNOWN_LCA_TOOL'); return { value: { phase: 'focus', remainingMinutes: 12, focusIndex: 2 }, source: null } },
    onApproval: async (request) => { report.approvals++; transcript.push({ t: 'approval-asked', toolName: request.toolName, reason: request.reason?.slice(0, 160) ?? null }); return 'rejected' },
    onEvent: (event) => {
      if (event.t !== 'delta') transcript.push(event)
      if (event.t === 'message') {
        report.steps++
        const usage = event.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null
        report.inputTokens += usage?.inputTokens ?? 0; report.outputTokens += usage?.outputTokens ?? 0; report.cacheReadTokens += usage?.cacheReadTokens ?? 0
        if (current >= 0 && typeof event.text === 'string' && event.text) replies[current].push(event.text)
        if (report.steps >= MAX_STEPS || report.inputTokens >= MAX_INPUT_TOKENS) { report.budgetStopped = true; host.cancel(String(event.sessionId)) }
      }
      if (event.t === 'tool-call') {
        report.toolCalls[String(event.name)] = (report.toolCalls[String(event.name)] ?? 0) + 1
        if (steerArmed) { host.send(String(event.sessionId), steerArmed, 'steer'); steerArmed = undefined; report.steerSent = true }
      }
      if (event.t === 'tool-result' && event.isError) report.toolErrors++
      if (event.t === 'user-message' && current === 2) report.steerUserMessages++
      if (event.t === 'agent-error') errors.push('AGENT_ERROR')
      if (event.t === 'turn-end') { report.turns++; turnEnded?.() }
    },
  })
  try {
    await host.started
    report.hostStartMs = clock.nowMs() - started
    const sessionId = await host.open(workspace)
    for (const [index, turn] of TURNS.entries()) {
      if (report.budgetStopped) break
      current = index
      steerArmed = turn.steer
      const ended = new Promise<'ended'>((resolve) => { turnEnded = () => resolve('ended') })
      host.send(sessionId, turn.text)
      if (await Promise.race([ended, wait(TURN_TIMEOUT_MS)]) === 'timeout') { errors.push('TURN_TIMEOUT'); host.cancel(sessionId); break }
      // A steer consumed mid-turn needs no extra turn; give a parked one a moment to surface.
      if (turn.steer) await wait(3_000)
    }
  } catch (error) {
    errors.push(code(error, 'DSH_SPIKE_FAILED'))
  } finally {
    await host.close().catch(() => errors.push('DSH_CLOSE_FAILED'))
  }
  const files = existsSync(workspace) ? readdirSync(workspace) : []
  report.scriptFiles = files.filter((file) => /\.(py|js|mjs|ps1|ts)$/i.test(file)).length
  const readme = files.find((file) => file.toLowerCase() === 'readme.md')
  report.readmeCjk = !!readme && /[\u4e00-\u9fff]/.test(readFileSync(join(workspace, readme), 'utf8'))
  report.primesAnswered = replies[0].join('\n').includes('1229')
  report.timerAnswered = replies[1].join('\n').includes('12')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'dsh-spike-transcript.json'), JSON.stringify({ replies, files, transcript }, null, 2))
  report.ok = errors.length === 0 && report.turns >= TURNS.length && report.primesAnswered && report.timerAnswered && report.lcaCalls > 0
  return report
}
