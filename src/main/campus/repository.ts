import type { SessionStore } from '../store/session'
import type { JournalInput } from '../journal/schema'
import type { EvidenceVault } from '../mail/evidence-vault'
import { projectCampus } from './projection'

export class CampusStorageFailure extends Error { constructor() { super('CAMPUS_STORAGE_FAILED') } }
export function createCampusRepository(store: SessionStore, vault: EvidenceVault, failed?: () => void) {
  const history = () => store.history?.() ?? store.records()
  let state = projectCampus(history())
  vault.cache(state, history().length)
  return { view: () => structuredClone(state),
    append: (input: JournalInput) => {
      try { store.append(input); state = projectCampus(history()) }
      catch { failed?.(); throw new CampusStorageFailure() }
      try { vault.cache(state, history().length) } catch { /* Durable facts precede this disposable projection cache. */ }
    },
  }
}
export type CampusRepository = ReturnType<typeof createCampusRepository>
