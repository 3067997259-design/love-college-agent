import type { LifeWorkModel } from './schema'
import fixtures from './fixtures.json'
export { fixtures as lifeWorkFixtures }
/** Deterministic fixtures, no network, credentials, arbitrary file traversal or model clock. */
export function createFakeLifeWorkModel(): LifeWorkModel {
  return { source: 'fake', produce: async (input, signal) => {
    signal.throwIfAborted()
    const next = fixtures[input.kind][input.step - 1]
    return { markdown: input.previous ? input.previous + '\n\n---\n\n' + next : next }
  } }
}
