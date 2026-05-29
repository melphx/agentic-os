'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Bot, ListTodo, Terminal as TerminalIcon,
  Settings, Send, ChevronLeft, Play, RefreshCw, LogOut,
  AlertCircle, CheckCircle, Clock, Zap, Activity, X,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────

interface Agent {
  id: string; name: string; short: string; description: string
  accent: string; accent_dark: string
  status: 'active' | 'idle' | 'error' | 'offline'
  current_task: string | null
  tokens_used: number; tasks_completed: number; uptime_seconds: number; progress: number
  sparkline: number[]
  tasks?: Task[]
}

interface Task {
  id: number; agent_id: string | null; title: string; description: string | null
  type: string; status: string; priority: number
  result: string | null; error: string | null; tokens_used: number
  created_at: string; started_at: string | null; completed_at: string | null
}

interface LogEntry { id: number; agent_id: string; agent_name: string; accent: string; level: string; message: string; created_at: string }
interface Metrics { total_agents: number; active_agents: number; total_tokens: number; tasks_completed: number; tasks_pending: number; tasks_running: number; tasks_failed: number }
interface Message { role: 'user' | 'assistant'; content: string; ts: number }

// ── Helpers ────────────────────────────────────────────────────────────────

function fmt(n: number) { return n >= 1_000_000 ? `${(n/1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n) }
function fmtUptime(s: number) { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return `${h}h ${m}m` }

function Sparkline({ data, color, w=72, h=22 }: { data: number[]; color: string; w?: number; h?: number }) {
  if (!data || data.length < 2) return <svg width={w} height={h} />
  const max = Math.max(...data, 1), min = Math.min(...data, 0)
  const range = max - min || 1
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 2) - 1}`)
  const fill = `${pts.join(' L ')} L ${w},${h} L 0,${h} Z`
  return (
    <svg width={w} height={h} style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sg-${color.replace('#','')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.4} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`M ${fill}`} fill={`url(#sg-${color.replace('#','')})`} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AgentAvatar({ agent, size = 44, pulse = false }: { agent: Agent; size?: number; pulse?: boolean }) {
  const initials = agent.short.slice(0, 2)
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {pulse && agent.status === 'active' && (
        <motion.div animate={{ scale: [1, 1.4, 1], opacity: [0.5, 0, 0.5] }} transition={{ repeat: Infinity, duration: 2 }}
          style={{ position: 'absolute', inset: -4, borderRadius: '50%', background: agent.accent, opacity: 0.3 }} />
      )}
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: `linear-gradient(135deg, ${agent.accent}, ${agent.accent_dark})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.32, fontWeight: 700, color: 'white',
        boxShadow: `0 0 ${size * 0.4}px ${agent.accent}55`,
        position: 'relative', zIndex: 1,
      }}>
        {initials}
      </div>
      <div style={{
        position: 'absolute', bottom: 1, right: 1, width: size * 0.28, height: size * 0.28, borderRadius: '50%',
        background: agent.status === 'active' ? '#10b981' : agent.status === 'error' ? '#f43f5e' : agent.status === 'offline' ? '#475569' : '#94a3b8',
        border: '2px solid #0f1423', zIndex: 2,
      }} />
    </div>
  )
}

const STATUS_ICON = { active: <Zap size={11} />, idle: <Clock size={11} />, error: <AlertCircle size={11} />, offline: <X size={11} /> }
const STATUS_COLOR = { active: '#10b981', idle: '#94a3b8', error: '#f43f5e', offline: '#475569' }

// ── Sidebar ────────────────────────────────────────────────────────────────

const NAV = [
  { id: 'dashboard', icon: <LayoutDashboard size={18} />, label: 'Dashboard' },
  { id: 'agents',    icon: <Bot size={18} />,             label: 'Agents'    },
  { id: 'tasks',     icon: <ListTodo size={18} />,        label: 'Tasks'     },
  { id: 'terminal',  icon: <TerminalIcon size={18} />,    label: 'Terminal'  },
  { id: 'schedules', icon: <Clock size={18} />,           label: 'Schedules' },
  { id: 'settings',  icon: <Settings size={18} />,        label: 'Settings'  },
]

function Sidebar({ view, setView, agents, onLogout }: { view: string; setView: (v: string) => void; agents: Agent[]; onLogout: () => void }) {
  return (
    <div style={{ width: 64, flexShrink: 0, background: 'rgba(8,12,20,0.95)', borderRight: '1px solid rgba(99,102,241,0.12)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20, paddingBottom: 16, gap: 4, zIndex: 50 }}>
      <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#6366f1,#a855f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20, boxShadow: '0 0 20px rgba(99,102,241,0.4)', fontSize: 18, flexShrink: 0 }}>⬡</div>
      {NAV.map(n => (
        <motion.button key={n.id} onClick={() => setView(n.id)} whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.95 }}
          title={n.label}
          style={{ width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: view === n.id ? 'rgba(99,102,241,0.25)' : 'transparent', color: view === n.id ? '#a5b4fc' : 'rgba(148,163,184,0.5)', transition: 'all 0.15s' }}>
          {n.icon}
        </motion.button>
      ))}
      <div style={{ flex: 1 }} />
      {/* Mini agent avatars */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {agents.slice(0, 4).map(a => (
          <div key={a.id} title={a.name} style={{ width: 28, height: 28, borderRadius: '50%', background: `linear-gradient(135deg, ${a.accent}, ${a.accent_dark})`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'white', boxShadow: a.status === 'active' ? `0 0 8px ${a.accent}88` : 'none', cursor: 'default' }}>
            {a.short.slice(0,2)}
          </div>
        ))}
      </div>
      <button onClick={onLogout} title="Sign out" style={{ width: 36, height: 36, borderRadius: 10, border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(148,163,184,0.4)' }}>
        <LogOut size={16} />
      </button>
    </div>
  )
}

// ── Agent Card ─────────────────────────────────────────────────────────────

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <motion.div layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} whileHover={{ y: -2 }}
      onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ background: hovered ? 'rgba(15,20,35,0.95)' : 'rgba(15,20,35,0.7)', border: `1px solid ${hovered ? agent.accent + '55' : 'rgba(99,102,241,0.12)'}`, borderRadius: 16, padding: 20, cursor: 'pointer', transition: 'all 0.2s', boxShadow: hovered ? `0 0 24px ${agent.accent}22` : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
        <AgentAvatar agent={agent} pulse />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontWeight: 600, color: 'white', fontSize: 14 }}>{agent.name}</span>
            <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 20, background: `${STATUS_COLOR[agent.status]}22`, color: STATUS_COLOR[agent.status], display: 'flex', alignItems: 'center', gap: 3 }}>
              {STATUS_ICON[agent.status]}{agent.status}
            </span>
          </div>
          <p style={{ fontSize: 12, color: 'rgba(148,163,184,0.6)', margin: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{agent.current_task || agent.description}</p>
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 20 }}>
          <div><div style={{ fontSize: 10, color: 'rgba(148,163,184,0.5)', marginBottom: 2 }}>TOKENS</div><div style={{ fontSize: 14, fontWeight: 600, color: agent.accent }}>{fmt(agent.tokens_used)}</div></div>
          <div><div style={{ fontSize: 10, color: 'rgba(148,163,184,0.5)', marginBottom: 2 }}>TASKS</div><div style={{ fontSize: 14, fontWeight: 600, color: 'white' }}>{agent.tasks_completed}</div></div>
        </div>
        <Sparkline data={agent.sparkline.length ? agent.sparkline : [0,0,0,0,0,0,0,0,0,0,0,0]} color={agent.accent} />
      </div>
      {agent.progress > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ height: 3, borderRadius: 2, background: 'rgba(148,163,184,0.1)', overflow: 'hidden' }}>
            <motion.div animate={{ width: `${agent.progress}%` }} transition={{ duration: 0.6, ease: 'easeOut' }} style={{ height: '100%', background: `linear-gradient(90deg, ${agent.accent_dark}, ${agent.accent})`, borderRadius: 2 }} />
          </div>
        </div>
      )}
    </motion.div>
  )
}

// ── Agent Detail ───────────────────────────────────────────────────────────

function AgentDetailView({ agent, onBack, onRunTask }: { agent: Agent; onBack: () => void; onRunTask: (a: Agent) => void }) {
  const [tasks, setTasks] = useState<Task[]>(agent.tasks || [])
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    const res = await fetch(`/api/agents/${agent.id}`)
    if (res.ok) { const d = await res.json(); setTasks(d.tasks || []) }
    setLoading(false)
  }

  useEffect(() => { refresh() }, [agent.id])

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button onClick={onBack} style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '6px 12px', color: '#a5b4fc', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <ChevronLeft size={14} /> Back
        </button>
        <AgentAvatar agent={agent} size={44} pulse />
        <div>
          <h2 style={{ color: 'white', fontWeight: 700, margin: 0, fontSize: 18 }}>{agent.name}</h2>
          <p style={{ color: 'rgba(148,163,184,0.6)', margin: 0, fontSize: 13 }}>{agent.description}</p>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={() => refresh()} style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '6px 10px', color: '#a5b4fc', cursor: 'pointer' }}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={() => onRunTask(agent)}
          style={{ background: `linear-gradient(135deg, ${agent.accent_dark}, ${agent.accent})`, border: 'none', borderRadius: 8, padding: '7px 16px', color: 'white', cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Play size={13} /> Run Task
        </motion.button>
      </div>

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'STATUS', value: agent.status, color: STATUS_COLOR[agent.status] },
          { label: 'TOKENS', value: fmt(agent.tokens_used), color: agent.accent },
          { label: 'TASKS DONE', value: agent.tasks_completed, color: 'white' },
          { label: 'UPTIME', value: fmtUptime(agent.uptime_seconds), color: '#94a3b8' },
        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.5)', marginBottom: 6 }}>{s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Tasks list */}
      <h3 style={{ color: 'rgba(148,163,184,0.8)', fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 12 }}>RECENT TASKS</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tasks.length === 0 && <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 13 }}>No tasks yet. Use "Run Task" to dispatch one.</p>}
        {tasks.map(t => (
          <div key={t.id} style={{ background: 'rgba(15,20,35,0.6)', border: '1px solid rgba(99,102,241,0.1)', borderRadius: 10, padding: '12px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'white' }}>{t.title}</span>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 20, background: t.status === 'completed' ? 'rgba(16,185,129,0.15)' : t.status === 'failed' ? 'rgba(244,63,94,0.15)' : t.status === 'running' ? 'rgba(99,102,241,0.15)' : 'rgba(148,163,184,0.1)', color: t.status === 'completed' ? '#10b981' : t.status === 'failed' ? '#f43f5e' : t.status === 'running' ? '#a5b4fc' : '#94a3b8' }}>
                {t.status}
              </span>
              <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', marginLeft: 'auto' }}>{new Date(t.created_at).toLocaleString()}</span>
            </div>
            {t.result && <p style={{ fontSize: 11, color: 'rgba(148,163,184,0.6)', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 80, overflow: 'hidden' }}>{t.result.slice(0, 300)}</p>}
            {t.error  && <p style={{ fontSize: 11, color: '#f43f5e', margin: 0 }}>{t.error}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Run Task Modal ─────────────────────────────────────────────────────────

function RunTaskModal({ agent, onClose, onSubmit }: { agent: Agent; onClose: () => void; onSubmit: (d: any) => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState('general')
  const [priority, setPriority] = useState(2)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    await onSubmit({ agent_id: agent.id, title, description, type, priority })
    setLoading(false)
    onClose()
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, backdropFilter: 'blur(4px)' }}>
      <motion.div initial={{ scale: 0.95, y: 16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }}
        style={{ background: 'rgba(15,20,35,0.98)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 16, padding: 28, width: 480, maxWidth: '90vw' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <AgentAvatar agent={agent} size={36} />
          <div>
            <h3 style={{ color: 'white', margin: 0, fontWeight: 700, fontSize: 16 }}>Dispatch Task</h3>
            <p style={{ color: 'rgba(148,163,184,0.5)', margin: 0, fontSize: 12 }}>{agent.name}</p>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer' }}><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.7)', marginBottom: 6, fontWeight: 600 }}>TITLE</label>
            <input value={title} onChange={e => setTitle(e.target.value)} required placeholder="e.g. Scrape competitor pricing"
              style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.7)', marginBottom: 6, fontWeight: 600 }}>DESCRIPTION</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} required rows={3} placeholder="Describe exactly what the agent should do…"
              style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.7)', marginBottom: 6, fontWeight: 600 }}>TYPE</label>
              <select value={type} onChange={e => setType(e.target.value)} style={{ width: '100%', background: 'rgba(15,20,35,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none' }}>
                {['general','code','scrape','file','api','browser','security','search'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.7)', marginBottom: 6, fontWeight: 600 }}>PRIORITY</label>
              <select value={priority} onChange={e => setPriority(Number(e.target.value))} style={{ width: '100%', background: 'rgba(15,20,35,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none' }}>
                <option value={1}>1 — High</option>
                <option value={2}>2 — Normal</option>
                <option value={3}>3 — Low</option>
              </select>
            </div>
          </div>
          <motion.button type="submit" disabled={loading} whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
            style={{ background: `linear-gradient(135deg, ${agent.accent_dark}, ${agent.accent})`, border: 'none', borderRadius: 8, padding: '10px 0', color: 'white', fontWeight: 600, fontSize: 14, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
            {loading ? 'Dispatching…' : '⚡ Dispatch Task'}
          </motion.button>
        </form>
      </motion.div>
    </motion.div>
  )
}

// ── Chat Panel ─────────────────────────────────────────────────────────────

function ChatPanel({ messages, onSend, loading }: { messages: Message[]; onSend: (m: string) => void; loading: boolean }) {
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [messages])

  function handleSend() {
    const t = input.trim()
    if (!t || loading) return
    setInput('')
    onSend(t)
  }

  return (
    <div style={{ width: 320, flexShrink: 0, background: 'rgba(8,12,20,0.95)', borderLeft: '1px solid rgba(99,102,241,0.12)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#a855f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, boxShadow: '0 0 12px rgba(99,102,241,0.4)' }}>⬡</div>
        <div>
          <div style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>Hermes</div>
          <div style={{ color: 'rgba(148,163,184,0.5)', fontSize: 11 }}>OpenAI · gpt-4o-mini</div>
        </div>
        {loading && <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }} style={{ marginLeft: 'auto' }}><RefreshCw size={14} color="#6366f1" /></motion.div>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'rgba(148,163,184,0.35)', fontSize: 12, marginTop: 40 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>⬡</div>
            Ask Hermes anything or dispatch tasks via chat
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ maxWidth: '85%', padding: '9px 13px', borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px', background: m.role === 'user' ? 'linear-gradient(135deg,#4338ca,#6366f1)' : 'rgba(15,20,35,0.9)', border: m.role === 'assistant' ? '1px solid rgba(99,102,241,0.15)' : 'none', color: 'white', fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', gap: 4, padding: '8px 0 0 4px' }}>
            {[0,1,2].map(i => <motion.div key={i} animate={{ opacity: [0.3,1,0.3] }} transition={{ repeat: Infinity, duration: 1.2, delay: i*0.2 }} style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366f1' }} />)}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div style={{ padding: '12px 12px 16px', borderTop: '1px solid rgba(99,102,241,0.1)', display: 'flex', gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()} placeholder="Message Hermes…"
          style={{ flex: 1, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none' }} />
        <motion.button whileTap={{ scale: 0.9 }} onClick={handleSend} disabled={loading}
          style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: loading ? 0.5 : 1 }}>
          <Send size={15} />
        </motion.button>
      </div>
    </div>
  )
}

// ── Dashboard View ─────────────────────────────────────────────────────────

function DashboardView({ agents, metrics, activity, onSelectAgent }: { agents: Agent[]; metrics: Metrics | null; activity: LogEntry[]; onSelectAgent: (a: Agent) => void }) {
  const totalTokens = metrics?.total_tokens || 0
  const activeCount = metrics?.active_agents || 0
  const tasksDone   = metrics?.tasks_completed || 0
  const tasksPending = metrics?.tasks_pending || 0

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>Mission Control</h1>
        <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: '4px 0 0' }}>Production · Hermes AI · {new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' })}</p>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'ACTIVE AGENTS', value: activeCount, color: '#10b981', icon: <Activity size={16} /> },
          { label: 'TOTAL TOKENS',  value: fmt(totalTokens), color: '#6366f1', icon: <Zap size={16} /> },
          { label: 'TASKS DONE',    value: tasksDone,  color: '#06b6d4', icon: <CheckCircle size={16} /> },
          { label: 'TASKS QUEUED',  value: tasksPending, color: '#f59e0b', icon: <Clock size={16} /> },
        ].map(s => (
          <div key={s.label} style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: '16px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.5)', fontWeight: 600, letterSpacing: '0.06em' }}>{s.label}</span>
              <span style={{ color: s.color, opacity: 0.7 }}>{s.icon}</span>
            </div>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Agent grid */}
      <h3 style={{ color: 'rgba(148,163,184,0.6)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 14 }}>AGENT FLEET</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14, marginBottom: 24 }}>
        {agents.map(a => <AgentCard key={a.id} agent={a} onClick={() => onSelectAgent(a)} />)}
      </div>

      {/* Activity feed */}
      <h3 style={{ color: 'rgba(148,163,184,0.6)', fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', marginBottom: 14 }}>LIVE ACTIVITY</h3>
      <div style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, overflow: 'hidden' }}>
        {activity.length === 0 && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, padding: '20px 16px', margin: 0 }}>No activity yet. Dispatch a task to see live logs here.</p>}
        {activity.slice(0, 10).map((log, i) => (
          <div key={log.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 16px', borderBottom: i < activity.slice(0,10).length - 1 ? '1px solid rgba(99,102,241,0.07)' : 'none' }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: log.level === 'error' ? '#f43f5e' : log.level === 'success' ? '#10b981' : log.level === 'warn' ? '#f59e0b' : '#6366f1', marginTop: 5, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: log.accent || '#a5b4fc', fontWeight: 600, marginRight: 8 }}>{log.agent_name}</span>
              <span style={{ fontSize: 12, color: 'rgba(148,163,184,0.7)', wordBreak: 'break-word' }}>{log.message.slice(0, 120)}</span>
            </div>
            <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.3)', flexShrink: 0 }}>{new Date(log.created_at).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tasks View ─────────────────────────────────────────────────────────────

function TasksView({ tasks, agents }: { tasks: Task[]; agents: Agent[] }) {
  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]))
  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: '0 0 20px' }}>Task Queue</h1>
      {tasks.length === 0 && <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 13 }}>No tasks yet. Open an agent and click "Run Task".</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tasks.map(t => {
          const ag = t.agent_id ? agentMap[t.agent_id] : null
          return (
            <div key={t.id} style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.1)', borderRadius: 12, padding: '14px 18px', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              {ag && <AgentAvatar agent={ag} size={32} />}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>{t.title}</span>
                  <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 20, background: t.priority === 1 ? 'rgba(244,63,94,0.15)' : t.priority === 2 ? 'rgba(99,102,241,0.15)' : 'rgba(148,163,184,0.1)', color: t.priority === 1 ? '#f43f5e' : t.priority === 2 ? '#a5b4fc' : '#94a3b8' }}>P{t.priority}</span>
                  <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 20, background: t.status === 'completed' ? 'rgba(16,185,129,0.15)' : t.status === 'failed' ? 'rgba(244,63,94,0.15)' : t.status === 'running' ? 'rgba(99,102,241,0.2)' : 'rgba(148,163,184,0.1)', color: t.status === 'completed' ? '#10b981' : t.status === 'failed' ? '#f43f5e' : t.status === 'running' ? '#a5b4fc' : '#94a3b8' }}>{t.status}</span>
                </div>
                <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, margin: 0 }}>{ag?.name || 'Unassigned'} · {t.type} · {new Date(t.created_at).toLocaleString()}</p>
                {t.result && <p style={{ color: 'rgba(148,163,184,0.6)', fontSize: 11, margin: '6px 0 0', whiteSpace: 'pre-wrap', maxHeight: 60, overflow: 'hidden' }}>{t.result.slice(0,200)}</p>}
                {t.error  && <p style={{ color: '#f43f5e', fontSize: 11, margin: '6px 0 0' }}>{t.error}</p>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Terminal View ──────────────────────────────────────────────────────────

function TerminalView({ agents, metrics }: { agents: Agent[]; metrics: Metrics | null }) {
  const [history, setHistory] = useState<string[]>([
    '⬡ Claude OS Terminal v2.0 — Production',
    'Type "help" for available commands.',
    '',
  ])
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [history])

  function exec(cmd: string) {
    const parts = cmd.trim().toLowerCase().split(' ')
    const lines: string[] = [`$ ${cmd}`]
    switch (parts[0]) {
      case 'help':
        lines.push('  status   — system overview', '  agents   — list all agents', '  tasks    — show task queue', '  metrics  — token / task stats', '  clear    — clear terminal', '  version  — build info')
        break
      case 'status':
        lines.push(`  Agents: ${metrics?.total_agents || 0} total, ${metrics?.active_agents || 0} active`, `  Tasks: ${(metrics?.tasks_completed||0)+(metrics?.tasks_pending||0)+(metrics?.tasks_running||0)} total`, `  Tokens: ${fmt(metrics?.total_tokens || 0)}`, `  AI: nous-hermes2 via Ollama`)
        break
      case 'agents':
        agents.forEach(a => lines.push(`  [${a.status.toUpperCase().padEnd(7)}] ${a.name.padEnd(20)} tokens=${fmt(a.tokens_used)}`))
        break
      case 'metrics':
        lines.push(`  completed=${metrics?.tasks_completed||0}  running=${metrics?.tasks_running||0}  pending=${metrics?.tasks_pending||0}  failed=${metrics?.tasks_failed||0}`)
        break
      case 'version':
        lines.push('  Claude OS v2.0.0 · Next.js 14 · SQLite · OpenAI · JWT Auth')
        break
      case 'clear':
        setHistory(['⬡ Terminal cleared.', '']); return
      default:
        lines.push(`  Unknown command: ${parts[0]}. Type "help".`)
    }
    lines.push('')
    setHistory(h => [...h, ...lines])
  }

  return (
    <div style={{ padding: 24, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: '0 0 16px' }}>Terminal</h1>
      <div style={{ flex: 1, background: 'rgba(4,8,16,0.9)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 14, padding: 20, overflowY: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 1.7 }}>
        {history.map((l, i) => <div key={i} style={{ color: l.startsWith('$') ? '#a5b4fc' : l.startsWith('  [') ? '#10b981' : 'rgba(148,163,184,0.8)', whiteSpace: 'pre' }}>{l}</div>)}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <span style={{ color: '#6366f1', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, padding: '8px 0', flexShrink: 0 }}>$</span>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { exec(input); setInput('') } }} placeholder="Type a command…" autoFocus
          style={{ flex: 1, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '7px 12px', color: 'white', fontFamily: 'JetBrains Mono, monospace', fontSize: 13, outline: 'none' }} />
      </div>
    </div>
  )
}

// ── Settings View ──────────────────────────────────────────────────────────

function SettingsView() {
  const [openaiUrl, setOpenaiUrl] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('openaiUrl') || 'https://api.openai.com/v1' : '')
  const [model, setModel] = useState(() => typeof window !== 'undefined' ? localStorage.getItem('openaiModel') || 'gpt-4o-mini' : '')
  const [saved, setSaved]         = useState(false)

  function save() {
    localStorage.setItem('openaiUrl', openaiUrl)
    localStorage.setItem('openaiModel', model)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div style={{ padding: 24, maxWidth: 520 }}>
      <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: '0 0 24px' }}>Settings</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {[
          { label: 'OPENAI BASE URL', value: openaiUrl, set: setOpenaiUrl, placeholder: 'https://api.openai.com/v1' },
          { label: 'MODEL', value: model, set: setModel, placeholder: 'gpt-4o-mini' },
        ].map(f => (
          <div key={f.label} style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: '16px 18px' }}>
            <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.6)', fontWeight: 600, letterSpacing: '0.06em', marginBottom: 8 }}>{f.label}</label>
            <input value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.placeholder}
              style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          </div>
        ))}
        <motion.button onClick={save} whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
          style={{ background: saved ? 'rgba(16,185,129,0.2)' : 'linear-gradient(135deg,#4338ca,#6366f1)', border: saved ? '1px solid rgba(16,185,129,0.4)' : 'none', borderRadius: 10, padding: '10px 0', color: saved ? '#10b981' : 'white', fontWeight: 600, cursor: 'pointer', fontSize: 14 }}>
          {saved ? '✓ Saved' : 'Save Settings'}
        </motion.button>
        <div style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: '14px 18px' }}>
          <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.5)', marginBottom: 6 }}>STACK</div>
          <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.7)', lineHeight: 1.8 }}>Next.js 14 · SQLite (better-sqlite3) · JWT Auth · Hermes via Ollama · Framer Motion</div>
        </div>
      </div>
    </div>
  )
}


// ── Schedules View ─────────────────────────────────────────────────────────

interface Schedule { id: number; agent_id: string; title: string; description: string; type: string; cron: string; enabled: number; last_run: string | null; created_at: string }

function SchedulesView({ agents }: { agents: Agent[] }) {
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ agent_id: 'research', title: '', description: '', type: 'general', cron: '0 9 * * *' })
  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]))

  async function load() {
    const res = await fetch('/api/schedules')
    if (res.ok) setSchedules(await res.json())
  }

  useEffect(() => { load() }, [])

  async function createSchedule(e: React.FormEvent) {
    e.preventDefault()
    await fetch('/api/schedules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
    setShowForm(false)
    setForm({ agent_id: 'research', title: '', description: '', type: 'general', cron: '0 9 * * *' })
    load()
  }

  async function toggleSchedule(id: number, enabled: number) {
    await fetch('/api/schedules', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, enabled: !enabled }) })
    load()
  }

  const CRON_PRESETS = [
    { label: 'Every hour',    value: '0 * * * *'    },
    { label: 'Every morning', value: '0 9 * * *'    },
    { label: 'Every day',     value: '0 0 * * *'    },
    { label: 'Every Monday',  value: '0 9 * * 1'    },
    { label: 'Every 15 min',  value: '*/15 * * * *' },
  ]

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>Schedules</h1>
          <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: '4px 0 0' }}>Automate agent tasks on a recurring schedule</p>
        </div>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={() => setShowForm(!showForm)}
          style={{ background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 10, padding: '8px 18px', color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          + New Schedule
        </motion.button>
      </div>

      <AnimatePresence>
        {showForm && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            style={{ background: 'rgba(15,20,35,0.9)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 14, padding: 24, marginBottom: 20, overflow: 'hidden' }}>
            <h3 style={{ color: 'white', fontWeight: 600, margin: '0 0 16px', fontSize: 15 }}>New Scheduled Task</h3>
            <form onSubmit={createSchedule} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.6)', fontWeight: 600, marginBottom: 6 }}>TITLE</label>
                <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required placeholder="Daily web research"
                  style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.6)', fontWeight: 600, marginBottom: 6 }}>TASK DESCRIPTION</label>
                <textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} required rows={2} placeholder="Search for latest AI news and summarise the top 5 stories"
                  style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.6)', fontWeight: 600, marginBottom: 6 }}>AGENT</label>
                <select value={form.agent_id} onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
                  style={{ width: '100%', background: 'rgba(15,20,35,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none' }}>
                  {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.6)', fontWeight: 600, marginBottom: 6 }}>TYPE</label>
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                  style={{ width: '100%', background: 'rgba(15,20,35,0.9)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none' }}>
                  {['general','code','scrape','file','api','browser','security','search'].map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label style={{ display: 'block', fontSize: 11, color: 'rgba(148,163,184,0.6)', fontWeight: 600, marginBottom: 6 }}>CRON SCHEDULE</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {CRON_PRESETS.map(p => (
                    <button key={p.value} type="button" onClick={() => setForm(f => ({ ...f, cron: p.value }))}
                      style={{ padding: '3px 10px', borderRadius: 20, border: `1px solid ${form.cron === p.value ? '#6366f1' : 'rgba(99,102,241,0.2)'}`, background: form.cron === p.value ? 'rgba(99,102,241,0.2)' : 'transparent', color: form.cron === p.value ? '#a5b4fc' : 'rgba(148,163,184,0.5)', fontSize: 11, cursor: 'pointer' }}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <input value={form.cron} onChange={e => setForm(f => ({ ...f, cron: e.target.value }))} placeholder="* * * * *"
                  style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'JetBrains Mono, monospace' }} />
                <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 11, margin: '4px 0 0' }}>Format: minute hour day month weekday</p>
              </div>
              <div style={{ gridColumn: '1/-1', display: 'flex', gap: 10 }}>
                <motion.button type="submit" whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
                  style={{ flex: 1, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 8, padding: '9px 0', color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                  Create Schedule
                </motion.button>
                <button type="button" onClick={() => setShowForm(false)}
                  style={{ padding: '9px 18px', background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 8, color: 'rgba(148,163,184,0.7)', fontSize: 13, cursor: 'pointer' }}>
                  Cancel
                </button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {schedules.length === 0 && !showForm && (
        <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 13 }}>No schedules yet. Click "New Schedule" to automate your first task.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {schedules.map(s => {
          const ag = agentMap[s.agent_id]
          return (
            <div key={s.id} style={{ background: 'rgba(15,20,35,0.7)', border: `1px solid ${s.enabled ? 'rgba(99,102,241,0.2)' : 'rgba(148,163,184,0.08)'}`, borderRadius: 12, padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 16 }}>
              {ag && <AgentAvatar agent={ag} size={36} />}
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>{s.title}</span>
                  <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 20, background: 'rgba(99,102,241,0.15)', color: '#a5b4fc', fontFamily: 'JetBrains Mono, monospace' }}>{s.cron}</span>
                  <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 20, background: 'rgba(148,163,184,0.1)', color: '#94a3b8' }}>{s.type}</span>
                </div>
                <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, margin: 0 }}>{ag?.name || s.agent_id} · {s.description.slice(0, 80)}</p>
                {s.last_run && <p style={{ color: 'rgba(148,163,184,0.35)', fontSize: 11, margin: '3px 0 0' }}>Last run: {new Date(s.last_run).toLocaleString()}</p>}
              </div>
              <button onClick={() => toggleSchedule(s.id, s.enabled)}
                style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${s.enabled ? 'rgba(16,185,129,0.3)' : 'rgba(148,163,184,0.15)'}`, background: s.enabled ? 'rgba(16,185,129,0.1)' : 'rgba(148,163,184,0.05)', color: s.enabled ? '#10b981' : 'rgba(148,163,184,0.4)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                {s.enabled ? 'Active' : 'Paused'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function Page() {
  const [view, setView]               = useState('dashboard')
  const [agents, setAgents]           = useState<Agent[]>([])
  const [tasks, setTasks]             = useState<Task[]>([])
  const [metrics, setMetrics]         = useState<Metrics | null>(null)
  const [activity, setActivity]       = useState<LogEntry[]>([])
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)
  const [runAgent, setRunAgent]       = useState<Agent | null>(null)
  const [messages, setMessages]       = useState<Message[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  // Poll data every 8s
  const fetchAll = useCallback(async () => {
    const [agRes, tkRes, meRes] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/tasks?limit=50'),
      fetch('/api/metrics'),
    ])
    if (agRes.status === 401) { window.location.href = '/login'; return }
    if (agRes.ok) setAgents(await agRes.json())
    if (tkRes.ok) setTasks(await tkRes.json())
    if (meRes.ok) { const d = await meRes.json(); setMetrics(d.totals); setActivity(d.recentActivity) }
  }, [])

  useEffect(() => {
    fetchAll()
    const id = setInterval(fetchAll, 8000)
    return () => clearInterval(id)
  }, [fetchAll])

  async function handleSend(text: string) {
    const userMsg: Message = { role: 'user', content: text, ts: Date.now() }
    const newMsgs = [...messages, userMsg]
    setMessages(newMsgs)
    setChatLoading(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMsgs.map(m => ({ role: m.role, content: m.content })) }),
      })
      const data = await res.json()
      if (data.content) {
        setMessages(m => [...m, { role: 'assistant', content: data.content, ts: Date.now() }])
      } else if (data.error) {
        setMessages(m => [...m, { role: 'assistant', content: `⚠️ Error: ${data.error}`, ts: Date.now() }])
      }
    } catch (err: any) {
      setMessages(m => [...m, { role: 'assistant', content: `⚠️ Network error: ${err.message}`, ts: Date.now() }])
    } finally {
      setChatLoading(false)
    }
  }

  async function handleRunTask(data: any) {
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    setTimeout(fetchAll, 1000)
  }

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  // Inject updated sparklines into selectedAgent
  const liveSelectedAgent = selectedAgent ? agents.find(a => a.id === selectedAgent.id) || selectedAgent : null

  function mainContent() {
    if (liveSelectedAgent) return (
      <AgentDetailView agent={liveSelectedAgent} onBack={() => setSelectedAgent(null)} onRunTask={a => setRunAgent(a)} />
    )
    switch (view) {
      case 'dashboard': return <DashboardView agents={agents} metrics={metrics} activity={activity} onSelectAgent={a => { setSelectedAgent(a); setView('agents') }} />
      case 'agents':    return (
        <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
          <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: '0 0 20px' }}>Agents</h1>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 14 }}>
            {agents.map(a => <AgentCard key={a.id} agent={a} onClick={() => setSelectedAgent(a)} />)}
          </div>
        </div>
      )
      case 'tasks':    return <TasksView tasks={tasks} agents={agents} />
      case 'terminal': return <TerminalView agents={agents} metrics={metrics} />
      case 'schedules': return <SchedulesView agents={agents} />
      case 'settings': return <SettingsView />
      default: return null
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#080c14', color: 'white', fontFamily: 'Inter, sans-serif', overflow: 'hidden' }}>
      {/* Grid bg */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', backgroundImage: 'linear-gradient(rgba(99,102,241,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.03) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      <Sidebar view={view} setView={v => { setView(v); setSelectedAgent(null) }} agents={agents} onLogout={handleLogout} />

      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <AnimatePresence mode="wait">
          <motion.div key={liveSelectedAgent?.id || view} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} style={{ minHeight: '100%' }}>
            {mainContent()}
          </motion.div>
        </AnimatePresence>
      </div>

      <ChatPanel messages={messages} onSend={handleSend} loading={chatLoading} />

      <AnimatePresence>
        {runAgent && <RunTaskModal agent={runAgent} onClose={() => setRunAgent(null)} onSubmit={handleRunTask} />}
      </AnimatePresence>
    </div>
  )
}
