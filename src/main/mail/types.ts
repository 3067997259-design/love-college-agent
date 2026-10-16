/** Main-only source payload. Never serialize this into a journal, tool result, snapshot, or MCP response. */
export interface SourceMail {
  uidValidity: string
  uid: number
  senderAddress: string
  senderName: string
  subject: string
  body: string
  sentAtMs: number
  receivedAtMs: number
}
export interface MailSource {
  readonly source: 'real' | 'fake'
  readonly blocked: boolean
  /** Read-only adapter; neither this interface nor its fixtures expose a mark-as-read operation. */
  readUnseen(signal: AbortSignal): Promise<{ unseenCount: number; messages: readonly SourceMail[] }>
}
