import type { MemoryPgvectorConnection } from './repository'

import process from 'node:process'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel } from '@guiiai/logg'
import { Client } from '@proj-airi/server-sdk'
import { runUntilSignal } from '@proj-airi/server-sdk/utils/node'

import { connectMemoryRepository } from './repository'

setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)

interface MemoryModuleConfig {
  connectionString?: string
}

function readModuleConfig(config: unknown): MemoryModuleConfig {
  if (!config || typeof config !== 'object')
    return {}

  const record = config as Record<string, unknown>
  return {
    connectionString: typeof record.connectionString === 'string' ? record.connectionString : undefined,
  }
}

/**
 * Runs the Postgres memory module.
 *
 * Call stack:
 *
 * {@link main}
 *   -> {@link connectMemoryRepository}
 *     -> repository SQL operations used by the configured memory host
 */
async function main() {
  let connection: MemoryPgvectorConnection | undefined
  const client = new Client({
    name: 'memory-pgvector',
    possibleEvents: ['module:configure'],
    configSchema: {
      id: 'airi.memory-pgvector',
      version: 1,
      schema: {
        type: 'object',
        properties: {
          connectionString: { type: 'string' },
        },
      },
    },
  })

  async function closeConnection() {
    const current = connection
    connection = undefined
    await current?.close()
  }

  async function configure(config: unknown) {
    await closeConnection()
    const connectionString = readModuleConfig(config).connectionString
      ?? process.env.MEMORY_DATABASE_URL
      ?? process.env.DATABASE_URL
    if (!connectionString)
      return

    connection = connectMemoryRepository(connectionString)
  }

  client.onEvent('module:configure', async (event) => {
    await configure(event.data.config)
  })

  runUntilSignal()

  const shutdown = async () => {
    await closeConnection()
    client.close()
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await configure(undefined)
}

void main()

export { connectMemoryRepository, createMemoryRepository } from './repository'
export * from './schema'
