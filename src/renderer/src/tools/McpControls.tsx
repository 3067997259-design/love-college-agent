import { useState } from 'react'
import type { AppBridge, AppCommand, AppSnapshot } from '../../../shared'

export function McpControls({ bridge, snapshot }: { bridge: AppBridge; snapshot: AppSnapshot }) {
  const [error, setError] = useState(''); const [approving, setApproving] = useState<string | null>(null)
  if (!snapshot.mcp) return null
  const send = async (body: Record<string, unknown>) => {
    try { const ack = await bridge.dispatch({ ...body, epoch: snapshot.epoch, requestId: crypto.randomUUID(), protocolVersion: 1 } as AppCommand); setError(ack.status === 'rejected' ? ack.error.code : '') }
    catch { setError('connection-failed') }
  }
  return <div aria-label="MCP 连接控制"><h2>MCP 工具</h2>
    <p>导入标准 mcpServers 配置文件；配置只由主进程读取。仅开放 allowTools 中列出的工具。</p>
    {snapshot.runtime?.developer.mode !== 'developer' && <button type="button" onClick={() => void send({ type: 'mcp.configure' })}>导入 MCP 配置</button>}
    {snapshot.mcp.servers.map((server) => <div className="mcp-server tools-plugin" key={server.id} data-id={server.id}>
      <strong>{server.id}</strong> · {server.transport} · {server.source === 'fake' ? '合成服务' : '外部服务'} · {server.status}
      <p>隐私过滤：{server.privacy === 'always' ? '总是隔离；依赖缺失时关闭' : '已声明为公开结果'}；允许：{server.tools.join('、') || '无，仅连接发现'}</p>
      {server.status === 'ready' || server.status === 'connecting' ? <button type="button" onClick={() => void send({ type: 'mcp.disconnect', serverId: server.id })}>断开</button>
        : <button type="button" onClick={() => setApproving(server.id)}>连接</button>}
      {approving === server.id && <div role="alertdialog" aria-label="MCP 连接确认">
        <p>连接 stdio 会启动配置指定的本地程序；HTTP 会访问配置指定的服务。允许的工具可在你的请求中执行，请先核对本机配置与来源。</p>
        <code>{server.fingerprint}</code><button type="button" onClick={() => { setApproving(null); void send({ type: 'mcp.connect', serverId: server.id, fingerprint: server.fingerprint }) }}>确认此配置并连接</button>
        <button type="button" onClick={() => setApproving(null)}>取消</button>
      </div>}
      {server.error && <p role="alert">连接未完成：{server.error.code}</p>}
    </div>)}
    {(error || snapshot.mcp.error) && <p role="alert">MCP 未完成：{error || snapshot.mcp.error?.code}</p>}
  </div>
}
