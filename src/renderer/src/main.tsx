import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { resolveBridge } from './app/resolve-bridge'
import './design/fonts.css'
import './design/tokens.css'
import './app/base.css'

const { bridge, fake } = resolveBridge()
const root = createRoot(document.getElementById('root')!)
if (fake && new URLSearchParams(location.search).get('view') === 'specimen') {
  void import('./dev/Specimen').then(({ Specimen }) => root.render(<Specimen />))
} else {
  root.render(<React.StrictMode><App bridge={bridge} fake={fake} /></React.StrictMode>)
}
