/** Live reports contain only fixed failure codes, never provider text or SQL. */
export function retrievalRuntimeFailure(databaseReady: boolean, embeddingError: string | undefined) {
  const embeddingFailure = !embeddingError ? null
    : embeddingError === 'Memory embedding exceeded 3000 ms; directory remains available'
      ? 'EMBEDDING_INTERACTION_DEADLINE_EXCEEDED'
      : 'EMBEDDING_RUNTIME_FAILED'
  const code = !databaseReady ? 'RETRIEVAL_DATABASE_UNAVAILABLE' : embeddingFailure
  return code ? { code, databaseReady, embeddingFailure } : null
}
