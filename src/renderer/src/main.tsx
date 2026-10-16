import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { resolveBridge } from './app/resolve-bridge'
import './design/fonts.css'
import './design/tokens.css'
import './app/base.css'

const { bridge, fake } = resolveBridge()
createRoot(document.getElementById('root')!).render(<React.StrictMode><App bridge={bridge} fake={fake} /></React.StrictMode>)
