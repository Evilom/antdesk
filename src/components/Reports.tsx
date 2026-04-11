import { useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import type { TokenStatus } from '../lib/notion'

interface Props { tokenStatus: TokenStatus }

export default function Reports({ tokenStatus }: Props) {
  const { reports, loading, fetchAll } = useAppStore()
  useEffect(() => { if (tokenStatus.connected) fetchAll() }, [tokenStatus.connected])

  if (!tokenStatus.connected) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📝</div>
        <div>Notion 未连接，无法查看日报</div>
      </div>
    )
  }

  if (loading) return <div className="loading"><div className="spinner" /><span>加载中...</span></div>

  return (
    <div className="reports">
      <div className="card">
        <div className="card-title">📅 最近日报 ({reports.length})</div>
      </div>
      {reports.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📝</div>
          <div>暂无日报记录</div>
        </div>
      ) : (
        reports.map(r => (
          <div key={r.id} className="card" style={{ cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="task-name" style={{ fontSize: 12 }}>{r.date}</span>
            </div>
            {r.summary && (
              <div style={{ fontSize: 11, color: '#8888a0', marginTop: 4, lineHeight: 1.5 }}>
                {r.summary.length > 120 ? r.summary.slice(0, 120) + '...' : r.summary}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
