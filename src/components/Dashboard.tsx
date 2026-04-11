import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import type { TokenStatus } from '../lib/notion'

interface Props {
  tokenStatus: TokenStatus
  onRefresh: () => void
}

export default function Dashboard({ tokenStatus, onRefresh }: Props) {
  const { todos, projects, loading, error, fetchAll } = useAppStore()

  useEffect(() => { fetchAll() }, [])

  if (error) {
    return (
      <div className="dashboard">
        <div className="error-state">
          <div>⚠️ 连接失败</div>
          <div style={{ fontSize: 11, marginTop: 4 }}>{error}</div>
          <button className="btn-secondary" style={{ marginTop: 8 }} onClick={onRefresh}>
            重试
          </button>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="dashboard">
        <div className="loading">
          <div className="spinner" />
          <span>加载中...</span>
        </div>
      </div>
    )
  }

  const highTodos = todos.filter(t => !t.status && t.priority === 'High')
  const doingTodos = todos.filter(t => !t.status)
  const doneTodos = todos.filter(t => t.status)
  const activeProjects = projects.filter(p => p.status !== '暂停')

  const connectionStatus = tokenStatus.connected
    ? { label: '已连接', color: '#22c55e' }
    : { label: '未连接', color: '#ef4444' }

  return (
    <div className="dashboard">
      {/* 连接状态 */}
      <div className="card" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className="connection-dot" style={{ background: connectionStatus.color }} />
          <span style={{ fontSize: 12 }}>AntDesk · Notion {connectionStatus.label}</span>
        </div>
        <button className="btn-secondary" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onRefresh}>🔄</button>
      </div>

      {/* 统计数字 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
        <div className="card stat-card">
          <div className="stat-num" style={{ color: '#ef4444' }}>{highTodos.length}</div>
          <div className="stat-lbl">紧急</div>
        </div>
        <div className="card stat-card">
          <div className="stat-num">{doingTodos.length}</div>
          <div className="stat-lbl">待办</div>
        </div>
        <div className="card stat-card">
          <div className="stat-num" style={{ color: '#22c55e' }}>{doneTodos.length}</div>
          <div className="stat-lbl">已完成</div>
        </div>
      </div>

      {/* 紧急待办 */}
      {highTodos.length > 0 && (
        <div className="card">
          <div className="card-title">🚨 紧急待办</div>
          {highTodos.slice(0, 5).map(t => (
            <div key={t.id} className="task-item">
              <div className="task-dot" style={{ background: '#ef4444' }} />
              <span className="task-name">{t.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* 进行中 */}
      <div className="card">
        <div className="card-title">📋 进行中 ({doingTodos.length})</div>
        {doingTodos.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">🎉</div>
            <div>全部完成！🎊</div>
          </div>
        ) : (
          doingTodos.slice(0, 6).map(t => (
            <div key={t.id} className="task-item">
              <div className="task-dot" style={{ background: t.priority === 'High' ? '#ef4444' : t.priority === 'Medium' ? '#f59e0b' : '#22c55e' }} />
              <span className="task-name">{t.name}</span>
            </div>
          ))
        )}
      </div>

      {/* 项目 */}
      {activeProjects.length > 0 && (
        <div className="card">
          <div className="card-title">🚀 活跃项目 ({activeProjects.length})</div>
          {activeProjects.slice(0, 4).map(p => (
            <div key={p.id} className="task-item">
              <div className="task-dot" style={{ background: '#6366f1' }} />
              <span className="task-name">{p.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
