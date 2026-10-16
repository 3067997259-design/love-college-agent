type FileEvidence = { changeId: string; path: string; current: boolean; undo: boolean }
type RunEvidence = { id: string; status: string }

// Keep valid JSON and both evidence kinds within the journal's character budget.
// Full evidence remains in the append-only journal; this is only the normal-chat reference.
export function flowExitSummary(flowId: string, files: FileEvidence[], runs: RunEvidence[]) {
  const view = { heartFlowFinished: flowId, fileCount: files.length, runCount: runs.length, fileEvidence: [] as FileEvidence[], runs: [] as RunEvidence[] }
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
