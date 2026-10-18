import type { AppCommand, PublicErrorCode, RuntimeView } from '../../shared'
import type { Clock } from '../clock'
import { createAdjustableClock } from '../clock/adjustable'
import { openSettings } from '../config/settings'
import type { createPluginRegistry } from '../plugins/registry'
import type { createAppController, RuntimePort } from '../bridge/controller'
import type { createHarness } from '../harness/loop'
import type { SessionStore } from '../store/session'
import type { Scheduler } from '../scheduler'
import { createScriptedModel } from './model'
import { developmentProfile, presetScene, readScene, sceneSchema, stageScene } from './scenes'
import { startDevelopmentServer } from './server'

export function prepareRuntime(root: string, real: Clock, boothOverride = false) {
  const settings = openSettings(root)
  const booth = boothOverride || settings.read().booth
  const developer = !booth && settings.read().developer
  // Exhibition must never open the personal book merely because the operator reused LCA_DATA_DIR.
  const profile = developer ? developmentProfile(root, settings) : { id: undefined, path: booth ? join(root, 'booth') : root }
  const scene = developer ? readScene(profile.path) : undefined
  let savedClock = scene?.clock
  if (developer && existsSync(join(profile.path, 'clock.json'))) {
    try { savedClock = sceneSchema.shape.clock.parse(JSON.parse(readFileSync(join(profile.path, 'clock.json'), 'utf8'))) }
    catch { throw new Error('DEVELOPMENT_CLOCK_INVALID') }
  }
  const adjusted = developer ? createAdjustableClock(real, savedClock) : undefined
  const clock = adjusted?.clock ?? real
  const scripted = developer ? createScriptedModel(clock) : undefined
  if (scene && scripted) scripted.set(scene.modelScript)
  const pluginSettings = developer || booth ? openSettings(profile.path) : settings
  return { root, settings, booth, developer, profile, scene, adjusted, clock, scripted, pluginSettings }
}
export type PreparedRuntime = ReturnType<typeof prepareRuntime>

export async function attachRuntime(options: {
  prepared: PreparedRuntime; controller: ReturnType<typeof createAppController>; plugins: ReturnType<typeof createPluginRegistry>
  harness: ReturnType<typeof createHarness>; scheduler: Scheduler; store: SessionStore; mcpPort: number; cdpPort: number
  restart(): void
  locked?(): boolean
}) {
  const { prepared: p, controller, plugins, harness, scheduler, store } = options
  let server: Awaited<ReturnType<typeof startDevelopmentServer>> | undefined
  let error: RuntimeView['developer']['error']
  let mounted = false; let disposed = false; let service = Promise.resolve()
  const saveClock = () => { if (p.adjusted) writeFileSync(join(p.profile.path, 'clock.json'), JSON.stringify({ nowMs: p.clock.nowMs(), ...p.adjusted.view() }), { mode: 0o600 }) }
  const view = (): RuntimeView => ({ plugins: plugins.views(), developer: {
    mode: p.booth ? 'booth' : p.developer ? 'developer' : 'normal', requestedEnabled: !p.booth && p.settings.read().developer,
    restartRequired: !p.booth && (p.settings.read().developer !== p.developer || (p.developer && p.settings.read().sceneId !== p.profile.id)),
    ...(server ? { mcpPort: server.port } : {}), ...(p.developer ? { cdpPort: options.cdpPort, sceneId: p.profile.id } : {}), ...(error ? { error } : {}),
  } })
  const setClock = (input: { nowMs?: number; rate?: number; frozen?: boolean }) => {
    if (options.locked?.()) throw new Error('LOCAL_OPERATION_BUSY')
    if (!p.adjusted) throw new Error('DEVELOPER_REQUIRED')
    p.adjusted.set(input); scheduler.reconcile(); saveClock(); controller.refresh('timer')
    return controller.getSnapshot().clock
  }
  const port: RuntimePort = { view, clockView: p.adjusted?.view,
    dispatch: (command: AppCommand): PublicErrorCode | undefined => {
      if (command.type === 'plugin.install') {
        if (p.booth) return 'permission-denied'
        const error = plugins.install(command.path)
        if (!error) controller.refresh('connection')
        return error
      }
      if (command.type === 'plugin.enable') return plugins.enable(command.pluginId, command.fingerprint)
      if (command.type === 'plugin.disable') return plugins.disable(command.pluginId)
      if (command.type === 'plugin.privacy.set') return plugins.setPrivacy(command.pluginId, command.privacy)
      if (command.type === 'developer.set') {
        if (p.booth && command.enabled) return 'permission-denied'
        p.settings.update((draft) => { draft.developer = command.enabled }); return
      }
      if (command.type === 'app.restart') { options.restart(); return }
      if (!p.developer) return 'permission-denied'
      if (command.type === 'developer.clock') { setClock(command); return }
      if (command.type === 'developer.scenario') { stageScene(p.root, p.settings, presetScene(command.scenarioId, p.clock)); return }
      return 'unavailable'
    },
    stateChanged: () => scheduler.pauseBackground(store.projection().lightsOut),
  }
  controller.attachRuntime(port)
  const unmount = p.developer ? plugins.mountService('developer', (enabled) => {
    mounted = enabled
    service = service.then(async () => {
      if (server) { await server.close(); server = undefined }
      if (!enabled || disposed) { controller.refresh('connection'); return }
      try {
        server = await startDevelopmentServer(p.profile.path, options.mcpPort, {
          enabled: () => mounted && !disposed,
          state: controller.getSnapshot, context: () => store.projection().lastModelContext ?? store.projection().context, diagnostics: controller.readDiagnostics, queue: scheduler.queue,
          clock: setClock, inject: (input) => { if (options.locked?.()) throw new Error('LOCAL_OPERATION_BUSY'); harness.postEvent(input.source, input.text); return { accepted: true, source: 'fake' } },
          model: (script) => { p.scripted!.set(script); return { source: 'fake' } },
          exportScene: () => ({ formatVersion: 1, kind: 'development-fixture', clock: { nowMs: Math.round(p.clock.nowMs()), ...p.adjusted!.view() },
            mode: store.projection().mode, modelScript: p.scripted!.read(), preset: p.scene?.preset ?? 'empty' }),
          loadScene: (scene) => { if (options.locked?.()) throw new Error('LOCAL_OPERATION_BUSY'); const sceneId = stageScene(p.root, p.settings, scene); controller.refresh('restore'); return { sceneId, restartRequired: true } },
        })
      } catch { error = { code: 'connection-failed', retryable: false } }
      controller.refresh('connection')
    })
  }) : () => {}
  await service
  return { port, close: async () => { disposed = true; unmount(); await service; saveClock(); p.adjusted?.dispose() } }
}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
