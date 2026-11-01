import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** One source identity for the runner and its evidence auditor, including untracked implementation. */
export function candidateFingerprint() {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n')
    .filter(path => /^(src\/|scripts\/|tests\/|dsh\/lca-bridge\/|dsh\/runtime\/(package.*\.json|THIRD_PARTY_NOTICES\.txt)$|vendor\/airi-memory\/|package\.json$|pnpm-lock\.yaml$|.*config\..*$|electron-builder\.yml$)/.test(path))
  const digest = createHash('sha256')
  for (const path of [...new Set(paths)].sort()) { digest.update(path); digest.update(existsSync(path) ? readFileSync(path) : 'deleted') }
  return digest.digest('hex')
}
