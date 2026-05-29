'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Bot, ListTodo, Terminal as TerminalIcon,
  Settings, Send, ChevronLeft, Play, RefreshCw, LogOut,
  AlertCircle, CheckCircle, Clock, Zap, Activity, X, Search, Bell,
  BookOpen, Trash2, Download, Cpu, SlidersHorizontal, Layers, Copy, Check,
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

interface Toast { id: number; message: string; type: 'success' | 'error' | 'info' }

// ── Simple markdown renderer ────────────────────────────────────────────────

function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const elements: React.ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) { elements.push(<h3 key={i} style={{ color: 'white', fontWeight: 700, fontSize: 13, margin: '10px 0 4px' }}>{line.slice(4)}</h3>) }
    else if (line.startsWith('## ')) { elements.push(<h2 key={i} style={{ color: 'white', fontWeight: 700, fontSize: 14, margin: '12px 0 4px' }}>{line.slice(3)}</h2>) }
    else if (line.startsWith('# '))  { elements.push(<h1 key={i} style={{ color: 'white', fontWeight: 700, fontSize: 15, margin: '12px 0 6px' }}>{line.slice(2)}</h1>) }
    else if (line.startsWith('- ') || line.startsWith('• ')) { elements.push(<div key={i} style={{ color: 'rgba(148,163,184,0.85)', fontSize: 13, lineHeight: 1.6, paddingLeft: 12 }}>{'• '}{renderInline(line.slice(2))}</div>) }
    else if (line.startsWith('```')) {
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++ }
      elements.push(<pre key={i} style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, padding: '8px 12px', fontSize: 11, color: '#a5b4fc', overflowX: 'auto', margin: '6px 0', fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{codeLines.join('\n')}</pre>)
    }
    else if (line === '') { elements.push(<div key={i} style={{ height: 4 }} />) }
    else { elements.push(<p key={i} style={{ color: 'rgba(148,163,184,0.85)', fontSize: 13, lineHeight: 1.6, margin: '2px 0' }}>{renderInline(line)}</p>) }
    i++
  }
  return <div>{elements}</div>
}

function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} style={{ background: 'rgba(99,102,241,0.2)', borderRadius: 3, padding: '1px 5px', fontSize: 11, color: '#a5b4fc', fontFamily: 'JetBrains Mono, monospace' }}>{p.slice(1,-1)}</code>
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} style={{ color: 'white', fontWeight: 600 }}>{p.slice(2,-2)}</strong>
    return p
  })
}

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


// ── Toast System ───────────────────────────────────────────────────────────

function ToastContainer({ toasts, remove }: { toasts: Toast[]; remove: (id: number) => void }) {
  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      <AnimatePresence>
        {toasts.map(t => (
          <motion.div key={t.id} initial={{ opacity: 0, x: 60, scale: 0.95 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 60 }}
            style={{ background: 'rgba(15,20,35,0.97)', border: `1px solid ${t.type === 'success' ? 'rgba(16,185,129,0.4)' : t.type === 'error' ? 'rgba(244,63,94,0.4)' : 'rgba(99,102,241,0.4)'}`, borderRadius: 12, padding: '10px 16px', color: 'white', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, backdropFilter: 'blur(10px)', pointerEvents: 'all', boxShadow: '0 4px 24px rgba(0,0,0,0.4)', maxWidth: 320 }}>
            <span style={{ fontSize: 16 }}>{t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : 'ℹ️'}</span>
            <span style={{ flex: 1 }}>{t.message}</span>
            <button onClick={() => remove(t.id)} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', padding: 0, fontSize: 16, lineHeight: 1 }}>×</button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

// ── Global Search ──────────────────────────────────────────────────────────

function GlobalSearch({ onClose, onNavigate }: { onClose: () => void; onNavigate: (view: string, id?: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    if (!query.trim()) { setResults([]); return }
    const t = setTimeout(async () => {
      const res = await fetch('/api/search?q=' + encodeURIComponent(query))
      if (res.ok) setResults(await res.json())
    }, 200)
    return () => clearTimeout(t)
  }, [query])

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 300, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80, backdropFilter: 'blur(4px)' }}>
      <motion.div initial={{ scale: 0.95, y: -16 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95 }}
        onClick={e => e.stopPropagation()}
        style={{ width: 560, maxWidth: '90vw', background: 'rgba(12,16,28,0.98)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid rgba(99,102,241,0.12)' }}>
          <Search size={16} color="rgba(148,163,184,0.5)" />
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && onClose()}
            placeholder="Search agents, tasks, logs…"
            style={{ flex: 1, background: 'none', border: 'none', color: 'white', fontSize: 15, outline: 'none' }} />
          <kbd style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 4, padding: '2px 6px' }}>ESC</kbd>
        </div>
        <div style={{ maxHeight: 400, overflowY: 'auto' }}>
          {results.length === 0 && query && (
            <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 13, padding: '20px 18px', margin: 0 }}>No results for "{query}"</p>
          )}
          {results.length === 0 && !query && (
            <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, padding: '20px 18px', margin: 0 }}>Type to search across agents, tasks, and logs…</p>
          )}
          {results.map((r: any, i: number) => (
            <div key={i} onClick={() => { onNavigate(r.type === 'agent' ? 'agents' : 'tasks', r.id); onClose() }}
              style={{ padding: '12px 18px', cursor: 'pointer', borderBottom: '1px solid rgba(99,102,241,0.07)', display: 'flex', alignItems: 'center', gap: 12 }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 20, background: r.type === 'agent' ? 'rgba(99,102,241,0.2)' : r.type === 'task' ? 'rgba(16,185,129,0.15)' : 'rgba(148,163,184,0.1)', color: r.type === 'agent' ? '#a5b4fc' : r.type === 'task' ? '#10b981' : '#94a3b8', flexShrink: 0 }}>{r.type}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'white', fontSize: 13, fontWeight: 600, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.title}</div>
                {r.subtitle && <div style={{ color: 'rgba(148,163,184,0.5)', fontSize: 11, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{r.subtitle}</div>}
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </motion.div>
  )
}

// ── Sidebar ────────────────────────────────────────────────────────────────

const NAV = [
  { id: 'dashboard', icon: <LayoutDashboard size={18} />, label: 'Dashboard' },
  { id: 'agents',    icon: <Bot size={18} />,             label: 'Agents'    },
  { id: 'tasks',     icon: <ListTodo size={18} />,        label: 'Tasks'     },
  { id: 'terminal',  icon: <TerminalIcon size={18} />,    label: 'Terminal'  },
  { id: 'schedules', icon: <Clock size={18} />,           label: 'Schedules' },
  { id: 'settings',  icon: <Settings size={18} />,        label: 'Settings'  },
]

function Sidebar({ view, setView, agents, onLogout, onSearch }: { view: string; setView: (v: string) => void; agents: Agent[]; onLogout: () => void; onSearch: () => void }) {
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
      <motion.button whileHover={{ scale: 1.08 }} whileTap={{ scale: 0.95 }} onClick={() => onSearch()}
        title="Search (Ctrl+K)"
        style={{ width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', color: 'rgba(148,163,184,0.5)' }}>
        <Search size={18} />
      </motion.button>
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



// ── Train Sidebar Strip (compact file count shown when Train tab active) ──

function TrainSidebarStrip({ agent }: { agent: Agent }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    fetch(`/api/agents/train?agent_id=${agent.id}`)
      .then(r => r.ok ? r.json() : [])
      .then((d: any[]) => setCount(d.length))
  }, [agent.id])
  return (
    <div style={{ padding: '12px 14px', color: 'rgba(148,163,184,0.4)', fontSize: 12, textAlign: 'center' }}>
      {count > 0
        ? <><span style={{ color: agent.accent, fontWeight: 600 }}>{count}</span> file{count !== 1 ? 's' : ''} in knowledge base</>
        : 'No files yet — upload in the panel →'}
    </div>
  )
}

// ── Train Panel ────────────────────────────────────────────────────────────

interface AgentKnowledge { id: number; agent_id: string; filename: string; file_type: string; file_size: number; created_at: string }

function TrainPanel({ agent }: { agent: Agent }) {
  const [files, setFiles] = useState<AgentKnowledge[]>([])
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function load() {
    const res = await fetch(`/api/agents/train?agent_id=${agent.id}`)
    if (res.ok) setFiles(await res.json())
  }

  useEffect(() => { load() }, [agent.id])

  async function uploadFiles(fileList: FileList | null) {
    if (!fileList || !fileList.length) return
    setUploading(true)
    setUploadMsg(null)
    const fd = new FormData()
    fd.append('agent_id', agent.id)
    Array.from(fileList).forEach(f => fd.append('files', f))
    try {
      const res = await fetch('/api/agents/train', { method: 'POST', body: fd })
      const data = await res.json()
      const saved = data.saved || []
      const errors = saved.filter((s: any) => s.error)
      const ok = saved.filter((s: any) => !s.error)
      if (ok.length) setUploadMsg({ text: `✅ ${ok.length} file${ok.length > 1 ? 's' : ''} uploaded`, ok: true })
      else if (errors.length) setUploadMsg({ text: `❌ ${errors[0].error}`, ok: false })
      load()
    } catch (err: any) {
      setUploadMsg({ text: `❌ ${err.message}`, ok: false })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
      setTimeout(() => setUploadMsg(null), 3500)
    }
  }

  async function remove(id: number) {
    await fetch(`/api/agents/train?id=${id}&agent_id=${agent.id}`, { method: 'DELETE' })
    load()
  }

  function fmtSize(bytes: number) {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const FILE_ICON: Record<string, string> = { pdf: '📄', csv: '📊', json: '📋', markdown: '📝', html: '🌐', text: '📃' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 24px', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ color: 'white', fontWeight: 700, fontSize: 17, margin: '0 0 4px' }}>Train {agent.name}</h2>
        <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: 0 }}>
          Upload documents, PDFs, CSVs, or text files. The agent will use this knowledge on every task.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); uploadFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? agent.accent : 'rgba(99,102,241,0.25)'}`,
          borderRadius: 14,
          padding: '32px 20px',
          textAlign: 'center',
          cursor: 'pointer',
          background: dragging ? `${agent.accent}10` : 'rgba(15,20,35,0.5)',
          transition: 'all 0.15s',
          marginBottom: 20,
          flexShrink: 0,
        }}>
        <input ref={inputRef} type="file" multiple accept=".txt,.md,.csv,.json,.html,.pdf" style={{ display: 'none' }} onChange={e => uploadFiles(e.target.files)} />
        <div style={{ fontSize: 32, marginBottom: 8 }}>{uploading ? '⏳' : '📂'}</div>
        <div style={{ color: 'white', fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
          {uploading ? 'Uploading…' : 'Drop files here or click to browse'}
        </div>
        <div style={{ color: 'rgba(148,163,184,0.4)', fontSize: 12 }}>TXT · MD · CSV · JSON · HTML · PDF · max 2MB each</div>
        {uploadMsg && (
          <div style={{ marginTop: 10, fontSize: 13, color: uploadMsg.ok ? '#10b981' : '#f43f5e', fontWeight: 600 }}>{uploadMsg.text}</div>
        )}
      </div>

      {/* Knowledge files list */}
      {files.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)', fontWeight: 600, letterSpacing: '0.06em', marginBottom: 10 }}>
            KNOWLEDGE BASE — {files.length} FILE{files.length !== 1 ? 'S' : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {files.map(f => (
              <motion.div key={f.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.1)', borderRadius: 10, padding: '10px 14px' }}>
                <span style={{ fontSize: 20, flexShrink: 0 }}>{FILE_ICON[f.file_type] || '📃'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: 'white', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.filename}</div>
                  <div style={{ color: 'rgba(148,163,184,0.4)', fontSize: 11 }}>{f.file_type} · {fmtSize(f.file_size)} · {new Date(f.created_at).toLocaleDateString()}</div>
                </div>
                <button onClick={() => remove(f.id)}
                  style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.3)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', borderRadius: 6 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f43f5e')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'rgba(148,163,184,0.3)')}>
                  <Trash2 size={14} />
                </button>
              </motion.div>
            ))}
          </div>
        </>
      )}

      {files.length === 0 && !uploading && (
        <div style={{ textAlign: 'center', color: 'rgba(148,163,184,0.25)', fontSize: 13, marginTop: 8 }}>
          No knowledge files yet. Upload something above to get started.
        </div>
      )}
    </div>
  )
}

// ── Task Thread View ───────────────────────────────────────────────────────

function TaskThreadView({ task, agent, onCancelled }: { task: Task; agent: Agent; onCancelled?: () => void }) {
  const resultPreview = (task.result || task.error || '').slice(0, 4000)
  const [refineMessages, setRefineMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [refineMessages, task])
  useEffect(() => { setRefineMessages([]); setInput('') }, [task.id])

  async function cancelTask() {
    if (cancelling) return
    setCancelling(true)
    try {
      await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'cancelled' }),
      })
      onCancelled?.()
    } catch { /* ignore */ } finally {
      setCancelling(false)
    }
  }

  async function send() {
    const text = input.trim()
    if (!text || loading) return
    const userMsg: Message = { role: 'user', content: text, ts: Date.now() }
    const updated = [...refineMessages, userMsg]
    setRefineMessages(updated)
    setInput('')
    setLoading(true)
    try {
      const systemContext = `You are ${agent.name}. The user wants to refine or iterate on a completed task.\n\nOriginal task: ${task.title}\nTask type: ${task.type}\nOriginal output:\n${resultPreview}\n\nRespond conversationally and helpfully. Produce full revised output when asked to rewrite. Do not dispatch new tasks.`
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: updated.map(m => ({ role: m.role, content: m.content })),
          systemOverride: systemContext,
        }),
      })
      const data = await res.json()
      setRefineMessages(m => [...m, { role: 'assistant', content: data.content || data.error || 'Something went wrong.', ts: Date.now() }])
    } catch (err: any) {
      setRefineMessages(m => [...m, { role: 'assistant', content: `⚠️ ${err.message}`, ts: Date.now() }])
    } finally {
      setLoading(false)
    }
  }

  const statusColor = task.status === 'completed' ? '#10b981' : task.status === 'failed' ? '#f43f5e' : task.status === 'running' ? '#a5b4fc' : '#94a3b8'
  const statusBg    = task.status === 'completed' ? 'rgba(16,185,129,0.12)' : task.status === 'failed' ? 'rgba(244,63,94,0.12)' : task.status === 'running' ? 'rgba(99,102,241,0.12)' : 'rgba(148,163,184,0.08)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Thread header */}
      <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid rgba(99,102,241,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'white', fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{task.title}</span>
          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: statusBg, color: statusColor, fontWeight: 600, flexShrink: 0 }}>{task.status}</span>
          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', flexShrink: 0 }}>{task.type}</span>
          {(task.status === 'running' || task.status === 'pending') && (
            <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={cancelTask} disabled={cancelling}
              style={{ padding: '2px 10px', borderRadius: 20, background: 'rgba(244,63,94,0.12)', border: '1px solid rgba(244,63,94,0.3)', color: '#f43f5e', fontSize: 10, fontWeight: 600, cursor: cancelling ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              {cancelling ? '…' : '✕ Cancel'}
            </motion.button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.3)' }}>{new Date(task.created_at).toLocaleString()}</span>
          {task.tokens_used > 0 && <TokenCost tokens={task.tokens_used} />}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {task.result && <CopyButton text={task.result} />}
            {task.result && (
              <button onClick={() => {
                const blob = new Blob([`# ${task.title}\n\n${task.result}`], { type: 'text/markdown' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url; a.download = `${task.title.slice(0,40).replace(/[^a-z0-9]/gi,'-')}.md`; a.click()
                URL.revokeObjectURL(url)
              }} title="Download as Markdown"
                style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.4)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                <Download size={12} /> Export
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Chat thread scroll area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Original task as "user" message */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: '14px 14px 4px 14px', background: `linear-gradient(135deg, ${agent.accent_dark}, ${agent.accent})`, color: 'white', fontSize: 13, lineHeight: 1.55 }}>
            {task.description || task.title}
          </div>
        </div>

        {/* Agent result as "assistant" message */}
        {(task.result || task.error || task.status === 'running' || task.status === 'pending') && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AgentAvatar agent={agent} size={28} />
            <div style={{ flex: 1, padding: '10px 14px', borderRadius: '4px 14px 14px 14px', background: 'rgba(15,20,35,0.85)', border: '1px solid rgba(99,102,241,0.12)', color: 'white', fontSize: 13, lineHeight: 1.55 }}>
              {task.status === 'running' && (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  {[0,1,2].map(i => <motion.div key={i} animate={{ opacity: [0.3,1,0.3] }} transition={{ repeat: Infinity, duration: 1.2, delay: i*0.2 }} style={{ width: 6, height: 6, borderRadius: '50%', background: agent.accent }} />)}
                  <span style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, marginLeft: 4 }}>Running…</span>
                </div>
              )}
              {task.status === 'pending' && <span style={{ color: 'rgba(148,163,184,0.4)', fontSize: 12 }}>Queued…</span>}
              {task.result && <Markdown text={task.result} />}
              {task.error && <span style={{ color: '#f43f5e' }}>{task.error}</span>}
            </div>
          </div>
        )}

        {/* Refine conversation thread */}
        {refineMessages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 10, alignItems: 'flex-start' }}>
            {m.role === 'assistant' && <AgentAvatar agent={agent} size={28} />}
            <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '4px 14px 14px 14px', background: m.role === 'user' ? `linear-gradient(135deg, ${agent.accent_dark}, ${agent.accent})` : 'rgba(15,20,35,0.85)', border: m.role === 'assistant' ? '1px solid rgba(99,102,241,0.12)' : 'none', color: 'white', fontSize: 13, lineHeight: 1.55 }}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AgentAvatar agent={agent} size={28} />
            <div style={{ padding: '10px 14px', borderRadius: '4px 14px 14px 14px', background: 'rgba(15,20,35,0.85)', border: '1px solid rgba(99,102,241,0.12)', display: 'flex', gap: 5 }}>
              {[0,1,2].map(i => <motion.div key={i} animate={{ opacity: [0.3,1,0.3] }} transition={{ repeat: Infinity, duration: 1.2, delay: i*0.2 }} style={{ width: 6, height: 6, borderRadius: '50%', background: agent.accent }} />)}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Reply input — only shown when task is done */}
      {(task.status === 'completed' || task.status === 'failed') && (
        <div style={{ padding: '10px 16px 16px', borderTop: '1px solid rgba(99,102,241,0.1)', display: 'flex', gap: 8, flexShrink: 0 }}>
          <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder={`Ask ${agent.name} to refine, rewrite, or continue…`}
            style={{ flex: 1, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.22)', borderRadius: 10, padding: '9px 14px', color: 'white', fontSize: 13, outline: 'none' }} />
          <motion.button whileTap={{ scale: 0.9 }} onClick={send} disabled={loading}
            style={{ width: 38, height: 38, borderRadius: 10, background: `linear-gradient(135deg,${agent.accent_dark},${agent.accent})`, border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: loading ? 0.5 : 1 }}>
            <Send size={15} />
          </motion.button>
        </div>
      )}
    </div>
  )
}

// ── Copy button helper ─────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      title="Copy to clipboard"
      style={{ background: 'none', border: 'none', color: copied ? '#10b981' : 'rgba(148,163,184,0.4)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
      {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
    </button>
  )
}

// ── Task cost helper ───────────────────────────────────────────────────────

function TokenCost({ tokens }: { tokens: number }) {
  // gpt-4o-mini: ~$0.15/1M input + $0.60/1M output, rough avg $0.0004/1k
  const cost = (tokens / 1000 * 0.0004)
  const display = cost < 0.01 ? `<$0.01` : `$${cost.toFixed(3)}`
  return <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.35)' }}>{tokens.toLocaleString()} tokens · {display}</span>
}

// ── Agent prompt editor (in Train tab) ────────────────────────────────────

function AgentPromptEditor({ agent }: { agent: Agent }) {
  const defaultPrompts: Record<string, string> = {
    research:  'You are a Research Agent specialising in web research, data gathering, and summarisation. Be thorough, cite sources, and present findings clearly.',
    code:      'You are a Code Engineer. Write clean, well-commented, production-ready code. Explain your approach briefly before the code.',
    data:      'You are a Data Analyst. Provide structured analysis, highlight key trends, and present actionable insights.',
    writer:    'You are a Content Writer. Write engaging, SEO-friendly content that is clear, compelling, and tailored to the audience.',
    email:     'You are an Email Manager. Write professional, concise emails with clear subject lines and calls to action.',
    security:  'You are a Security Analyst. Identify vulnerabilities, assess risk levels, and provide concrete remediation steps.',
  }
  const [prompt, setPrompt] = useState(defaultPrompts[agent.id] || '')
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)

  // Load from server on mount
  useEffect(() => {
    fetch(`/api/agents/${agent.id}/prompt`)
      .then(r => r.json())
      .then(d => {
        if (d.prompt) setPrompt(d.prompt)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [agent.id])

  async function save() {
    await fetch(`/api/agents/${agent.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function reset() {
    const def = defaultPrompts[agent.id] || ''
    setPrompt(def)
    await fetch(`/api/agents/${agent.id}/prompt`, { method: 'DELETE' })
  }

  return (
    <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(99,102,241,0.1)', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Cpu size={14} color="#a5b4fc" />
        <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>System Prompt</span>
        <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)' }}>— shapes how this agent thinks</span>
      </div>
      <textarea value={loading ? 'Loading…' : prompt} onChange={e => setPrompt(e.target.value)} rows={5} disabled={loading}
        style={{ width: '100%', background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 10, padding: '10px 12px', color: loading ? 'rgba(148,163,184,0.4)' : 'white', fontSize: 12, outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.6 }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={save}
          style={{ padding: '6px 16px', background: saved ? 'rgba(16,185,129,0.15)' : `linear-gradient(135deg,${agent.accent_dark},${agent.accent})`, border: saved ? '1px solid rgba(16,185,129,0.3)' : 'none', borderRadius: 7, color: saved ? '#10b981' : 'white', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          {saved ? '✓ Saved' : 'Save Prompt'}
        </motion.button>
        <button onClick={reset} style={{ padding: '6px 12px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 7, color: 'rgba(148,163,184,0.5)', fontSize: 12, cursor: 'pointer' }}>Reset</button>
      </div>
      <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, margin: '8px 0 0' }}>Saved to server — active immediately on next task.</p>
    </div>
  )
}

// ── Quick task templates ───────────────────────────────────────────────────

const AGENT_TEMPLATES: Record<string, { label: string; description: string; type: string }[]> = {
  research:  [
    { label: '🔍 Research topic',    description: 'Research [topic] and summarise the top findings, key players, and recent developments.', type: 'search' },
    { label: '📰 News digest',        description: 'Find the latest news about [topic] from the past 7 days and summarise the top 5 stories.', type: 'search' },
    { label: '🌐 Scrape & summarise', description: 'Navigate to [URL] and extract the key information from the page.', type: 'browser' },
  ],
  writer:    [
    { label: '✍️ Blog post',          description: 'Write a 500-word SEO-friendly blog post about [topic] targeting [audience].', type: 'general' },
    { label: '📧 Email draft',        description: 'Write a professional email to [recipient] about [subject]. Tone: [tone].', type: 'general' },
    { label: '📱 Social post',        description: 'Write 3 variations of a social media post about [topic] for LinkedIn.', type: 'general' },
  ],
  code:      [
    { label: '⚡ Write script',       description: 'Write a Python script that [description]. Include error handling and comments.', type: 'code' },
    { label: '🐛 Debug code',         description: 'Debug this code and explain the issues:\n\n[paste code here]', type: 'general' },
    { label: '📝 Code review',        description: 'Review this code for bugs, security issues, and improvements:\n\n[paste code here]', type: 'general' },
  ],
  data:      [
    { label: '📊 Analyse data',       description: 'Analyse this dataset and provide key insights, trends, and anomalies:\n\n[paste data here]', type: 'general' },
    { label: '🗄️ Write SQL',          description: 'Write a SQL query to [description] from a table with columns: [columns].', type: 'general' },
    { label: '📈 Visualisation plan', description: 'Suggest the best charts and visualisations for this data and explain why:\n\n[describe data]', type: 'general' },
  ],
  security:  [
    { label: '🔒 Scan server',        description: 'Run a security scan on localhost and report vulnerabilities and recommendations.', type: 'security' },
    { label: '🛡️ Audit review',       description: 'Review these server logs for suspicious activity and security threats:\n\n[paste logs]', type: 'general' },
  ],
  email:     [
    { label: '📥 Draft reply',        description: 'Draft a professional reply to this email:\n\n[paste email here]', type: 'general' },
    { label: '📢 Newsletter',         description: 'Write a monthly newsletter email about [topic] for [audience].', type: 'general' },
  ],
}

// ── Agent Detail ───────────────────────────────────────────────────────────

function AgentDetailView({ agent, onBack, onRunTask }: { agent: Agent; onBack: () => void; onRunTask: (a: Agent, prefill?: Partial<{ title: string; description: string; type: string }>) => void }) {
  const [tasks, setTasks] = useState<Task[]>(agent.tasks || [])
  // BUG FIX: track by ID only — never overwritten by polls
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [tab, setTab] = useState<'tasks' | 'train'>('tasks')

  // Derive selected task from ID — always current data, never stale
  const selectedTask = tasks.find(t => t.id === selectedTaskId) ?? null

  async function refresh() {
    setLoadingTasks(true)
    const res = await fetch(`/api/agents/${agent.id}`)
    if (res.ok) {
      const d = await res.json()
      setTasks(d.tasks || [])
      // Do NOT touch selectedTaskId — user's selection is preserved
    }
    setLoadingTasks(false)
  }

  useEffect(() => { refresh() }, [agent.id])

  // Auto-poll while any task is running
  useEffect(() => {
    const running = tasks.some(t => t.status === 'running' || t.status === 'pending')
    if (!running) return
    const id = setInterval(refresh, 3000)
    return () => clearInterval(id)
  }, [tasks])

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* ── Left sidebar: task list ── */}
      <div style={{ width: 260, flexShrink: 0, borderRight: '1px solid rgba(99,102,241,0.1)', display: 'flex', flexDirection: 'column', background: 'rgba(8,12,20,0.6)', overflow: 'hidden' }}>

        {/* Agent header */}
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid rgba(99,102,241,0.1)', flexShrink: 0 }}>
          <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 12, padding: 0, marginBottom: 12 }}>
            <ChevronLeft size={13} /> All Agents
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AgentAvatar agent={agent} size={34} pulse />
            <div>
              <div style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>{agent.name}</div>
              <div style={{ color: STATUS_COLOR[agent.status], fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>{STATUS_ICON[agent.status]}{agent.status}</div>
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div style={{ display: 'flex', padding: '10px 14px', gap: 16, borderBottom: '1px solid rgba(99,102,241,0.08)', flexShrink: 0 }}>
          <div><div style={{ fontSize: 9, color: 'rgba(148,163,184,0.4)', marginBottom: 2 }}>TOKENS</div><div style={{ fontSize: 13, fontWeight: 600, color: agent.accent }}>{fmt(agent.tokens_used)}</div></div>
          <div><div style={{ fontSize: 9, color: 'rgba(148,163,184,0.4)', marginBottom: 2 }}>TASKS</div><div style={{ fontSize: 13, fontWeight: 600, color: 'white' }}>{agent.tasks_completed}</div></div>
          <div><div style={{ fontSize: 9, color: 'rgba(148,163,184,0.4)', marginBottom: 2 }}>UPTIME</div><div style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8' }}>{fmtUptime(agent.uptime_seconds)}</div></div>
        </div>

        {/* Tab switcher */}
        <div style={{ display: 'flex', padding: '8px 10px 0', gap: 4, flexShrink: 0 }}>
          {(['tasks', 'train'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{ flex: 1, padding: '6px 0', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, background: tab === t ? `${agent.accent}25` : 'transparent', color: tab === t ? agent.accent : 'rgba(148,163,184,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, transition: 'all 0.12s' }}>
              {t === 'tasks' ? <><ListTodo size={11} /> Tasks</> : <><BookOpen size={11} /> Train</>}
            </button>
          ))}
        </div>

        {tab === 'tasks' && (
          <>
            {/* New task button */}
            <div style={{ padding: '8px 10px 4px', flexShrink: 0 }}>
              <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={() => onRunTask(agent)}
                style={{ width: '100%', background: `linear-gradient(135deg, ${agent.accent_dark}, ${agent.accent})`, border: 'none', borderRadius: 8, padding: '8px 0', color: 'white', fontWeight: 600, fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Play size={12} /> New Task
              </motion.button>
            </div>

            {/* Refresh */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 14px 4px', flexShrink: 0 }}>
              <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.35)', fontWeight: 600, letterSpacing: '0.06em' }}>HISTORY</span>
              <button onClick={refresh} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.3)', cursor: 'pointer', padding: 2, display: 'flex' }}>
                <RefreshCw size={11} style={{ animation: loadingTasks ? 'spin 1s linear infinite' : 'none' }} />
              </button>
            </div>

            {/* Task list — selectedTaskId never changed by polls */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {tasks.length === 0 && (
                <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, padding: '16px 14px', margin: 0 }}>No tasks yet.</p>
              )}
              {tasks.map(t => {
                const isSelected = selectedTaskId === t.id
                const dot = t.status === 'completed' ? '#10b981' : t.status === 'failed' ? '#f43f5e' : t.status === 'running' ? agent.accent : '#94a3b8'
                return (
                  <div key={t.id} onClick={() => setSelectedTaskId(t.id)}
                    style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid rgba(99,102,241,0.06)', background: isSelected ? `${agent.accent}18` : 'transparent', borderLeft: isSelected ? `2px solid ${agent.accent}` : '2px solid transparent', transition: 'background 0.1s' }}
                    onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'rgba(99,102,241,0.06)' }}
                    onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0, marginTop: 4,
                        boxShadow: t.status === 'running' ? `0 0 6px ${agent.accent}` : 'none' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: isSelected ? 'white' : 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: isSelected ? 600 : 400, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.45 }}>{t.title}</div>
                        <div style={{ color: 'rgba(148,163,184,0.3)', fontSize: 10, marginTop: 3 }}>{new Date(t.created_at).toLocaleDateString()} · {t.type}</div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {tab === 'train' && (
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <TrainSidebarStrip agent={agent} />
          </div>
        )}
      </div>

      {/* ── Right panel ── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {tab === 'train' ? (
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            <TrainPanel agent={agent} />
            <AgentPromptEditor agent={agent} />
          </div>
        ) : selectedTask ? (
          <TaskThreadView key={selectedTaskId!} task={selectedTask} agent={agent} onCancelled={refresh} />
        ) : (
          /* Empty state — show quick templates */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            <div style={{ textAlign: 'center', marginBottom: 28 }}>
              <div style={{ width: 52, height: 52, borderRadius: '50%', background: `${agent.accent}18`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, margin: '0 auto 12px' }}>⬡</div>
              <p style={{ margin: 0, fontSize: 14, color: 'rgba(148,163,184,0.6)', fontWeight: 600 }}>Select a task or start a new one</p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'rgba(148,163,184,0.3)' }}>Quick start with a template below</p>
            </div>
            {(AGENT_TEMPLATES[agent.id] || AGENT_TEMPLATES.research).map((tpl, i) => (
              <motion.div key={i} whileHover={{ x: 3 }} onClick={() => onRunTask(agent, tpl)}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px', marginBottom: 8, background: 'rgba(15,20,35,0.6)', border: `1px solid rgba(99,102,241,0.1)`, borderRadius: 10, cursor: 'pointer', transition: 'border-color 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.borderColor = `${agent.accent}44`)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = 'rgba(99,102,241,0.1)')}>
                <Layers size={14} color={agent.accent} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ color: 'white', fontSize: 13, fontWeight: 500 }}>{tpl.label}</div>
                  <div style={{ color: 'rgba(148,163,184,0.4)', fontSize: 11, marginTop: 2 }}>{tpl.type} task</div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Run Task Modal ─────────────────────────────────────────────────────────

function RunTaskModal({ agent, onClose, onSubmit, prefill }: { agent: Agent; onClose: () => void; onSubmit: (d: any) => void; prefill?: Partial<{ title: string; description: string; type: string }> }) {
  const [title, setTitle] = useState(prefill?.title || '')
  const [description, setDescription] = useState(prefill?.description || '')
  const [type, setType] = useState(prefill?.type || 'general')
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
              {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
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
  const [toasts, setToasts]           = useState<Toast[]>([])
  const [showSearch, setShowSearch]   = useState(false)
  const toastId = useRef(0)

  function addToast(message: string, type: Toast['type'] = 'info') {
    const id = ++toastId.current
    setToasts(t => [...t, { id, message, type }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4000)
  }
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowSearch(s => !s) }
      if (e.key === 'Escape') setShowSearch(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        if (data.toolsUsed?.length) addToast('Action completed: ' + data.toolsUsed.join(', '), 'success')
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
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (res.ok) addToast('Task dispatched: ' + data.title, 'success')
    else addToast('Failed to dispatch task', 'error')
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

      <Sidebar view={view} setView={v => { setView(v); setSelectedAgent(null) }} agents={agents} onLogout={handleLogout} onSearch={() => setShowSearch(true)} />

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
      <AnimatePresence>
        {showSearch && <GlobalSearch onClose={() => setShowSearch(false)} onNavigate={(v, id) => { setView(v); setSelectedAgent(null) }} />}
      </AnimatePresence>
      <ToastContainer toasts={toasts} remove={id => setToasts(t => t.filter(x => x.id !== id))} />
    </div>
  )
}
