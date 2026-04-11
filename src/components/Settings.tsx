import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getToken } from '../lib/notion'
import type { TokenStatus } from '../lib/notion'

interface Props {
  tokenStatus: TokenStatus
  onTokenChange: (s: TokenStatus) => void
}

export default function Settings({ tokenStatus, onTokenChange }: Props) {
  const [refreshing, setRefreshing] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleRefreshToken = async () => {
    setRefreshing(true)
    try {
      await invoke('clear_token_cache')
      const status = await getToken()
      onTokenChange(status)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setRefreshing(false)
    }
  }

  const token = tokenStatus.token || ''
  const maskedToken = token ? `${token.slice(0, 8)}...${token.slice(-4)}` : '(未获取)'

  return (
    <div className="settings">
      {/* 连接状态 */}
      <div className="card">
        <div className="card-title">🔗 Notion 连接</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#8888a0' }}>状态</span>
            <span className="connection-dot" style={{
              background: tokenStatus.connected ? '#22c55e' : '#ef4444'
            }} />
            <span style={{ fontSize: 12, color: tokenStatus.connected ? '#22c55e' : '#ef4444' }}>
              {tokenStatus.connected ? '已连接' : '未连接'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: '#8888a0' }}>Token</span>
            <code style={{ fontSize: 11, color: '#8888a0', wordBreak: 'break-all' }}>{maskedToken}</code>
          </div>
          {tokenStatus.error && (
            <div className="error-state" style={{ fontSize: 11 }}>{tokenStatus.error}</div>
          )}
        </div>
        <button
          className="btn-primary"
          style={{ marginTop: 10, width: '100%' }}
          onClick={handleRefreshToken}
          disabled={refreshing}
        >
          {refreshing ? '获取中...' : '🔄 刷新 Token'}
        </button>
        {saved && (
          <div style={{ textAlign: 'center', color: '#22c55e', fontSize: 11, marginTop: 6 }}>✅ 刷新成功</div>
        )}
      </div>

      {/* 使用说明 */}
      <div className="card">
        <div className="card-title">ℹ️ 使用说明</div>
        <div style={{ fontSize: 11, color: '#8888a0', lineHeight: 1.6 }}>
          <p>AntDesk 通过 QClaw 本地代理自动获取 Notion Token，无需手动配置。</p>
          <p style={{ marginTop: 6 }}>请确保 QClaw 已启动并完成 Notion 授权。</p>
        </div>
      </div>

      {/* 版本 */}
      <div style={{ textAlign: 'center', color: '#444', fontSize: 10, marginTop: 8 }}>
        AntDesk v0.1.0 · 2026-04-10
      </div>
    </div>
  )
}
