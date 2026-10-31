// Test-only observer. It never changes policy, delivers messages or handles approvals.
export const name = 'lca-continuity-observer'
export const inject = ['agents', 'sessionPersistence']
export function apply(ctx) {
  const send = (value) => { if (process.connected) process.send({ t: 'p0-observed', ...value }) }
  const snapshot = (agent) => {
    const inputs = []
    for (let seq = 0; seq < agent.session.seq; seq++) {
      const event = agent.session.eventAt(seq)
      if (event?.type === 'user/message') inputs.push({ id: event.data.id, source: event.data.source, content: event.data.content })
    }
    return { sessionId: String(agent.id), inputs, nextTurn: [...agent.inbox.nextTurn], nextStep: [...agent.inbox.nextStep] }
  }
  ctx.on('agent/created', ({ agent, source }) => send({ event: 'created', source, ...snapshot(agent) }))
  ctx.on('session/event', (session, event) => {
    if (['user/message', 'agent/inbox/spliced', 'turn/end'].includes(event.type)) send({ event: event.type, sessionId: String(session.id), data: event.data })
  })
  const control = async (message) => {
    if (message?.t !== 'p0-flush') return
    try {
      await ctx.sessionPersistence.flush()
      const agent = ctx.agents.get(message.sessionId)
      send({ event: 'flushed', ref: message.ref, ...snapshot(agent) })
    } catch (error) { send({ event: 'failed', message: String(error) }) }
  }
  process.on('message', control)
  ctx.effect(() => () => process.off('message', control))
}
