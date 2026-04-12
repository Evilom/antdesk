import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './fab.css'

interface TokenStatus {
  connected: boolean
  token: string | null
  error: string | null
}

async function fetchToken(): Promise<TokenStatus> {
  try {
    const token: string = await invoke('get_notion_token')
    return { connected: true, token, error: null }
  } catch (e) {
    return { connected: false, token: null, error: String(e) }
  }
}

export default function FAB() {
  const [status, setStatus] = useState<TokenStatus>({ connected: false, token: null, error: null })

  useEffect(() => {
    fetchToken().then(setStatus)
  }, [])

  const handleClick = async () => {
    await invoke('fab_click')
  }

  const dotColor = status.connected ? '#22c55e' : status.error ? '#ef4444' : '#f59e0b'

  return (
    <div className="fab-root">
      <button className="fab" onClick={handleClick} title="AntDesk — 点击展开">
        <span className="fab-icon">🐜</span>
        <span className="fab-dot" style={{ background: dotColor }} />
      </button>
    </div>
  )
}
