import { randomUUID } from 'node:crypto'
import { startDshHost, type DshHost, type DshHostOptions, type DshTool } from './host'

/** One DSH process/profile, many independently owned roots. A lease cannot see,
 * cancel, approve or journal another lease's events. Model loops remain in DSH. */
export function createRootHost(options: { dataDir: string; launch?: typeof startDshHost }) {
  type Lease = { callbacks: DshHostOptions; roots: Set<string>; tools: readonly DshTool[]; closed: boolean }
  const leases = new Set<Lease>(), owners = new Map<string, Lease>()
  let host: DshHost | undefined, closed = false, signature = ''
  let restarting: Promise<void> | undefined
  const owner = (root: string) => { const lease = owners.get(root); return lease && !lease.closed ? lease : undefined }
  const allTools = () => {
    const merged = new Map<string, DshTool>()
    for (const lease of leases) if (!lease.closed) for (const tool of lease.tools) {
      const old = merged.get(tool.name)
      if (old && JSON.stringify(old) !== JSON.stringify(tool)) throw new Error('DSH_TOOL_DEFINITION_CONFLICT')
      merged.set(tool.name, tool)
    }
    return [...merged.values()]
  }
  const sync = () => {
    const tools = allTools(), next = JSON.stringify(tools)
    if (host && signature !== next) { host.tools(tools); signature = next }
  }
  const launch: typeof startDshHost = callbacks => {
    if (closed) throw new Error('DSH_ROOT_HOST_CLOSED')
    if (restarting) throw new Error('DSH_ROOT_HOST_RESTARTING')
    const lease: Lease = { callbacks, roots: new Set(), tools: callbacks.tools, closed: false }
    leases.add(lease)
    if (!host) {
      const tools = allTools(); signature = JSON.stringify(tools)
      host = (options.launch ?? startDshHost)({ ...callbacks, dataDir: options.dataDir, tools,
        onEvent: event => {
          if (event.sessionId) owner(event.sessionId)?.callbacks.onEvent(event)
          else if (event.t === 'host-unavailable') for (const item of leases) if (!item.closed) item.callbacks.onEvent(event)
        },
        onCall: (name, args, root, callId) => {
          const lease = owner(root)
          if (!lease || !lease.tools.some(tool => tool.name === name)) return Promise.reject(new Error('DSH_ROOT_TOOL_UNAVAILABLE'))
          return lease.callbacks.onCall(name, args, root, callId)
        },
        onApproval: request => owner(request.sessionId)?.callbacks.onApproval(request) ?? Promise.resolve('rejected'),
        onAdmit: input => owner(input.sessionId)?.callbacks.onAdmit?.(input) ?? false,
        onState: input => owner(input.sessionId)?.callbacks.onState?.(input) ?? false,
        onQuestion: input => owner(input.sessionId)?.callbacks.onQuestion?.(input) ?? Promise.resolve({ error: 'This root is unavailable.' }),
      })
    } else sync()
    const running = host
    const owns = (id: string) => { if (lease.closed || owner(id) !== lease) throw new Error('DSH_ROOT_UNAVAILABLE') }
    let closing: Promise<null> | undefined
    return { ...running,
      open: async (cwd, sessionId, trusted, degraded, persona) => {
        if (lease.closed) throw new Error('DSH_ROOT_UNAVAILABLE')
        await running.started
        if (lease.closed) throw new Error('DSH_ROOT_UNAVAILABLE')
        // Tool changes made while the child was starting must follow init's snapshot.
        running.tools(allTools())
        const id = sessionId ?? `session-${randomUUID()}`
        if (owners.has(id) && owner(id) !== lease) throw new Error('DSH_ROOT_OWNER_CONFLICT')
        owners.set(id, lease); lease.roots.add(id)
        try { return await running.open(cwd, id, trusted, degraded, { persona: callbacks.persona, suffix: callbacks.suffix ?? '', ...persona, allowedTools: lease.tools.map(tool => tool.name) }) }
        catch (error) { owners.delete(id); lease.roots.delete(id); throw error }
      },
      available: () => !lease.closed && running.available(),
      send: (id, ...args) => { owns(id); return running.send(id, ...args) },
      recontinuePlan: (id, target) => { owns(id); return running.recontinuePlan(id, target) },
      state: (id, state) => { owns(id); return running.state(id, state) },
      workRevision: (id, revision) => { owns(id); return running.workRevision(id, revision) },
      deliverWork: (id, input) => { owns(id); return running.deliverWork(id, input) },
      release: async id => { owns(id); await running.release(id); owners.delete(id); lease.roots.delete(id) },
      cancel: id => { owns(id); return running.cancel(id) },
      trust: id => { owns(id); return running.trust(id) },
      untrust: id => { owns(id); return running.untrust(id) },
      compact: (id, operationId) => { owns(id); return running.compact(id, operationId) },
      collaboration: input => { owns(input.rootSessionId); return running.collaboration(input) },
      memberSteps: input => { owns(input.address.rootSessionId); return running.memberSteps(input) },
      tools: tools => { if (lease.closed) return false; lease.tools = tools; sync(); for (const id of lease.roots) running.tools(tools, id); return true },
      close: () => closing ??= (async () => {
        // Cancel is synchronous and precedes disposal or any ordinary pending send.
        for (const id of lease.roots) running.cancel(id)
        lease.closed = true
        for (const id of lease.roots) { await running.release(id); owners.delete(id) }
        leases.delete(lease); sync(); return null
      })(),
    }
  }
  // Releasing one lease deliberately leaves other roots running. Extension
  // maintenance must separately restart the physical host after all leases close.
  const restart = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('DSH_ROOT_HOST_CLOSED'))
    if (restarting) return restarting
    if (leases.size) return Promise.reject(new Error('DSH_ROOT_HOST_BUSY'))
    return restarting = (async () => { await host?.close(); host = undefined; signature = ''; owners.clear() })()
      .finally(() => { restarting = undefined })
  }
  return { launch, restart, busy: () => [...leases].some(lease => !lease.closed && lease.roots.size > 0),
    close: async () => { closed = true; for (const lease of leases) lease.closed = true; await host?.close(); owners.clear(); leases.clear() } }
}
