/**
 * Memory write access (MEMORY-DESIGN §1.4 fix, WIRING-BACKLOG §6).
 *
 * The DuckDB-WASM OPFS backend holds one synchronous access handle per
 * file; a second window opening the same `airi-memory.duckdb` fails with
 * `createSyncAccessHandle` conflicts. The single-writer rule: only the
 * rendering window elected as the pinia-synced leader (the main process
 * passes `?synced-leader=true`) may open the memory database read-write;
 * follower windows must not initialize it and surface a hint instead.
 */
export type MemoryWriteAccess = 'leader' | 'follower'

/**
 * Resolves memory write access from the renderer's location search.
 * Mirrors `resolveRendererWindowContext` in apps/stage-tamagotchi: a
 * missing or false `synced-leader` means this window must not own the DB.
 *
 * @example
 * resolveMemoryWriteAccess('?synced-leader=true')  // => 'leader'
 * resolveMemoryWriteAccess('?synced-leader=false') // => 'follower'
 * resolveMemoryWriteAccess('')                     // => 'follower'
 */
export function resolveMemoryWriteAccess(search = globalThis.location?.search ?? ''): MemoryWriteAccess {
  return new URLSearchParams(search).get('synced-leader') === 'true' ? 'leader' : 'follower'
}
