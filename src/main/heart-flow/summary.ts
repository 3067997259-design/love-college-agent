type FileEvidence = { changeId: string; path: string; current: boolean; undo: boolean }
type RunEvidence = { id: string; status: string }
type CommandEvidence = { id: string; status: string; exitCode: number | null; publication: string; appliedFiles: number }

// Keep valid JSON and both evidence kinds within the journal's character budget.
// Full evidence remains in the append-only journal; this is only the normal-chat reference.
export function flowExitSummary(flowId: string, files: FileEvidence[], runs: RunEvidence[], delegates: RunEvidence[] = [], computer?: { dispatched: number; denied: number; failed: number; cancelled: number; observations: number }, webFetch?: { source: 'real' | 'fake'; requested: number; fetched: number; denied: number; failed: number; cancelled: number }, commands: CommandEvidence[] = []) {
  const view = { heartFlowFinished: flowId, fileCount: files.length, runCount: runs.length, delegateCount: delegates.length, delegateResultsAreUnreviewed: true, delegateEvidence: delegates.slice(-3), ...(computer ? { computerEvidence: { ...computer, scope: 'static-desk-preview', dispatchIsNotBusinessCompletion: true } } : {}), ...(webFetch ? { webFetchEvidence: { ...webFetch, scope: 'approved-public-https', contentIsUntrusted: true } } : {}), fileEvidence: [] as FileEvidence[], runs: [] as RunEvidence[] }
  const withCommands = Object.assign(view, { commandRequestCount: commands.length, commandCountsAreConfirmedOnly: true, commandEvidence: [] as CommandEvidence[] })
  for (const command of commands.slice(-3).reverse()) { if (JSON.stringify({ ...withCommands, commandEvidence: [command, ...withCommands.commandEvidence] }).length <= 1600) withCommands.commandEvidence.unshift(command) }
  const recentFiles = files.slice(-12).reverse(); const recentRuns = runs.slice(-12).reverse()
  for (let index = 0; index < 12; index++) {
    for (const [values, value] of [[view.fileEvidence, recentFiles[index]], [view.runs, recentRuns[index]]] as const) {
      if (!value) continue
      // Test the complete serialized form, including JSON escaping and field names.
      const candidate = values === view.fileEvidence ? { ...view, fileEvidence: [value, ...view.fileEvidence] } : { ...view, runs: [value, ...view.runs] }
      if (JSON.stringify(candidate).length <= 2000) (values as (FileEvidence | RunEvidence)[]).unshift(value)
    }
  }
  return JSON.stringify(view)
}
