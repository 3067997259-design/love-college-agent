export function dshCli(root: string): string
export function atomicJson(file: string, value: unknown): void
export function prepareDshProfile(options: { dshRoot: string; dataDir: string; bridge: string }): { home: string; profile: string; cli: string }
