'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import io from 'socket.io-client'

type Branch = { id: string; name: string }
type CustomerInfo = { name: string; address: string }
type TakerRow = {
  socketId: string
  userId: string
  branchId: string | null
  status: 'in_call' | 'available' | 'not_available'
  currentCustomer: CustomerInfo
  previousCustomer: CustomerInfo
  callStartedAt?: number
}
type MonitorPayload = {
  counts: { totalConnections: number; totalOrderTakers: number }
  takers: TakerRow[]
}

function useCallDuration(callStartedAt: number | undefined, active: boolean): string {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active || !callStartedAt) return
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [active, callStartedAt])
  if (!active || !callStartedAt) return ''
  const elapsed = Math.floor((Date.now() - callStartedAt) / 1000)
  const m = Math.floor(elapsed / 60)
  const s = elapsed % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function TakerCard({ taker, branchName }: { taker: TakerRow; branchName: (id: string | null) => string }) {
  const duration = useCallDuration(taker.callStartedAt, taker.status === 'in_call')
  const statusClass = { in_call: 'in-call', available: 'available', not_available: 'offline' }[taker.status]
  const badgeLabel = { in_call: 'In Call', available: 'Available', not_available: 'Offline' }[taker.status]

  return (
    <article className={`taker-card ${statusClass}`}>
      <div className="taker-card-header">
        <div>
          <div className="taker-name">{taker.userId}</div>
          <div className="taker-branch">{branchName(taker.branchId)}</div>
        </div>
        <div className="taker-badges">
          <span className={`status-badge ${statusClass}`}>{badgeLabel}</span>
          {taker.status === 'in_call' && duration && (
            <span className="call-timer">⏱ {duration}</span>
          )}
        </div>
      </div>

      <div className="taker-divider" />

      <div className="taker-section">
        <div className="taker-section-label">Current Customer</div>
        {taker.currentCustomer.name ? (
          <>
            <div className="taker-customer-name">{taker.currentCustomer.name}</div>
            <div className="taker-customer-address">📍 {taker.currentCustomer.address || '—'}</div>
          </>
        ) : <div className="taker-empty">—</div>}
      </div>

      <div className="taker-divider" />

      <div className="taker-section">
        <div className="taker-section-label">Previous Customer</div>
        {taker.previousCustomer.name ? (
          <>
            <div className="taker-prev-name">{taker.previousCustomer.name}</div>
            <div className="taker-prev-address">📍 {taker.previousCustomer.address || '—'}</div>
          </>
        ) : <div className="taker-empty">—</div>}
      </div>
    </article>
  )
}

export default function ManagerPage() {
  const socketRef = useRef<any>(null)
  const [branches, setBranches] = useState<Branch[]>([])
  const [selectedBranch, setSelectedBranch] = useState('all')
  const [userId, setUserId] = useState('')
  const [password, setPassword] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [monitor, setMonitor] = useState<MonitorPayload>({ counts: { totalConnections: 0, totalOrderTakers: 0 }, takers: [] })

  useEffect(() => {
    const socket = io()
    socketRef.current = socket
    socket.on('branches', (list: Branch[]) => { setBranches(Array.isArray(list) ? list : []) })
    socket.on('monitor-update', (payload: MonitorPayload) => {
      setMonitor(payload || { counts: { totalConnections: 0, totalOrderTakers: 0 }, takers: [] })
      setLastUpdated(new Date())
    })
    return () => { socket.disconnect() }
  }, [])

  const doLogin = () => {
    setLoginError('')
    socketRef.current?.emit('login', { userId, password, role: 'manager' }, (res: any) => {
      if (!res?.ok) { setLoginError(res?.error || 'Login failed'); return }
      setLoggedIn(true)
      socketRef.current?.emit('manager-monitor-subscribe')
    })
  }

  const branchName = useCallback(
    (id: string | null) => branches.find(b => b.id === id)?.name || id || 'Unknown',
    [branches]
  )

  const filteredTakers = useMemo(() => {
    if (selectedBranch === 'all') return monitor.takers
    return monitor.takers.filter(t => t.branchId === selectedBranch)
  }, [monitor.takers, selectedBranch])

  const filteredCounts = useMemo(() => {
    if (selectedBranch === 'all') return monitor.counts
    return {
      totalOrderTakers: filteredTakers.length,
      totalConnections: filteredTakers.filter(t => t.status === 'in_call').length,
    }
  }, [monitor.counts, filteredTakers, selectedBranch])

  if (!loggedIn) {
    return (
      <div className="dashboard-login">
        <div className="dashboard-login-card">
          <h2>Manager Dashboard</h2>
          <div className="login-sub">Sign in to monitor all branches</div>
          <div className="login-field">
            <label className="field-label">Manager ID</label>
            <input placeholder="e.g. manager1" value={userId}
              onChange={e => setUserId(e.target.value)} onKeyDown={e => e.key === 'Enter' && doLogin()} />
          </div>
          <div className="login-field">
            <label className="field-label">Password</label>
            <input type="password" placeholder="••••••••" value={password}
              onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && doLogin()} />
          </div>
          <button className="login-btn" onClick={doLogin}>Login</button>
          {loginError && <div className="dashboard-error">{loginError}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard">
      <div className="dashboard-topbar">
        <h2>📊 Manager Dashboard</h2>
        <span className="updated">
          {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Waiting for data...'}
        </span>
      </div>

      <div className="dashboard-stats">
        <div className="dashboard-stat blue">
          <div className="stat-value">{filteredCounts.totalConnections}</div>
          <div className="stat-key">Active Calls</div>
        </div>
        <div className="dashboard-stat green">
          <div className="stat-value">{filteredTakers.filter(t => t.status === 'available').length}</div>
          <div className="stat-key">Available</div>
        </div>
        <div className="dashboard-stat gray">
          <div className="stat-value">{filteredTakers.filter(t => t.status === 'not_available').length}</div>
          <div className="stat-key">Offline</div>
        </div>
        <div className="dashboard-stat purple">
          <div className="stat-value">{filteredCounts.totalOrderTakers}</div>
          <div className="stat-key">Total Takers</div>
        </div>
      </div>

      <div className="dashboard-tabs">
        {[{ id: 'all', name: 'All Branches' }, ...branches].map(b => {
          const active = selectedBranch === b.id
          const count = b.id === 'all' ? monitor.takers.length : monitor.takers.filter(t => t.branchId === b.id).length
          return (
            <button key={b.id} className={`dashboard-tab${active ? ' active' : ''}`} onClick={() => setSelectedBranch(b.id)}>
              {b.name}
              {count > 0 && <span className="tab-count">{count}</span>}
            </button>
          )
        })}
      </div>

      {filteredTakers.length === 0 ? (
        <div className="dashboard-empty">
          <div className="empty-icon">📭</div>
          <div className="empty-title">No order takers online</div>
          <div className="empty-sub">
            {selectedBranch === 'all' ? 'Nobody has logged in yet' : `Nobody online at ${branchName(selectedBranch)}`}
          </div>
        </div>
      ) : (
        <div className="dashboard-grid">
          {filteredTakers.map(taker => (
            <TakerCard key={taker.socketId} taker={taker} branchName={branchName} />
          ))}
        </div>
      )}
    </div>
  )
}
