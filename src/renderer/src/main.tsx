import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { resolveBridge } from './app/resolve-bridge'
import { MiniApp } from './companion/MiniApp'
import { DiagnosticsWindow } from './tools/DiagnosticsWindow'
import './design/fonts.css'
import './design/tokens.css'
import './app/base.css'

const { bridge, fake } = resolveBridge()
// 迷你陪伴窗由主进程用 ?view=mini 载入；先标在根上，透明背景在第一帧就生效
const view = new URLSearchParams(location.search).get('view')
const mini = view === 'mini'
if (mini) document.documentElement.dataset.view = 'mini'
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{mini ? <MiniApp bridge={bridge} fake={fake} /> : view === 'diagnostics' ? <DiagnosticsWindow bridge={bridge} /> : <App bridge={bridge} fake={fake} />}</React.StrictMode>,
)
