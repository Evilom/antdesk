import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Dashboard from './components/Dashboard'
import TaskList from './components/TaskList'
import Reports from './components/Reports'
import Chat from './components/Chat'
import Settings from './components/Settings'
import './App.css'

type Tab = 'dashboard' | 'tasks' | 'reports' | 'chat' | 'settings'

interface TokenStatus {
  connected: boolean
  token: string | null
  error: string | null
}

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: '概览', icon: '🏠' },
  { id: 'tasks', label: '任务', icon: '📋' },
  { id: 'reports', label: '日报', icon: '📝' },
  { id: 'chat', label: '对话', icon: '💬' },
  { id: 'settings', label: '⚙️', icon: '⚙️' },
]

async function initWindowDrag() {
  try {
    const win = getCurrentWindow()
    // 点击标题栏任意位置拖动窗口
    const titleBar = document.getElementById('title-bar')
    if (titleBar) {
      titleBar.addEventListener('mousedown', async () => {
        await win.startDragging()
      })
    }
  } catch (e) {
    // 非 Tauri 环境（开发模式），跳过
  }
}

async function fetchToken(): Promise<TokenStatus> {
  try {
    const token: string = await invoke('get_notion_token')
    return { connected: true, token, error: null }
  } catch (e) {
    return { connected: false, token: null, error: String(e) }
  }
}

export { fetchToken }
export type { TokenStatus }

function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ connected: false, token: null, error: null })
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    initWindowDrag()
    fetchToken().then(setTokenStatus)

    // 检查最大化状态
    const checkMax = async () => {
      try {
        const maximized: boolean = await invoke('is_maximized')
        setIsMaximized(maximized)
      } catch {}
    }
    checkMax()
    const interval = setInterval(checkMax, 2000)
    return () => clearInterval(interval)
  }, [])

  const handleMinimize = async () => { try { await invoke('window_minimize') } catch {} }
  const handleMaximize = async () => {
    try {
      await invoke('window_maximize')
      setIsMaximized(!isMaximized)
    } catch {}
  }
  const handleClose = async () => { try { await invoke('window_hide') } catch {} }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard tokenStatus={tokenStatus} onRefresh={() => fetchToken().then(setTokenStatus)} />
      case 'tasks': return <TaskList tokenStatus={tokenStatus} />
      case 'reports': return <Reports tokenStatus={tokenStatus} />
      case 'chat': return <Chat tokenStatus={tokenStatus} />
      case 'settings': return <Settings tokenStatus={tokenStatus} onTokenChange={(s) => setTokenStatus(s)} />
    }
  }

  const connectionColor = tokenStatus.connected ? '#22c55e' : tokenStatus.error ? '#ef4444' : '#f59e0b'

  return (
    <div className="app">
      {/* 拖拽标题栏 */}
      <div id="title-bar" className="title-bar">
        <div className="title-bar-left">
          <span className="app-icon">🐜</span>
          <span className="app-title">AntDesk</span>
          <span className="connection-dot" style={{ background: connectionColor }} />
        </div>
        <div className="title-bar-right">
          <button className="win-btn win-minimize" onClick={handleMinimize} title="最小化">─</button>
          <button className="win-btn win-maximize" onClick={handleMaximize} title={isMaximized ? '还原' : '最大化'}>
            {isMaximized ? '❐' : '□'}
          </button>
          <button className="win-btn win-close" onClick={handleClose} title="隐藏">✕</button>
        </div>
      </div>

      {/* 内容区 */}
      <div className="content-area">
        <nav className="tab-bar">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              title={tab.label}
            >
              <span>{tab.icon}</span>
              <span className="tab-label">{tab.label}</span>
            </button>
          ))}
        </nav>
        <main className="main-content">
          {renderContent()}
        </main>
      </div>
    </div>
  )
}

export default App
