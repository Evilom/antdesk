import { useState } from 'react'
import { useAppStore } from '../stores/appStore'
import type { TokenStatus } from '../lib/notion'

interface Props { tokenStatus: TokenStatus }

type Filter = 'all' | 'pending' | 'done'

export default function TaskList({ tokenStatus }: Props) {
  const { todos, loading, fetchAll, toggleTodo, addTodo } = useAppStore()
  const [filter, setFilter] = useState<Filter>('pending')
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPriority, setNewPriority] = useState('Medium')
  const [submitting, setSubmitting] = useState(false)

  const filtered = filter === 'all' ? todos
    : filter === 'pending' ? todos.filter(t => !t.status)
    : todos.filter(t => t.status)

  const handleAdd = async () => {
    if (!newName.trim()) return
    setSubmitting(true)
    try {
      await addTodo(newName.trim(), newPriority)
      setNewName('')
      setShowAdd(false)
    } finally {
      setSubmitting(false)
    }
  }

  const handleToggle = async (id: string, currentStatus: boolean) => {
    await toggleTodo(id, currentStatus)
  }

  const pending = todos.filter(t => !t.status).length

  return (
    <div className="tasklist">
      {/* 顶部栏 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['pending', 'done', 'all'] as Filter[]).map(f => (
            <button
              key={f}
              className={`btn-secondary ${filter === f ? '' : ''}`}
              style={{
                padding: '3px 10px',
                fontSize: 11,
                background: filter === f ? '#6366f1' : undefined,
                color: filter === f ? 'white' : undefined,
                border: filter === f ? 'none' : undefined,
              }}
              onClick={() => setFilter(f)}
            >
              {f === 'pending' ? `待办${pending > 0 ? ` (${pending})` : ''}` : f === 'done' ? '已完成' : '全部'}
            </button>
          ))}
        </div>
        <button className="btn-primary" style={{ padding: '3px 10px', fontSize: 11 }} onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? '取消' : '+ 新建'}
        </button>
      </div>

      {/* 新建任务 */}
      {showAdd && (
        <div className="card" style={{ marginBottom: 10 }}>
          <input
            className="input"
            style={{ width: '100%', marginBottom: 8 }}
            placeholder="任务名称..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {['High', 'Medium', 'Low'].map(p => (
              <button
                key={p}
                style={{
                  padding: '2px 10px',
                  fontSize: 11,
                  borderRadius: 10,
                  border: 'none',
                  cursor: 'pointer',
                  background: newPriority === p
                    ? p === 'High' ? '#ef4444' : p === 'Medium' ? '#f59e0b' : '#22c55e'
                    : '#1a1a26',
                  color: newPriority === p ? 'white' : '#8888a0',
                }}
                onClick={() => setNewPriority(p)}
              >
                {p === 'High' ? '🔴 高' : p === 'Medium' ? '🟡 中' : '🟢 低'}
              </button>
            ))}
            <button className="btn-primary" style={{ marginLeft: 'auto', padding: '3px 12px' }} onClick={handleAdd} disabled={submitting || !newName.trim()}>
              {submitting ? '添加中...' : '添加'}
            </button>
          </div>
        </div>
      )}

      {/* 加载 */}
      {loading && <div className="loading"><div className="spinner" /><span>加载任务...</span></div>}

      {/* 任务列表 */}
      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">📋</div>
          <div>{filter === 'pending' ? '暂无待办' : filter === 'done' ? '暂无已完成' : '暂无任务'}</div>
        </div>
      )}

      {filtered.map(todo => (
        <div key={todo.id} className="card task-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={todo.status}
              onChange={() => handleToggle(todo.id, todo.status)}
              className="task-checkbox"
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={`task-name ${todo.status ? 'task-done' : ''}`}>{todo.name}</div>
              <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
                <span className={`tag tag-${todo.priority.toLowerCase()}`}>
                  {todo.priority === 'High' ? '🔴高' : todo.priority === 'Medium' ? '🟡中' : '🟢低'}
                </span>
                {todo.tags.map(tag => (
                  <span key={tag} className="tag tag-project">{tag}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
