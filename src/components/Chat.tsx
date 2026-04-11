import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { TokenStatus } from '../lib/notion'

interface Props { tokenStatus: TokenStatus }

export default function Chat({ tokenStatus }: Props) {
  const { addTodo, todos, loading } = useAppStore()
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!message.trim()) return
    setSubmitting(true)
    try {
      await addTodo(message.trim(), 'Medium')
      setMessage('')
    } finally {
      setSubmitting(false)
    }
  }

  if (!tokenStatus.connected) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">💬</div>
        <div>Notion 未连接</div>
      </div>
    )
  }

  const recentTodos = todos.slice(0, 5)

  return (
    <div className="chat-panel">
      <div className="card" style={{ marginBottom: 10 }}>
        <div className="card-title">💬 快捷添加任务</div>
        <textarea
          className="input"
          style={{ width: '100%', minHeight: 60, resize: 'none', fontSize: 12 }}
          placeholder="输入任务，按回车添加..."
          value={message}
          onChange={e => setMessage(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !message.trim()}
          >
            {submitting ? '添加中...' : '+ 添加任务'}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-title">📋 最近任务</div>
        {loading ? (
          <div className="loading"><div className="spinner" /><span>加载中...</span></div>
        ) : recentTodos.length === 0 ? (
          <div className="empty-state" style={{ padding: 12 }}>暂无任务</div>
        ) : (
          recentTodos.map(t => (
            <div key={t.id} className="task-item">
              <div className="task-dot" style={{ background: t.status ? '#22c55e' : '#6366f1' }} />
              <span className={`task-name ${t.status ? 'task-done' : ''}`}>{t.name}</span>
            </div>
          ))
        )}
      </div>

      <div className="card" style={{ marginTop: 8 }}>
        <div style={{ fontSize: 10, color: '#8888a0', lineHeight: 1.5 }}>
          💡 完整对话请打开飞书或网页版 QClaw，AntDesk 专注任务管理。
        </div>
      </div>
    </div>
  )
}
