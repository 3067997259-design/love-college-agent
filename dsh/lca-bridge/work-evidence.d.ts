export function captureWorkFile(cwd: string, file: unknown): { relativePath: string; hash: string | null; bytes: number | null } | null
export function verifyWorkFile(cwd: string, evidence: { relativePath: string | null; afterHash: string | null; bytes: number | null }): boolean
export function commandObservation(name: string, result: unknown): { kind: 'command'; status: 'failed' | 'passed' | 'unverified'; exitCode: number | null } | null
