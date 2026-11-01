import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface MemoryCell<T> { value: T; reset(): void }
export interface MemoryRuntimeState {
  cell<T>(key: string, fallback: T): MemoryCell<T>
  subscribe(listener: (key: string) => void): () => void
  reload(): void
}

/** Main-owned runtime settings/outbox. The original outbox stores absolute patches.
 * This file is flushed before an assignment is visible. Credentials never belong here.
 * Cross-database operation publication is handled by the memory operation coordinator. */
export function createMemoryRuntimeState(path: string): MemoryRuntimeState {
  let data: Record<string, unknown> = {}
  const listeners = new Set<(key: string) => void>()
  const read = () => {
    if (!existsSync(path)) return {}
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MEMORY_STATE_INVALID')
    return value as Record<string, unknown>
  }
  data = read()
  const write = (key: string, value: unknown) => {
    if (/api-key|connection-string|base-url/.test(key)) throw new Error('MEMORY_STATE_CREDENTIAL_FORBIDDEN')
    const next = { ...data, [key]: value }
    mkdirSync(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    data = next
    for (const listener of listeners) listener(key)
  }
  return {
    cell: <T>(key: string, fallback: T): MemoryCell<T> => {
      const initial = structuredClone(fallback)
      return {
        get value() { return (Object.hasOwn(data, key) ? data[key] : initial) as T },
        set value(value: T) { write(key, value) },
        reset() { write(key, structuredClone(fallback)) },
      }
    },
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    reload: () => { data = read(); for (const listener of listeners) listener('*') },
  }
}

/** Ephemeral health state stays local to the owning main runtime. */
export function memoryCell<T>(): MemoryCell<T | undefined>
export function memoryCell<T>(value: T): MemoryCell<T>
export function memoryCell<T>(value?: T): MemoryCell<T | undefined> {
  return { value, reset() { this.value = value } }
}
export const memoryComputed = <T>(read: () => T) => ({ get value() { return read() } })
