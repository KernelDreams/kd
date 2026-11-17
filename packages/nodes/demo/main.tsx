import React from 'react'
import { createRoot } from 'react-dom/client'
import '../src/ui/styles/nodes.css'
import './demo.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
