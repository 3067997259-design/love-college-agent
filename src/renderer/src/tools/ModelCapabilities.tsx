import { useEffect, useState } from 'react'
import type { AppBridge, ManualModelCapabilities, ModelProviderSlot, ModelSlotDetail, ReasoningEffort } from '../../../shared'
import { sendCommand } from '../book/command'
import { SettingsIssue } from './SettingsIssue'
import copy from '../voice/providers.zh.json'

const LEVELS: ReasoningEffort[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
type Row = { level: ReasoningEffort; value: string }
const rowsOf = (value?: ManualModelCapabilities) => value?.reasoning && Object.entries(value.reasoning).map(([level, value]) => ({ level: level as ReasoningEffort, value: value ?? '' })) || []

export function ModelCapabilities({ bridge, epoch, slot, detail, status }: { bridge: AppBridge; epoch: string; slot: ModelProviderSlot; detail: ModelSlotDetail; status: string }) {
  const view = detail.capabilities!, declared = view.declared, resolved = view.resolved
  const [context, setContext] = useState(String(declared?.contextWindow ?? ''))
  const [output, setOutput] = useState(String(declared?.maxOutputTokens ?? ''))
  const [input, setInput] = useState(declared?.inputModalities ? declared.inputModalities.includes('image') ? 'images' : 'text' : 'auto')
  const [reasoning, setReasoning] = useState(declared?.reasoning === false ? 'disabled' : declared?.reasoning ? 'levels' : 'auto')
  const [rows, setRows] = useState<Row[]>(rowsOf(declared))
  const [error, setError] = useState(''), [remote, setRemote] = useState(''), [pending, setPending] = useState(false)
  const declaredKey = JSON.stringify(declared)
  useEffect(() => {
    const value = declaredKey ? JSON.parse(declaredKey) as ManualModelCapabilities : undefined
    setContext(String(value?.contextWindow ?? '')); setOutput(String(value?.maxOutputTokens ?? ''))
    setInput(value?.inputModalities ? value.inputModalities.includes('image') ? 'images' : 'text' : 'auto')
    setReasoning(value?.reasoning === false ? 'disabled' : value?.reasoning ? 'levels' : 'auto'); setRows(rowsOf(value))
  }, [declaredKey])
  useEffect(() => { if (status === 'saved' || status === 'failed') setPending(false) }, [status])
  const source = (manual: boolean, known: boolean) => manual ? '手动声明' : known ? 'DSH 目录或默认值' : '未识别'
  const save = async (reset = false) => {
    setError(''); setRemote('')
    if (reset) {
      const result = await sendCommand(bridge, epoch, { type: 'models.capabilities.save', slot, modelRef: detail.modelRef!, capabilities: null })
      if (!result.ok) setRemote(result.code); else setPending(true)
      return
    }
    const value: ManualModelCapabilities = {}
    for (const [key, text] of [['contextWindow', context], ['maxOutputTokens', output]] as const) if (text.trim()) {
      if (!/^\d+$/.test(text.trim()) || Number(text) < 1 || Number(text) > 100_000_000) { setError('token 数请填写 1 到 100000000 之间的整数。'); return }
      value[key] = Number(text)
    }
    if (value.contextWindow && value.maxOutputTokens && value.maxOutputTokens > value.contextWindow) { setError('最大输出不能超过上下文窗口。'); return }
    if (input !== 'auto') value.inputModalities = input === 'images' ? ['text', 'image'] : ['text']
    if (reasoning === 'disabled') value.reasoning = false
    if (reasoning === 'levels') {
      if (!rows.some((r) => r.level !== 'off') || new Set(rows.map((r) => r.level)).size !== rows.length || rows.some((r) => !r.value && r.level !== 'off' || r.value && !/^[A-Za-z0-9_.-]{1,64}$/.test(r.value))) { setError('请添加至少一个思考档位，每档填写有效且不重复的 API 参数值；“关闭”可留空表示不发送参数。'); return }
      value.reasoning = Object.fromEntries(rows.map((r) => [r.level, r.value || null]))
    }
    if (!reset && !Object.keys(value).length) { setError('请至少声明一项能力，或选择恢复自动设置。'); return }
    const result = await sendCommand(bridge, epoch, { type: 'models.capabilities.save', slot, modelRef: detail.modelRef!, capabilities: reset ? null : value })
    if (!result.ok) setRemote(result.code); else setPending(true)
  }
  const renderValue = (label: string, value: string | number | undefined, manual: boolean, known: boolean) => <div><dt>{label}</dt><dd>{value ?? '未知'}<small>{source(manual, known)}</small></dd></div>
  return <details className="model-capabilities">
    <summary>模型能力 · {declared ? '含手动声明' : 'DSH 目录或默认值'}</summary>
    <dl className="capability-facts">
      {renderValue('上下文窗口', declared?.contextWindow ?? resolved?.contextWindow, declared?.contextWindow !== undefined, resolved?.contextWindow !== undefined)}
      {renderValue('最大输出 token', declared?.maxOutputTokens ?? resolved?.maxOutputTokens, declared?.maxOutputTokens !== undefined, resolved?.maxOutputTokens !== undefined)}
      {renderValue('输入类型', (declared?.inputModalities ?? resolved?.inputModalities)?.map((v) => v === 'text' ? '文本' : '图片').join('、'), declared?.inputModalities !== undefined, resolved?.inputModalities !== undefined)}
      {renderValue('思考档位', declared?.reasoning === false ? '不提供' : declared?.reasoning ? Object.keys(declared.reasoning).map((v) => copy.efforts[v as ReasoningEffort]).join('、') : resolved?.reasoningLevels?.length ? resolved.reasoningLevels.map((v) => copy.efforts[v]).join('、') : '由服务商默认', declared?.reasoning !== undefined, resolved?.reasoningLevels !== undefined)}
    </dl>
    <p className="provider-hint">手动声明只适用于当前连接和模型，相同连接与模型的槽位共用声明。保存不会测试供应商；空白项继续使用 DSH 目录或默认值。最大输出会用于请求上限。</p>
    {!view.editable ? <p className="provider-hint">这个 DeepSeek 官方连接使用原生适配器，能力由 DSH 提供。</p> : <div className="capability-form">
      <label className="provider-field">上下文窗口（token）<input aria-label="上下文窗口（token）" inputMode="numeric" value={context} placeholder="不覆盖" onChange={(e) => setContext(e.target.value)} /></label>
      <label className="provider-field">最大输出 token 数<input aria-label="最大输出 token 数" inputMode="numeric" value={output} placeholder="不覆盖" onChange={(e) => setOutput(e.target.value)} /></label>
      <label className="provider-field">输入类型<select aria-label="输入类型" value={input} onChange={(e) => setInput(e.target.value)}><option value="auto">不覆盖</option><option value="text">文本</option><option value="images">文本、图片</option></select></label>
      <label className="provider-field">思考能力<select aria-label="思考能力" value={reasoning} onChange={(e) => { setReasoning(e.target.value); if (e.target.value === 'levels' && !rows.length) setRows([{ level: 'medium', value: '' }]) }}><option value="auto">不覆盖</option><option value="disabled">不提供思考档位</option><option value="levels">手动声明档位与 API 值</option></select></label>
      {reasoning === 'levels' && <div className="capability-levels">
        <p className="provider-hint">左侧是界面档位，右侧是服务商接受的参数值。关闭档位留空表示不发送思考参数。</p>
        {rows.map((row, index) => <div className="capability-level" key={index}>
          <select aria-label={`思考档位 ${index + 1}`} value={row.level} onChange={(e) => setRows(rows.map((r, i) => i === index ? { ...r, level: e.target.value as ReasoningEffort } : r))}>{LEVELS.map((level) => <option key={level} value={level} disabled={rows.some((r, i) => i !== index && r.level === level)}>{copy.efforts[level]}</option>)}</select>
          <input aria-label={`API 参数值 ${index + 1}`} maxLength={64} value={row.value} placeholder={row.level === 'off' ? '不发送参数' : '服务商要求的值'} autoComplete="off" spellCheck={false} onChange={(e) => setRows(rows.map((r, i) => i === index ? { ...r, value: e.target.value } : r))} />
          <button type="button" className="link-button" aria-label={`删除档位 ${index + 1}`} onClick={() => setRows(rows.filter((_, i) => i !== index))}>删除</button>
        </div>)}
        <button type="button" className="link-button" disabled={rows.length >= LEVELS.length} onClick={() => { const level = LEVELS.find((level) => !rows.some((r) => r.level === level)); if (level) setRows([...rows, { level, value: '' }]) }}>添加档位</button>
      </div>}
      <div className="provider-actions"><button type="button" className="btn btn-ghost btn-small" disabled={pending} onClick={() => void save()}>{pending ? '正在保存…' : '保存能力声明'}</button><button type="button" className="link-button" disabled={pending || !declared} onClick={() => void save(true)}>恢复自动设置</button></div>
      {error && <p className="provider-note" role="alert">{error}</p>}{remote && <SettingsIssue code={remote} />}
    </div>}
  </details>
}
