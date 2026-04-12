import { useState, useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Dashboard from './components/Dashboard'
import TaskList from './components/TaskList'
import Reports from './components/Reports'
import Chat from './components/Chat'
import Settings from './components/Settings'
import './App.css'

type Tab = 'dashboard' | 'tasks' | 'reports' | 'chat' | 'settings'

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: 'dashboard', label: '概览', icon: '🏠' },
  { id: 'tasks', label: '任务', icon: '📋' },
  { id: 'reports', label: '日报', icon: '📝' },
  { id: 'chat', label: '对话', icon: '💬' },
  { id: 'settings', label: '设置', icon: '⚙️' },
]

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

export { fetchToken }
export type { TokenStatus }

// ===== FAB Mode: Small floating launcher =====
// When isExpanded=false, only the FAB button is shown
function FAB({ onClick, tokenStatus }: { onClick: () => void; tokenStatus: TokenStatus }) {
  const dot = tokenStatus.connected ? '#22c55e' : tokenStatus.error ? '#ef4444' : '#f59e0b'
  return (
    <button className="fab" onClick={onClick} title="AntDesk - 点击展开">
      <span className="fab-icon">🐜</span>
      <span className="fab-dot" style={{ background: dot }} />
    </button>
  )
}

// ===== Full Panel Mode =====
// Window chrome: title bar + tabs + content
function Panel({ tokenStatus, onTokenChange, onCollapse }: {
  tokenStatus: TokenStatus
  onTokenChange: (s: TokenStatus) => void
  onCollapse: () => void
}) {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
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

  const handleMinimize = async () => { await invoke('window_minimize') }
  const handleMaximize = async () => {
    try {
      await invoke('window_maximize')
      setIsMaximized(!isMaximized)
    } catch {}
  }
  const handleClose = async () => { await invoke('collapse_panel'); onCollapse() }

  const connectionColor = tokenStatus.connected ? '#22c55e' : tokenStatus.error ? '#ef4444' : '#f59e0b'

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard': return <Dashboard tokenStatus={tokenStatus} onRefresh={() => fetchToken().then(onTokenChange)} />
      case 'tasks':     return <TaskList tokenStatus={tokenStatus} />
      case 'reports':   return <Reports tokenStatus={tokenStatus} />
      case 'chat':      return <Chat tokenStatus={tokenStatus} />
      case 'settings':  return <Settings tokenStatus={tokenStatus} onTokenChange={onTokenChange} />
    }
  }

  return (
    <div className="app">
      {/* Title Bar */}
      <div
        id="title-bar"
        className="title-bar"
        onMouseDown={async (e) => {
          if ((e.target as HTMLElement).closest('.title-bar-right')) return
          try { const win = getCurrentWindow(); await win.startDragging() } catch {}
        }}
      >
        <div className="title-bar-left">
          <span className="app-icon">🐜</span>
          <span className="app-title">AntDesk</span>
          <span className="connection-dot" style={{ background: connectionColor }} />
        </div>
        <div className="title-bar-right">
          <button className="win-btn win-minimize"   onClick={handleMinimize}  title="最小化">─</button>
          <button className="win-btn win-maximize"    onClick={handleMaximize} title={isMaximized ? '还原' : '最大化'}>{isMaximized ? '❐' : '□'}</button>
          <button className="win-btn win-close"      onClick={handleClose}     title="收起">✕</button>
        </div>
      </div>

      {/* Tab Bar */}
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

      {/* Content */}
      <main className="main-content">
        {renderContent()}
      </main>
    </div>
  )
}

// ===== Root App =====
export default function App() {
  const [isExpanded, setIsExpanded] = useState(false)
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ connected: false, token: null, error: null })
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchToken().then(setTokenStatus)
  }, [])

  // 点击 FAB，展开面板
  const handleExpand = async () => {
    await invoke('expand_panel')
    setIsExpanded(true)
  }

  // 点击关闭，收起面板
  const handleCollapse = async () => {
    setIsExpanded(false)
    // 不再调用 hide，让窗口保持隐藏状态（由 tauri.conf.json visible:false 控制）
  }

  if (!isExpanded) {
    return <FAB onClick={handleExpand} tokenStatus={tokenStatus} />
  }

  return (
    <div ref={panelRef}>
      <Panel
        tokenStatus={tokenStatus}
        onTokenChange={setTokenStatus}
        onCollapse={handleCollapse}
      />
    </div>
  )
}
