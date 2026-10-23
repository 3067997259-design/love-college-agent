import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { assertSkillPath } from './skill-files.js'

const digest = (value) => createHash('sha256').update(value).digest('hex')
const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const labels = { 'project-dsh': '当前项目 · .dsh/skills', 'project-agents': '当前项目 · .agents/skills', profile: '此存档 · skills', extension: '扩展提供' }

/** Reuse the pinned DSH filesystem parser with a bounded, read-only filesystem port. */
async function scanRoot(root, source, signal) {
  const observations = new Map()
  let complete = true
  const check = (path) => { signal?.throwIfAborted(); assertSkillPath(path, root); return resolve(path) }
  const fs = {
    resolve: async (path) => ({ displayPath: check(path) }),
    processPath: (target) => target.displayPath,
    stat: async (target) => {
      const path = check(target.displayPath)
      try { const stat = lstatSync(path); return { type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other' } }
      catch (error) { if (error.code === 'ENOENT') return; throw error }
    },
    listDir: async (target) => {
      const entries = readdirSync(check(target.displayPath), { withFileTypes: true })
      if (entries.length > 512) throw new Error('SKILL_CATALOG_LIMIT')
      return entries.map((entry) => {
        const path = join(target.displayPath, entry.name), file = entry.isDirectory() ? join(path, 'SKILL.md') : path
        if (entry.isDirectory() || entry.isSymbolicLink() || entry.name.endsWith('.md')) observations.set(file, { path: file, name: entry.name, status: 'missing' })
        if (entry.isSymbolicLink()) { observations.get(file).status = 'invalid'; return { name: entry.name, type: 'other', target: { displayPath: path } } }
        return { name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', target: { displayPath: path } }
      })
    },
    readText: async (target) => {
      const path = check(target.displayPath)
      if (lstatSync(path).size > 1024 * 1024) throw new Error('SKILL_SIZE_LIMIT')
      const text = readFileSync(path, 'utf8')
      if (text.includes('\0')) throw new Error('SKILL_NOT_TEXT')
      const row = observations.get(path)
      if (row) { row.status = 'invalid'; row.fingerprint = digest(text) }
      return text
    },
  }
  const parser = new FileSystemSkillProvider({ get: (name) => name === 'fs' ? fs : undefined, logger: { warn() {} } },
    { signal: signal ?? new AbortController().signal, invalidate() {} }, { includeDefaultRoots: false, customSkillDirs: [root], providerName: 'lca-filesystem', watch: false })
  let candidates = []
  try { candidates = await parser.list({}); if (!Array.isArray(candidates)) candidates = candidates.candidates }
  catch { complete = false }
  finally { await parser.dispose() }
  for (const candidate of candidates) {
    candidate.source = source; candidate.rank = { 'project-dsh': 100, 'project-agents': 200, profile: 400 }[source]
    candidate.locator.root = root
    candidate.fingerprint = observations.get(candidate.path)?.fingerprint ?? ''
    observations.delete(candidate.path)
  }
  return { candidates, invalid: [...observations.values()].map((row) => ({ ...row, source })), complete, parser }
}

export function createSkillCatalog(ctx) {
  const profileRoot = join(process.env.DSH_HOME, 'skills')
  const roots = (cwd) => [...(cwd ? [[join(resolve(cwd), '.dsh', 'skills'), 'project-dsh'], [join(resolve(cwd), '.agents', 'skills'), 'project-agents']] : []), [profileRoot, 'profile']]
  const scan = async (cwd, signal) => {
    const result = { candidates: [], invalid: [], complete: true }
    for (const [root, source] of roots(cwd)) {
      const observed = await scanRoot(root, source, signal)
      result.candidates.push(...observed.candidates); result.invalid.push(...observed.invalid); result.complete &&= observed.complete
    }
    return result
  }
  // Do not cache mutable project files. Each model/catalog boundary rediscovers them; get revalidates the body.
  ctx.skills.registerProvider(() => ({ name: 'lca-filesystem',
    list: async ({ cwd, signal }) => ({ candidates: (await scan(cwd, signal)).candidates, complete: false }),
    get: async (candidate, { signal }) => {
      const observed = await scanRoot(candidate.locator.root, candidate.source, signal)
      const fresh = observed.candidates.find((entry) => entry.path === candidate.path && entry.name === candidate.name)
      return fresh ? observed.parser.get(fresh, { signal }) : undefined
    },
  }))
  const projectRow = (row) => ({
    id: digest(row.path ?? `${row.provider}:${row.name}`), name: row.name.slice(0, 160), description: (row.description ?? '').slice(0, 1000),
    source: labels[row.source] ? row.source : 'extension', sourceLabel: labels[row.source] ?? labels.extension,
    status: row.status ?? 'available', modelInvocable: row.invocation?.modelInvocable ?? false, userInvocable: row.invocation?.userInvocable ?? false,
    fingerprint: row.fingerprint ?? '', ...(row.path ? { path: row.path } : {}),
  })
  return {
    inspect: async (directory) => {
      // Main stages exactly one directory under a fresh parent before requesting validation.
      const observed = await scanRoot(dirname(directory), 'profile')
      const match = observed.candidates.find((item) => key(item.path) === key(join(directory, 'SKILL.md')))
      return { complete: observed.complete, items: match ? [projectRow(match)] : [] }
    },
    snapshot: async (cwd) => {
      const observed = await scan(cwd)
      const actual = await ctx.skills.list({ cwd })
      const items = observed.candidates.map((candidate) => {
        const winner = actual.find((entry) => entry.name === candidate.name)
        return projectRow({ ...candidate, status: winner?.path === candidate.path ? 'available' : 'shadowed' })
      })
      for (const row of actual) if (row.provider !== 'lca-filesystem') items.push(projectRow(row))
      items.push(...observed.invalid.map(projectRow))
      return { complete: observed.complete, items }
    },
  }
}
