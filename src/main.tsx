import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import PenDebug from './components/PenDebug'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    {new URLSearchParams(location.search).has('pendebug') && <PenDebug />}
  </StrictMode>,
)
