'use client'
import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Bot, ListTodo, Terminal as TerminalIcon,
  Settings, Send, ChevronLeft, Play, RefreshCw, LogOut,
  AlertCircle, CheckCircle, Clock, Zap, Activity, X, Search, Bell,
  BookOpen, Trash2, Download, Cpu, SlidersHorizontal, Layers, Copy, Check, Plus, Globe, TestTube,
  BarChart2, GitBranch, Key,
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
  { id: 'dashboard',  icon: <LayoutDashboard size={18} />, label: 'Dashboard'  },
  { id: 'agents',     icon: <Bot size={18} />,             label: 'Agents'     },
  { id: 'tasks',      icon: <ListTodo size={18} />,        label: 'Tasks'      },
  { id: 'pipelines',  icon: <GitBranch size={18} />,       label: 'Pipelines'  },
  { id: 'analytics',  icon: <BarChart2 size={18} />,       label: 'Analytics'  },
  { id: 'projects',   icon: <Layers size={18} />,           label: 'Projects'   },
  { id: 'triggers',   icon: <Zap size={18} />,              label: 'Triggers'   },
  { id: 'skills',     icon: <Cpu size={18} />,              label: 'Skills'     },
  { id: 'terminal',   icon: <TerminalIcon size={18} />,    label: 'Terminal'   },
  { id: 'schedules',  icon: <Clock size={18} />,           label: 'Schedules'  },
  { id: 'hermes',    icon: <span style={{fontSize:16}}>⚡</span>, label: 'Hermes'    },
  { id: 'email-health', icon: <span style={{fontSize:14}}>📧</span>, label: 'Email Health' },
  { id: 'mcd-reports', icon: <span style={{fontSize:14}}>📊</span>, label: 'MCD Reports' },
  { id: 'ghl-monitor', icon: <span style={{fontSize:14}}>🔍</span>, label: 'GHL Monitor' },
  { id: 'settings',   icon: <Settings size={18} />,        label: 'Settings'   },
]

function Sidebar({ view, setView, agents, onLogout, onSearch }: { view: string; setView: (v: string) => void; agents: Agent[]; onLogout: () => void; onSearch: () => void }) {
  return (
    <div style={{ width: 64, flexShrink: 0, background: 'rgba(8,12,20,0.95)', borderRight: '1px solid rgba(99,102,241,0.12)', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 20, paddingBottom: 16, gap: 4, zIndex: 50 }}>
      <div style={{ width: 44, height: 44, borderRadius: 12, overflow: 'hidden', marginBottom: 20, flexShrink: 0, boxShadow: '0 0 20px rgba(99,102,241,0.3)' }}>
        <img src="/phr-logo.png" alt="PHR OS" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
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

// Persist refine messages across task switches — keyed by task ID
const refineMsgCache = new Map<number, Message[]>()

function TaskThreadView({ task, agent, onCancelled }: { task: Task; agent: Agent; onCancelled?: () => void }) {
  const [streamedResult, setStreamedResult] = useState<string>(task.result || '')
  const [streamStatus, setStreamStatus] = useState<string>(task.status)
  const liveResult = streamedResult || task.result || ''
  const liveStatus = streamStatus || task.status
  const resultPreview = liveResult.slice(0, 4000)
  const [refineMessages, setRefineMessages] = useState<Message[]>(() => refineMsgCache.get(task.id) || [])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const taskIdRef = useRef(task.id)
  const esRef = useRef<EventSource | null>(null)

  // SSE subscription — connects when task is running/pending, streams result in real time
  useEffect(() => {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      setStreamedResult(task.result || '')
      setStreamStatus(task.status)
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      return
    }
    if (task.status !== 'running' && task.status !== 'pending') return
    if (esRef.current) return
    const es = new EventSource(`/api/tasks/${task.id}/stream`)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.type === 'task' && data.task) {
          if (data.task.result) setStreamedResult(data.task.result)
          setStreamStatus(data.task.status)
        }
        if (data.type === 'done') {
          setStreamStatus(data.status)
          es.close(); esRef.current = null
          onCancelled?.()
        }
      } catch {}
    }
    es.onerror = () => { es.close(); esRef.current = null }
    return () => { es.close(); esRef.current = null }
  }, [task.id, task.status])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [refineMessages, liveResult])

  // Only reset messages when task ID genuinely changes (not on re-renders with same task)
  useEffect(() => {
    if (taskIdRef.current !== task.id) {
      taskIdRef.current = task.id
      const cached = refineMsgCache.get(task.id) || []
      setRefineMessages(cached)
      setInput('')
    }
  }, [task.id])

  // Persist messages to cache whenever they change
  useEffect(() => {
    refineMsgCache.set(task.id, refineMessages)
  }, [refineMessages, task.id])

  const [compacting, setCompacting] = useState(false)

  async function compact() {
    if (compacting || refineMessages.length < 2) return
    setCompacting(true)
    try {
      const history = refineMessages.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`).join('\n\n')
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: `Summarise this conversation in 2-3 sentences, preserving all key decisions, outputs, and context:

${history}` }],
          systemOverride: 'You are a conversation summariser. Produce a dense, factual summary that captures all important context. Start with "Summary of previous conversation:"',
        }),
      })
      const data = await res.json()
      const summary: Message = { role: 'assistant', content: data.content, ts: Date.now() }
      setRefineMessages([summary])
    } catch {}
    setCompacting(false)
  }

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
    // Use functional update to always work off latest state — avoids stale closure
    let currentMessages: Message[] = []
    setRefineMessages(prev => {
      currentMessages = [...prev, userMsg]
      return currentMessages
    })
    setInput('')
    setLoading(true)
    // Small delay to ensure state update has flushed
    await new Promise(r => setTimeout(r, 0))
    try {
      const systemContext = `You are ${agent.name}. The user wants to refine or iterate on a completed task.\n\nOriginal task: ${task.title}\nTask type: ${task.type}\nOriginal output:\n${resultPreview}\n\nRespond conversationally and helpfully. Produce full revised output when asked to rewrite. Do not dispatch new tasks.`
      // Get latest messages from cache for the API call
      const latestMessages = refineMsgCache.get(task.id) || currentMessages
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: latestMessages.map(m => ({ role: m.role, content: m.content })),
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

  const statusColor = liveStatus === 'completed' ? '#10b981' : liveStatus === 'failed' ? '#f43f5e' : liveStatus === 'running' ? '#a5b4fc' : '#94a3b8'
  const statusBg    = liveStatus === 'completed' ? 'rgba(16,185,129,0.12)' : liveStatus === 'failed' ? 'rgba(244,63,94,0.12)' : liveStatus === 'running' ? 'rgba(99,102,241,0.12)' : 'rgba(148,163,184,0.08)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Thread header */}
      <div style={{ padding: '14px 20px 10px', borderBottom: '1px solid rgba(99,102,241,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ color: 'white', fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>{task.title}</span>
          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: statusBg, color: statusColor, fontWeight: 600, flexShrink: 0 }}>{liveStatus}</span>
          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 20, background: 'rgba(99,102,241,0.1)', color: '#a5b4fc', flexShrink: 0 }}>{task.type}</span>
          {(liveStatus === 'running' || liveStatus === 'pending') && (
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
            <AddToProjectButton taskId={task.id} />
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
        {(liveResult || task.error || liveStatus === 'running' || liveStatus === 'pending') && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AgentAvatar agent={agent} size={28} />
            <div style={{ flex: 1, padding: '10px 14px', borderRadius: '4px 14px 14px 14px', background: 'rgba(15,20,35,0.85)', border: '1px solid rgba(99,102,241,0.12)', color: 'white', fontSize: 13, lineHeight: 1.55 }}>
              {liveStatus === 'running' && (
                <div>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: liveResult ? 8 : 0 }}>
                    {[0,1,2].map(i => <motion.div key={i} animate={{ opacity: [0.3,1,0.3] }} transition={{ repeat: Infinity, duration: 1.2, delay: i*0.2 }} style={{ width: 6, height: 6, borderRadius: '50%', background: agent.accent }} />)}
                    <span style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, marginLeft: 4 }}>{liveResult ? 'Writing…' : 'Starting…'}</span>
                  </div>
                  {liveResult && <Markdown text={liveResult} />}
                </div>
              )}
              {liveStatus === 'pending' && <span style={{ color: 'rgba(148,163,184,0.4)', fontSize: 12 }}>Queued…</span>}
              {(liveStatus === 'completed' || liveStatus === 'failed' || liveStatus === 'cancelled') && liveResult && <Markdown text={liveResult} />}
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
      {refineMessages.length >= 4 && (liveStatus === 'completed' || liveStatus === 'failed') && (
        <div style={{ padding: '4px 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={compact} disabled={compacting}
            style={{ fontSize: 10, color: 'rgba(148,163,184,0.35)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}>
            {compacting ? '…' : '⬡ Compact conversation'}
          </button>
        </div>
      )}
      {(liveStatus === 'completed' || liveStatus === 'failed') && (
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

function AddToProjectButton({ taskId }: { taskId: number }) {
  const [projects, setProjects] = useState<any[]>([])
  const [open, setOpen] = useState(false)
  const [added, setAdded] = useState<number | null>(null)

  async function load() {
    const r = await fetch('/api/projects')
    if (r.ok) setProjects(await r.json())
  }

  async function add(projectId: number, projectName: string) {
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add_task', project_id: projectId, task_id: taskId }),
    })
    setAdded(projectId)
    setOpen(false)
    setTimeout(() => setAdded(null), 2000)
  }

  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => { setOpen(o => !o); load() }} title="Add to project"
        style={{ background: 'none', border: 'none', color: added ? '#10b981' : 'rgba(148,163,184,0.4)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
        <Layers size={12} /> {added ? 'Added ✓' : 'Project'}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, background: '#0f1623', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 10, minWidth: 180, zIndex: 50, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
          {projects.length === 0
            ? <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 12, padding: '10px 14px', margin: 0 }}>No projects yet</p>
            : projects.map((p: any) => (
              <button key={p.id} onClick={() => add(p.id, p.name)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 14px', background: 'none', border: 'none', color: 'white', fontSize: 12, cursor: 'pointer', borderBottom: '1px solid rgba(99,102,241,0.07)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(99,102,241,0.08)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}>
                {p.name}
              </button>
            ))
          }
        </div>
      )}
    </div>
  )
}

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

// ── Agent integrations ────────────────────────────────────────────────────

interface AgentIntegration {
  id: number; agent_id: string; name: string
  type: string; description: string; config: string; enabled: number; created_at: string
}

const INTEGRATION_ICONS: Record<string, string> = {
  webhook: '🔗', n8n: '⚡', ghl_read: '📥', ghl_write: '📤',
  google_sheets: '📊', google_docs: '📝', browser: '🌐',
}

const INTEGRATION_LABELS: Record<string, string> = {
  webhook: 'Webhook', n8n: 'N8N Workflow', ghl_read: 'GHL Read',
  ghl_write: 'GHL Write', google_sheets: 'Google Sheets', google_docs: 'Google Docs', browser: 'Browser',
}

const INTEGRATION_FIELDS: Record<string, { key: string; label: string; placeholder: string; secret?: boolean }[]> = {
  webhook: [
    { key: 'url', label: 'Webhook URL', placeholder: 'https://...' },
    { key: 'method', label: 'Method', placeholder: 'POST' },
    { key: 'apiKey', label: 'API Key (optional)', placeholder: 'Bearer token', secret: true },
    { key: 'bodyTemplate', label: 'Body Template JSON (optional)', placeholder: '{"key":"value"}' },
  ],
  n8n: [
    { key: 'url', label: 'N8N Webhook URL', placeholder: 'https://your-n8n.com/webhook/...' },
    { key: 'method', label: 'Method', placeholder: 'POST' },
    { key: 'apiKey', label: 'API Key (optional)', placeholder: '', secret: true },
  ],
  ghl_read: [
    { key: 'apiKey', label: 'GHL API Key', placeholder: 'eyJhbGci...', secret: true },
    { key: 'locationId', label: 'Location ID', placeholder: 'abc123...' },
    { key: 'resource', label: 'Resource', placeholder: 'contacts | opportunities | pipelines | conversations' },
    { key: 'limit', label: 'Limit', placeholder: '20' },
  ],
  ghl_write: [
    { key: 'apiKey', label: 'GHL API Key', placeholder: 'eyJhbGci...', secret: true },
    { key: 'locationId', label: 'Location ID', placeholder: 'abc123...' },
    { key: 'action', label: 'Action', placeholder: 'create_contact | add_note | create_opportunity' },
  ],
  google_sheets: [
    { key: 'spreadsheetId', label: 'Spreadsheet ID', placeholder: '1BxiM...' },
    { key: 'range', label: 'Range', placeholder: 'Sheet1!A1:Z100' },
    { key: 'action', label: 'Action', placeholder: 'read | write' },
    { key: 'serviceAccountJson', label: 'Service Account JSON', placeholder: '{"type":"service_account",...}', secret: true },
  ],
  google_docs: [
    { key: 'documentId', label: 'Document ID', placeholder: '1BxiM...' },
    { key: 'action', label: 'Action', placeholder: 'read | append' },
    { key: 'serviceAccountJson', label: 'Service Account JSON', placeholder: '{"type":"service_account",...}', secret: true },
  ],
  browser: [
    { key: 'url', label: 'Target URL', placeholder: 'https://...' },
  ],
  obsidian: [
    { key: 'apiUrl', label: 'REST API URL (if using plugin)', placeholder: 'http://your-tunnel.ngrok.io' },
    { key: 'apiKey', label: 'API Key (from REST API plugin)', placeholder: '', secret: true },
    { key: 'vaultPath', label: 'Vault Path on VPS (if git-synced)', placeholder: '/root/my-vault' },
    { key: 'action', label: 'Default Action', placeholder: 'search | read | write | append | list' },
  ],
}

function IntegrationsPanel({ agent }: { agent: Agent }) {
  const [integrations, setIntegrations] = useState<AgentIntegration[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [testing, setTesting] = useState<number | null>(null)
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; msg: string } | null>(null)

  useEffect(() => { load() }, [agent.id])

  async function load() {
    const res = await fetch(`/api/agents/${agent.id}/integrations`)
    if (res.ok) setIntegrations(await res.json())
  }

  async function toggle(integ: AgentIntegration) {
    await fetch(`/api/agents/${agent.id}/integrations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: integ.id, enabled: integ.enabled ? 0 : 1 }),
    })
    load()
  }

  async function remove(id: number) {
    await fetch(`/api/agents/${agent.id}/integrations?integration_id=${id}`, { method: 'DELETE' })
    load()
  }

  async function test(integ: AgentIntegration) {
    setTesting(integ.id)
    setTestResult(null)
    try {
      const res = await fetch(`/api/agents/${agent.id}/integrations/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: integ.type, config: integ.config, payload: {} }),
      })
      const data = await res.json()
      setTestResult({ id: integ.id, ok: data.ok, msg: data.ok ? (data.result || 'OK').slice(0, 200) : (data.error || 'Failed') })
    } catch (e: any) {
      setTestResult({ id: integ.id, ok: false, msg: e.message })
    } finally { setTesting(null) }
  }

  return (
    <div style={{ padding: '16px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Zap size={14} color="#a5b4fc" />
          <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>Integrations</span>
          <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)' }}>— external tools this agent can call</span>
        </div>
        <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => setShowAdd(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: `linear-gradient(135deg,${agent.accent_dark},${agent.accent})`, border: 'none', borderRadius: 7, color: 'white', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
          <Plus size={11} /> Add
        </motion.button>
      </div>

      {integrations.length === 0 && (
        <div style={{ textAlign: 'center', padding: '24px 0', color: 'rgba(148,163,184,0.3)', fontSize: 12 }}>
          No integrations yet. Add GHL, N8N, webhooks, Google services and more.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {integrations.map(integ => (
          <div key={integ.id} style={{ background: 'rgba(99,102,241,0.05)', border: `1px solid ${integ.enabled ? 'rgba(99,102,241,0.2)' : 'rgba(148,163,184,0.08)'}`, borderRadius: 10, padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>{INTEGRATION_ICONS[integ.type] || '🔌'}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>{integ.name}</span>
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 10, background: 'rgba(99,102,241,0.15)', color: '#a5b4fc' }}>{INTEGRATION_LABELS[integ.type] || integ.type}</span>
                  {!integ.enabled && <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)' }}>disabled</span>}
                </div>
                <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 11, margin: '2px 0 0' }}>{integ.description}</p>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                <button onClick={() => test(integ)} disabled={testing === integ.id}
                  style={{ padding: '3px 8px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, color: '#a5b4fc', fontSize: 10, cursor: 'pointer' }}>
                  {testing === integ.id ? '…' : '▶ Test'}
                </button>
                <button onClick={() => toggle(integ)}
                  style={{ padding: '3px 8px', background: integ.enabled ? 'rgba(16,185,129,0.1)' : 'rgba(148,163,184,0.08)', border: `1px solid ${integ.enabled ? 'rgba(16,185,129,0.3)' : 'rgba(148,163,184,0.15)'}`, borderRadius: 6, color: integ.enabled ? '#10b981' : 'rgba(148,163,184,0.4)', fontSize: 10, cursor: 'pointer' }}>
                  {integ.enabled ? 'On' : 'Off'}
                </button>
                <button onClick={() => remove(integ.id)}
                  style={{ padding: '3px 6px', background: 'transparent', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}>
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
            {testResult?.id === integ.id && (
              <div style={{ marginTop: 8, padding: '6px 10px', borderRadius: 6, background: testResult.ok ? 'rgba(16,185,129,0.08)' : 'rgba(244,63,94,0.08)', border: `1px solid ${testResult.ok ? 'rgba(16,185,129,0.2)' : 'rgba(244,63,94,0.2)'}`, color: testResult.ok ? '#10b981' : '#f43f5e', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
              </div>
            )}
          </div>
        ))}
      </div>

      {showAdd && <AddIntegrationModal agent={agent} onClose={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddIntegrationModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [type, setType] = useState('webhook')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const fieldDefs = INTEGRATION_FIELDS[type] || []

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await fetch(`/api/agents/${agent.id}/integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, description, config: fields }),
    })
    setSaving(false)
    onClose()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 500, maxHeight: '85vh', overflowY: 'auto', background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Add Integration</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ color: 'rgba(148,163,184,0.7)', fontSize: 11, marginBottom: 4, display: 'block' }}>TYPE</label>
            <select value={type} onChange={e => { setType(e.target.value); setFields({}) }}
              style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 13, outline: 'none' }}>
              {Object.entries(INTEGRATION_LABELS).map(([k, v]) => (
                <option key={k} value={k} style={{ background: '#0f1623' }}>{INTEGRATION_ICONS[k]} {v}</option>
              ))}
            </select>
          </div>

          <div>
            <label style={{ color: 'rgba(148,163,184,0.7)', fontSize: 11, marginBottom: 4, display: 'block' }}>NAME (what the agent calls it)</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Get GHL Contacts"
              style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          </div>

          <div>
            <label style={{ color: 'rgba(148,163,184,0.7)', fontSize: 11, marginBottom: 4, display: 'block' }}>DESCRIPTION (tell the agent when to use it)</label>
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Fetch recent contacts from GoHighLevel CRM"
              style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
          </div>

          {fieldDefs.map(fd => (
            <div key={fd.key}>
              <label style={{ color: 'rgba(148,163,184,0.7)', fontSize: 11, marginBottom: 4, display: 'block' }}>{fd.label.toUpperCase()}</label>
              <input
                type={fd.secret ? 'password' : 'text'}
                value={fields[fd.key] || ''} onChange={e => setFields(f => ({ ...f, [fd.key]: e.target.value }))}
                placeholder={fd.placeholder}
                style={{ width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', boxSizing: 'border-box', fontFamily: fd.key.includes('Json') ? 'monospace' : 'inherit' }} />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={save} disabled={saving || !name.trim()}
            style={{ flex: 1, padding: '9px', background: `linear-gradient(135deg,${agent.accent_dark},${agent.accent})`, border: 'none', borderRadius: 9, color: 'white', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !name.trim() ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Save Integration'}
          </motion.button>
          <button onClick={onClose} style={{ padding: '9px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </motion.div>
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

function AgentDetailView({ agent, onBack, onRunTask, onDelete, newTaskId, onNewTaskConsumed }: { agent: Agent; onBack: () => void; onRunTask: (a: Agent, prefill?: Partial<{ title: string; description: string; type: string }>) => void; onDelete?: (id: string) => void; newTaskId?: number | null; onNewTaskConsumed?: () => void }) {
  const [tasks, setTasks] = useState<Task[]>(agent.tasks || [])
  // BUG FIX: track by ID only — never overwritten by polls
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null)
  const [loadingTasks, setLoadingTasks] = useState(false)
  const [tab, setTab] = useState<'tasks' | 'train' | 'integrations'>('tasks')

  // Derive selected task from ID — always current data, never stale
  const selectedTask = tasks.find(t => t.id === selectedTaskId) ?? null

  async function refresh() {
    setLoadingTasks(true)
    const res = await fetch(`/api/agents/${agent.id}`)
    if (res.ok) {
      const d = await res.json()
      setTasks(d.tasks || [])
    }
    setLoadingTasks(false)
  }

  useEffect(() => { refresh() }, [agent.id])

  // Auto-select newly dispatched task so SSE connects before task completes
  useEffect(() => {
    if (!newTaskId) return
    setSelectedTaskId(newTaskId)
    // Refresh task list to include the new task, then clear the signal
    refresh().then(() => onNewTaskConsumed?.())
  }, [newTaskId])

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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 12, padding: 0 }}>
              <ChevronLeft size={13} /> All Agents
            </button>
            {onDelete && (
              <button onClick={async () => {
                if (!confirm(`Delete ${agent.name}? This cannot be undone.`)) return
                await fetch(`/api/agents?id=${agent.id}`, { method: 'DELETE' })
                onDelete(agent.id)
                onBack()
              }} style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 6, color: '#f87171', cursor: 'pointer', fontSize: 10, padding: '3px 8px' }}>
                Delete
              </button>
            )}
          </div>
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
        <div style={{ display: 'flex', padding: '8px 10px 0', gap: 3, flexShrink: 0 }}>
          {([
            { id: 'tasks', label: 'Tasks', icon: <ListTodo size={10} /> },
            { id: 'train', label: 'Train', icon: <BookOpen size={10} /> },
            { id: 'integrations', label: 'Tools', icon: <Zap size={10} /> },
          ] as const).map(({ id: t, label, icon }) => (
            <button key={t} onClick={() => setTab(t)}
              style={{ flex: 1, padding: '5px 0', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, background: tab === t ? `${agent.accent}25` : 'transparent', color: tab === t ? agent.accent : 'rgba(148,163,184,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, transition: 'all 0.12s' }}>
              {icon}{label}
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
            <TaskTemplatesPanel agent={agent} onUseTemplate={(title, desc, type) => onRunTask(agent, { title, description: desc, type })} />
          <AgentDrivePanel agent={agent} />
          <AgentPromptEditor agent={agent} />
          <PromptVersionHistory agent={agent} />
          </div>
        ) : tab === 'integrations' ? (
          <div style={{ flex: 1, overflowY: 'auto' }}>
            <IntegrationsPanel agent={agent} />
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

// ── MCD Panel (right sidebar — always visible) ────────────────────────────
// Self-contained: own state, SSE streaming to /api/mcd/chat, source badges.

const SOURCE_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  GHL:         { bg: 'rgba(16,185,129,0.1)',  color: '#10b981', border: 'rgba(16,185,129,0.25)' },
  GA4:         { bg: 'rgba(251,191,36,0.1)',  color: '#fbbf24', border: 'rgba(251,191,36,0.25)' },
  GSC:         { bg: 'rgba(59,130,246,0.1)',  color: '#60a5fa', border: 'rgba(59,130,246,0.25)' },
  SEO:         { bg: 'rgba(168,85,247,0.1)',  color: '#c084fc', border: 'rgba(168,85,247,0.25)' },
  CALLS:       { bg: 'rgba(249,115,22,0.1)',  color: '#fb923c', border: 'rgba(249,115,22,0.25)' },
  INITIATIVES: { bg: 'rgba(236,72,153,0.1)',  color: '#f472b6', border: 'rgba(236,72,153,0.25)' },
  SPEND:       { bg: 'rgba(20,184,166,0.1)',  color: '#2dd4bf', border: 'rgba(20,184,166,0.25)' },
  GADS:        { bg: 'rgba(250,204,21,0.1)',  color: '#fcd34d', border: 'rgba(250,204,21,0.25)' },
  SURVEY:      { bg: 'rgba(244,63,94,0.1)',   color: '#fb7185', border: 'rgba(244,63,94,0.25)'  },
  FIREFLIES:   { bg: 'rgba(139,92,246,0.1)',  color: '#a78bfa', border: 'rgba(139,92,246,0.25)' },
}

// Inline bold/code renderer used in table cells and paragraph text
function inlineMcd(s: string): React.ReactNode {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} style={{ color:'white', fontWeight:600 }}>{p.slice(2,-2)}</strong>
    if (p.startsWith('`')  && p.endsWith('`'))  return <code key={i} style={{ background:'rgba(99,102,241,0.18)', borderRadius:3, padding:'1px 4px', fontSize:'0.9em', color:'#a5b4fc', fontFamily:'monospace' }}>{p.slice(1,-1)}</code>
    return p
  })
}

function renderMcdText(text: string): React.ReactNode[] {
  const lines   = text.split('\n')
  const out: React.ReactNode[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // ── Markdown table block ────────────────────────────────────────────────
    if (line.trimStart().startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        tableLines.push(lines[i]); i++
      }
      // Split each row into cells; skip separator rows (---|--- pattern)
      const isSep = (l: string) => /^\|[\s\-:|]+\|$/.test(l.trim())
      const parsed = tableLines
        .filter(l => !isSep(l))
        .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
      if (parsed.length > 0) {
        const [head, ...body] = parsed
        out.push(
          <div key={`tbl-${i}`} style={{ overflowX:'auto', margin:'8px 0', borderRadius:8, border:'1px solid rgba(99,102,241,0.15)' }}>
            <table style={{ borderCollapse:'collapse', width:'100%', fontSize:12 }}>
              <thead>
                <tr>
                  {head.map((cell, j) => (
                    <th key={j} style={{ padding:'7px 12px', background:'rgba(99,102,241,0.15)', color:'#a5b4fc', fontWeight:600, textAlign:'left', borderBottom:'1px solid rgba(99,102,241,0.2)', whiteSpace:'nowrap' }}>
                      {inlineMcd(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} style={{ background: ri%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{ padding:'6px 12px', color:'rgba(203,213,225,0.9)', borderBottom:'1px solid rgba(99,102,241,0.07)', whiteSpace:'nowrap' }}>
                        {inlineMcd(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      continue
    }

    // ── Headings ────────────────────────────────────────────────────────────
    if (line.startsWith('## ')) {
      out.push(<div key={i} style={{ fontSize:12, fontWeight:700, color:'#a5b4fc', marginTop:10, marginBottom:3, borderBottom:'1px solid rgba(99,102,241,0.15)', paddingBottom:2 }}>{line.slice(3)}</div>)
    } else if (line.startsWith('### ')) {
      out.push(<div key={i} style={{ fontSize:11, fontWeight:600, color:'#94a3b8', marginTop:8, marginBottom:2 }}>{line.slice(4)}</div>)

    // ── Bullet ──────────────────────────────────────────────────────────────
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      out.push(
        <div key={i} style={{ fontSize:12, color:'rgba(203,213,225,0.9)', lineHeight:1.7, paddingLeft:14, position:'relative' }}>
          <span style={{ position:'absolute', left:0, color:'#6366f1' }}>•</span>
          {inlineMcd(line.slice(2))}
        </div>
      )

    // ── Blank line ──────────────────────────────────────────────────────────
    } else if (line.trim() === '') {
      out.push(<div key={i} style={{ height:5 }} />)

    // ── Paragraph ───────────────────────────────────────────────────────────
    } else {
      out.push(
        <div key={i} style={{ fontSize:12, color:'rgba(203,213,225,0.9)', lineHeight:1.8 }}>
          {inlineMcd(line)}
        </div>
      )
    }
    i++
  }
  return out
}

interface McdConv { id: number; title: string; message_count: number; updated_at: string }

interface McdMemoryItem {
  id: number; key: string; value: string; category: string
  importance: 1 | 2 | 3; embedding: string | null
  source_conv_id: number | null; updated_at: string
}

function relDate(iso: string): string {
  const d    = new Date(iso + (iso.includes('T') ? '' : 'Z'))
  const now  = new Date()
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7)  return `${days}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function MCDPanel() {
  const [msgs, setMsgs]         = useState<McdChatMessage[]>([])
  const [input, setInput]       = useState('')
  const [loading, setLoading]   = useState(false)
  const [width, setWidth]       = useState(400)
  const [dragging, setDragging] = useState(false)

  // Conversation history
  const [convId, setConvId]         = useState<number | null>(null)
  const [convs, setConvs]           = useState<McdConv[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [histLoad, setHistLoad]     = useState(false)

  // Memory viewer
  const [showMemory, setShowMemory]   = useState(false)
  const [memoryData, setMemoryData]   = useState<McdMemoryItem[]>([])
  const [memLoad, setMemLoad]         = useState(false)
  const [editingId, setEditingId]     = useState<number | null>(null)
  const [editVal, setEditVal]         = useState('')
  const [editImp, setEditImp]         = useState<1|2|3>(2)

  const endRef   = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const startX   = useRef(0)
  const startW   = useRef(0)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  // Load conversation list on mount
  useEffect(() => {
    fetch('/api/mcd/conversations')
      .then(r => r.json())
      .then(d => setConvs(d.conversations ?? []))
      .catch(() => {})
  }, [])

  // Helper: refresh conv list
  async function refreshConvs() {
    const d = await fetch('/api/mcd/conversations').then(r => r.json()).catch(() => ({}))
    setConvs(d.conversations ?? [])
  }

  // Load a specific conversation's messages
  async function loadConv(id: number) {
    setHistLoad(true)
    try {
      const d = await fetch(`/api/mcd/conversations/${id}`).then(r => r.json())
      const loaded: McdChatMessage[] = (d.messages ?? []).map((m: { role: 'user'|'assistant'; content: string; sources: string }) => ({
        role:    m.role,
        content: m.content,
        sources: (() => { try { return JSON.parse(m.sources) } catch { return [] } })(),
      }))
      setMsgs(loaded)
      setConvId(id)
      setShowHistory(false)
    } finally { setHistLoad(false) }
  }

  // Start a brand-new chat (client side — server will create the DB row on first send)
  function newChat() {
    setMsgs([])
    setConvId(null)
    setShowHistory(false)
    setTimeout(() => inputRef.current?.focus(), 60)
  }

  // Delete a conversation
  async function deleteConv(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    await fetch(`/api/mcd/conversations/${id}`, { method: 'DELETE' })
    if (convId === id) newChat()
    setConvs(prev => prev.filter(c => c.id !== id))
  }

  // Memory viewer
  async function openMemory() {
    setShowMemory(m => !m)
    setShowHistory(false)
    if (!showMemory) {
      setMemLoad(true)
      try {
        const d = await fetch('/api/mcd/memory').then(r => r.json())
        setMemoryData(d.memories ?? [])
      } finally { setMemLoad(false) }
    }
  }

  async function saveMemory(id: number) {
    await fetch(`/api/mcd/memory/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: editVal, importance: editImp }),
    })
    setMemoryData(prev => prev.map(m => m.id === id ? { ...m, value: editVal, importance: editImp } : m))
    setEditingId(null)
  }

  async function deleteMemoryItem(id: number) {
    await fetch(`/api/mcd/memory/${id}`, { method: 'DELETE' })
    setMemoryData(prev => prev.filter(m => m.id !== id))
  }

  // ── Resize drag ────────────────────────────────────────────────────────────
  function onDragStart(e: React.MouseEvent) {
    e.preventDefault()
    startX.current = e.clientX
    startW.current = width
    setDragging(true)
    const onMove = (ev: MouseEvent) => {
      const delta = startX.current - ev.clientX          // drag left = wider
      const next  = Math.min(700, Math.max(280, startW.current + delta))
      setWidth(next)
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',  onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
  }

  // Detect mid-task narration — MCD saying it will continue but hasn't delivered yet
  function isMidTask(text: string): boolean {
    const t = text.toLowerCase()
    return (
      /i['']ll (report back|keep going|continue|narrow|search|try|look|find|pull|check)/.test(t) ||
      /still (locating|searching|looking|working|finding|checking)/.test(t) ||
      /(next (move|step|query|pass)|narrowing|give me a moment|one more (pass|step|query))/.test(t) ||
      /once i have the/.test(t) ||
      // ends without actual data — only bullets of "what I'll do", no numbers/results
      (/next (move|step):/i.test(t) && !/^\|/m.test(text) && !/\*\*\d/.test(text))
    )
  }

  const autoRetries = useRef(0)
  // Signals "a continuation is scheduled — keep loading spinner alive in finally"
  const continueScheduled = useRef(false)

  async function send(text?: string, _isAuto = false) {
    const t = (text ?? input).trim()
    // Auto-continuations bypass the loading guard (they fire while loading is still true)
    if (!t || (loading && !_isAuto)) return
    if (!_isAuto) { setInput(''); autoRetries.current = 0 }

    // Snapshot history from current msgs BEFORE mutating state
    const history = msgs
      .filter(m => !m.loading)
      .slice(-20)
      .map(m => ({ role: m.role, content: m.content }))

    // Update message list — no user bubble for auto-continuations
    setMsgs(prev => {
      const base = _isAuto
        ? prev.filter(m => !m.loading)
        : [...prev.filter(m => !m.loading), { role: 'user' as const, content: t }]
      return [...base, { role: 'assistant' as const, content: '', loading: true, sources: [] }]
    })
    setLoading(true)
    continueScheduled.current = false

    try {
      const res = await fetch('/api/mcd/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t, history, conversation_id: convId }),
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const dec    = new TextDecoder()
      let buf = '', full = '', sources: string[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break
          try {
            const ev = JSON.parse(raw)
            if (ev.type === 'sources') {
              sources = ev.sources || []
              // Capture server-assigned conversation_id (set on first message)
              if (ev.conversation_id && !convId) setConvId(ev.conversation_id)
            }
            if (ev.type === 'delta') {
              full += ev.content
              setMsgs(prev => { const n = [...prev]; const l = n[n.length-1]; if (l?.loading) n[n.length-1] = { ...l, content: full, sources, loading: true }; return n })
            }
          } catch {}
        }
      }

      setMsgs(prev => { const n = [...prev]; const l = n[n.length-1]; if (l?.loading) n[n.length-1] = { role:'assistant', content: full || '(no response)', sources }; return n })

      // Refresh conversation list after each completed exchange
      if (!isMidTask(full)) refreshConvs().catch(() => {})

      // Auto-continue if MCD narrated mid-task without delivering results (max 4 retries)
      if (isMidTask(full) && autoRetries.current < 4) {
        autoRetries.current++
        continueScheduled.current = true   // tell finally: don't clear loading yet
        setTimeout(() => send('continue', true), 900)
        return
      }

    } catch (e: any) {
      setMsgs(prev => { const n = [...prev]; const l = n[n.length-1]; if (l?.loading) n[n.length-1] = { role:'assistant', content:`Error: ${e.message}`, sources:[] }; return n })
    } finally {
      // Only clear loading when we're NOT about to fire another round
      if (!continueScheduled.current) {
        setLoading(false)
        setTimeout(() => inputRef.current?.focus(), 50)
      }
    }
  }

  const QUICK = ['Leads this week?', 'Discovery Call rate?', 'Pipeline status?', 'Top GSC queries?']

  return (
    <div style={{ width, flexShrink:0, background:'rgba(8,12,20,0.97)', borderLeft:'1px solid rgba(99,102,241,0.12)', display:'flex', flexDirection:'column', overflow:'hidden', position:'relative', userSelect: dragging ? 'none' : 'auto' }}>
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        style={{
          position:'absolute', left:0, top:0, bottom:0, width:5,
          cursor:'col-resize', zIndex:10,
          background: dragging ? 'rgba(14,165,233,0.35)' : 'transparent',
          transition:'background 0.15s',
        }}
        onMouseEnter={e => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = 'rgba(14,165,233,0.18)' }}
        onMouseLeave={e => { if (!dragging) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
      />
      {/* Header */}
      <div style={{ padding:'12px 14px 10px', borderBottom:'1px solid rgba(99,102,241,0.1)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
          <div style={{ width:28, height:28, borderRadius:7, background:'linear-gradient(135deg,#0ea5e9,#6366f1)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, boxShadow:'0 0 10px rgba(6,182,212,0.3)', flexShrink:0 }}>💬</div>
          <div style={{ minWidth:0, flex:1 }}>
            <div style={{ color:'white', fontWeight:700, fontSize:11, lineHeight:1.3 }}>Marketing and Conversions Director</div>
          </div>
          <div style={{ display:'flex', gap:4, flexShrink:0, alignItems:'center' }}>
            {loading && <motion.div animate={{ rotate:360 }} transition={{ repeat:Infinity, duration:1, ease:'linear' }}><RefreshCw size={12} color="#0ea5e9" /></motion.div>}
            {/* History toggle */}
            <button onClick={() => { setShowHistory(h => !h); setShowMemory(false) }} title={showHistory ? 'Back to chat' : 'Chat history'}
              style={{ background: showHistory ? 'rgba(14,165,233,0.15)' : 'none', border: showHistory ? '1px solid rgba(14,165,233,0.3)' : '1px solid transparent', borderRadius:6, padding:'3px 6px', cursor:'pointer', color: showHistory ? '#0ea5e9' : 'rgba(148,163,184,0.5)', fontSize:10, fontWeight:600, display:'flex', alignItems:'center', gap:3 }}>
              {showHistory ? '← Chat' : '⏱ History'}
            </button>
            {/* Memory viewer */}
            <button onClick={openMemory} title={showMemory ? 'Back to chat' : 'Memory'}
              style={{ background: showMemory ? 'rgba(139,92,246,0.15)' : 'none', border: showMemory ? '1px solid rgba(139,92,246,0.35)' : '1px solid transparent', borderRadius:6, padding:'3px 6px', cursor:'pointer', color: showMemory ? '#a78bfa' : 'rgba(148,163,184,0.5)', fontSize:13, lineHeight:1 }}>
              🧠
            </button>
            {/* New chat */}
            <button onClick={newChat} title="New chat"
              style={{ background:'none', border:'1px solid transparent', borderRadius:6, padding:'3px 6px', cursor:'pointer', color:'rgba(148,163,184,0.5)', fontSize:10, fontWeight:600 }}>
              + New
            </button>
          </div>
        </div>
        {!showHistory && (
          <div style={{ display:'flex', flexDirection:'column', gap:4, paddingLeft:36 }}>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 8px' }}>
              {['Leads','Discovery Calls','Pipeline','Call Quality','SEO Rankings','Traffic'].map(cap => (
                <span key={cap} style={{ fontSize:10, color:'rgba(148,163,184,0.55)', fontWeight:500 }}>{cap}</span>
              ))}
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:'3px 5px' }}>
              {['GHL','GA4','GSC','SEO Utils','Calls','Initiatives'].map(src => (
                <span key={src} style={{ fontSize:9, padding:'1px 6px', borderRadius:4, background:'rgba(14,165,233,0.07)', color:'rgba(14,165,233,0.6)', border:'1px solid rgba(14,165,233,0.13)' }}>{src}</span>
              ))}
            </div>
          </div>
        )}
        {showHistory && convId && (
          <div style={{ paddingLeft:36, fontSize:10, color:'rgba(14,165,233,0.7)', fontWeight:500 }}>
            {convs.find(c => c.id === convId)?.title ?? 'Current chat'}
          </div>
        )}
      </div>

      {/* History panel (slides over the chat area) */}
      {showHistory && (
        <div style={{ position:'absolute', inset:0, top:88, background:'rgba(8,12,20,0.98)', zIndex:20, display:'flex', flexDirection:'column', overflowY:'auto' }}>
          <div style={{ padding:'10px 12px', borderBottom:'1px solid rgba(99,102,241,0.08)' }}>
            <button onClick={newChat}
              style={{ width:'100%', background:'rgba(14,165,233,0.1)', border:'1px solid rgba(14,165,233,0.25)', borderRadius:8, padding:'8px 12px', color:'#0ea5e9', fontSize:12, fontWeight:600, cursor:'pointer', textAlign:'left' }}>
              + New Chat
            </button>
          </div>
          {histLoad && (
            <div style={{ padding:20, textAlign:'center', color:'rgba(148,163,184,0.3)', fontSize:12 }}>Loading…</div>
          )}
          {!histLoad && convs.length === 0 && (
            <div style={{ padding:20, textAlign:'center', color:'rgba(148,163,184,0.25)', fontSize:12 }}>No previous chats yet</div>
          )}
          {!histLoad && convs.map(c => (
            <div key={c.id} onClick={() => loadConv(c.id)}
              style={{ padding:'10px 14px', borderBottom:'1px solid rgba(99,102,241,0.06)', cursor:'pointer', display:'flex', alignItems:'center', gap:8, background: c.id === convId ? 'rgba(14,165,233,0.08)' : 'transparent', transition:'background 0.1s' }}
              onMouseEnter={e => { if (c.id !== convId) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.03)' }}
              onMouseLeave={e => { if (c.id !== convId) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ color: c.id === convId ? '#0ea5e9' : 'rgba(255,255,255,0.85)', fontSize:12, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.title}</div>
                <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, marginTop:2 }}>{relDate(c.updated_at)} · {c.message_count} msg{c.message_count !== 1 ? 's' : ''}</div>
              </div>
              <button onClick={e => deleteConv(c.id, e)} title="Delete"
                style={{ flexShrink:0, background:'none', border:'none', color:'rgba(148,163,184,0.25)', cursor:'pointer', padding:'2px 4px', fontSize:14, lineHeight:1, borderRadius:4 }}
                onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = '#f43f5e'}
                onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = 'rgba(148,163,184,0.25)'}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Memory viewer panel */}
      {showMemory && (
        <div style={{ position:'absolute', inset:0, top:88, background:'rgba(8,12,20,0.98)', zIndex:20, display:'flex', flexDirection:'column', overflowY:'auto' }}>
          {/* Panel header */}
          <div style={{ padding:'10px 14px', borderBottom:'1px solid rgba(139,92,246,0.12)', display:'flex', alignItems:'center', gap:6 }}>
            <span style={{ fontSize:14 }}>🧠</span>
            <span style={{ color:'rgba(167,139,250,0.9)', fontSize:11, fontWeight:700, flex:1 }}>What MCD Remembers</span>
            <span style={{ color:'rgba(148,163,184,0.35)', fontSize:10 }}>{memoryData.length} fact{memoryData.length !== 1 ? 's' : ''}</span>
          </div>

          {memLoad && (
            <div style={{ padding:24, textAlign:'center', color:'rgba(148,163,184,0.3)', fontSize:12 }}>Loading memories…</div>
          )}
          {!memLoad && memoryData.length === 0 && (
            <div style={{ padding:24, textAlign:'center', color:'rgba(148,163,184,0.25)', fontSize:12 }}>
              No memories yet — they'll build up as you chat.
            </div>
          )}

          {!memLoad && (() => {
            // Group by category
            const CAT_COLOR: Record<string, string> = {
              preference: '#0ea5e9', metric: '#10b981', person: '#f59e0b',
              decision: '#6366f1', initiative: '#8b5cf6', context: '#64748b', constraint: '#f43f5e',
            }
            const groups: Record<string, McdMemoryItem[]> = {}
            for (const m of memoryData) {
              if (!groups[m.category]) groups[m.category] = []
              groups[m.category].push(m)
            }
            return Object.entries(groups).map(([cat, items]) => (
              <div key={cat}>
                {/* Category header */}
                <div style={{ padding:'8px 14px 4px', display:'flex', alignItems:'center', gap:6 }}>
                  <div style={{ width:6, height:6, borderRadius:'50%', background: CAT_COLOR[cat] ?? '#64748b', flexShrink:0 }} />
                  <span style={{ color: CAT_COLOR[cat] ?? '#64748b', fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:0.8 }}>{cat}</span>
                </div>

                {items.map(mem => {
                  const isEditing = editingId === mem.id
                  return (
                    <div key={mem.id}
                      style={{ margin:'0 10px 6px', padding:'9px 11px', borderRadius:8, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(99,102,241,0.08)', position:'relative' }}>

                      {/* Importance dots + flag */}
                      <div style={{ display:'flex', alignItems:'center', gap:4, marginBottom:5 }}>
                        {[1,2,3].map(n => (
                          <div key={n} style={{ width:6, height:6, borderRadius:'50%', background: n <= mem.importance ? (CAT_COLOR[mem.category] ?? '#6366f1') : 'rgba(99,102,241,0.12)' }} />
                        ))}
                        {mem.importance === 3 && <span style={{ fontSize:10, color:'#fbbf24', marginLeft:2 }}>⚑</span>}
                        <span style={{ flex:1 }} />
                        <span style={{ color:'rgba(148,163,184,0.3)', fontSize:9 }}>
                          {mem.updated_at ? new Date(mem.updated_at + (mem.updated_at.includes('T') ? '' : 'Z')).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : ''}
                        </span>
                      </div>

                      {/* Value — editable */}
                      {isEditing ? (
                        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                          <textarea
                            value={editVal}
                            onChange={e => setEditVal(e.target.value)}
                            rows={3}
                            style={{ width:'100%', background:'rgba(0,0,0,0.3)', border:'1px solid rgba(139,92,246,0.4)', borderRadius:6, padding:'6px 8px', color:'white', fontSize:11, resize:'vertical', fontFamily:'inherit', boxSizing:'border-box' }}
                          />
                          {/* Importance selector */}
                          <div style={{ display:'flex', gap:4, alignItems:'center' }}>
                            <span style={{ color:'rgba(148,163,184,0.5)', fontSize:10 }}>Importance:</span>
                            {([1,2,3] as const).map(n => (
                              <button key={n} onClick={() => setEditImp(n)}
                                style={{ width:22, height:22, borderRadius:5, border:'1px solid', borderColor: editImp === n ? (CAT_COLOR[mem.category] ?? '#6366f1') : 'rgba(99,102,241,0.2)', background: editImp === n ? `${CAT_COLOR[mem.category] ?? '#6366f1'}22` : 'transparent', color: editImp === n ? (CAT_COLOR[mem.category] ?? '#a5b4fc') : 'rgba(148,163,184,0.4)', fontSize:10, fontWeight:700, cursor:'pointer' }}>
                                {n}
                              </button>
                            ))}
                            <span style={{ flex:1 }} />
                            <button onClick={() => saveMemory(mem.id)}
                              style={{ padding:'2px 10px', borderRadius:5, border:'1px solid rgba(139,92,246,0.4)', background:'rgba(139,92,246,0.15)', color:'#a78bfa', fontSize:10, fontWeight:600, cursor:'pointer' }}>
                              Save
                            </button>
                            <button onClick={() => setEditingId(null)}
                              style={{ padding:'2px 8px', borderRadius:5, border:'1px solid rgba(99,102,241,0.15)', background:'transparent', color:'rgba(148,163,184,0.4)', fontSize:10, cursor:'pointer' }}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display:'flex', gap:6, alignItems:'flex-start' }}>
                          <p
                            onClick={() => { setEditingId(mem.id); setEditVal(mem.value); setEditImp(mem.importance) }}
                            title="Click to edit"
                            style={{ flex:1, color:'rgba(226,232,240,0.85)', fontSize:11, lineHeight:1.6, margin:0, cursor:'text', wordBreak:'break-word' }}>
                            {mem.value}
                          </p>
                          <button onClick={() => deleteMemoryItem(mem.id)} title="Delete fact"
                            style={{ flexShrink:0, background:'none', border:'none', color:'rgba(148,163,184,0.2)', cursor:'pointer', padding:'0 2px', fontSize:14, lineHeight:1 }}
                            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.color = '#f43f5e'}
                            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.color = 'rgba(148,163,184,0.2)'}>
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))
          })()}
          <div style={{ height:16 }} />
        </div>
      )}

      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', overflowX:'hidden', padding:'14px 14px', display:'flex', flexDirection:'column', gap:12 }}>
        {msgs.length === 0 && (
          <div style={{ marginTop:24, display:'flex', flexDirection:'column', gap:8 }}>
            <div style={{ textAlign:'center', color:'rgba(148,163,184,0.3)', fontSize:12, marginBottom:4 }}>Ask anything about PHR</div>
            {QUICK.map((q,i) => (
              <button key={i} onClick={() => send(q)}
                style={{ background:'rgba(14,165,233,0.06)', border:'1px solid rgba(14,165,233,0.15)', borderRadius:9, padding:'9px 12px', color:'rgba(148,163,184,0.75)', fontSize:12, cursor:'pointer', textAlign:'left', lineHeight:1.5 }}>
                {q}
              </button>
            ))}
          </div>
        )}

        {msgs.map((m, i) => (
          <div key={i} style={{ display:'flex', flexDirection:'column', alignItems: m.role==='user' ? 'flex-end' : 'flex-start', gap:5 }}>
            {/* Source badges */}
            {m.role==='assistant' && m.sources && m.sources.length > 0 && (
              <div style={{ display:'flex', gap:4, flexWrap:'wrap', paddingLeft:2 }}>
                {m.sources.map(s => {
                  const c = SOURCE_COLORS[s] || { bg:'rgba(99,102,241,0.1)', color:'#a5b4fc', border:'rgba(99,102,241,0.25)' }
                  return <span key={s} style={{ fontSize:10, padding:'2px 7px', borderRadius:6, background:c.bg, color:c.color, border:`1px solid ${c.border}`, fontWeight:600, letterSpacing:0.3 }}>{s}</span>
                })}
              </div>
            )}
            <div style={{
              maxWidth: m.role==='user' ? '88%' : '100%',
              width:    m.role==='assistant' ? '100%' : undefined,
              padding: m.role==='user' ? '9px 13px' : '10px 14px',
              borderRadius: m.role==='user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
              background: m.role==='user' ? 'linear-gradient(135deg,#0369a1,#0ea5e9)' : 'rgba(15,20,35,0.9)',
              border: m.role==='assistant' ? '1px solid rgba(14,165,233,0.12)' : 'none',
              color:'white', fontSize:13, lineHeight:1.6, wordBreak:'break-word', minWidth:0,
              overflowX: m.role==='assistant' ? 'hidden' : undefined,
            }}>
              {m.role==='assistant' ? (
                m.loading && !m.content ? (
                  <div style={{ display:'flex', gap:4, padding:'3px 0' }}>
                    {[0,1,2].map(j => <motion.div key={j} animate={{ opacity:[0.3,1,0.3] }} transition={{ repeat:Infinity, duration:1.2, delay:j*0.2 }} style={{ width:6, height:6, borderRadius:'50%', background:'#0ea5e9' }} />)}
                  </div>
                ) : renderMcdText(m.content)
              ) : m.content}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div style={{ padding:'12px 12px 16px', borderTop:'1px solid rgba(99,102,241,0.1)', display:'flex', gap:8, flexShrink:0 }}>
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Ask MCD…"
          disabled={loading}
          style={{ flex:1, background:'rgba(14,165,233,0.07)', border:'1px solid rgba(14,165,233,0.18)', borderRadius:10, padding:'9px 13px', color:'white', fontSize:13, outline:'none', opacity: loading ? 0.6 : 1, minWidth:0 }}
        />
        <motion.button whileTap={{ scale:0.9 }} onClick={() => send()} disabled={loading}
          style={{ width:36, height:36, borderRadius:10, background:'linear-gradient(135deg,#0369a1,#0ea5e9)', border:'none', color:'white', cursor: loading ? 'not-allowed' : 'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, opacity: loading ? 0.5 : 1 }}>
          <Send size={14} />
        </motion.button>
      </div>
    </div>
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
          <div style={{ color: 'rgba(148,163,184,0.5)', fontSize: 11 }}>OpenAI · gpt-5.4-mini</div>
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

// ── Analytics View ─────────────────────────────────────────────────────────

function AnalyticsView() {
  const [data, setData] = useState<any>(null)
  useEffect(() => { fetch('/api/analytics').then(r => r.json()).then(setData) }, [])
  if (!data) return <div style={{ padding: 40, color: 'rgba(148,163,184,0.4)', textAlign: 'center' }}>Loading analytics…</div>
  const { summary, byAgent, byDay, byType } = data
  const costEstimate = ((summary?.total_tokens || 0) / 1000 * 0.0004).toFixed(2)
  const successRate = summary?.total_tasks > 0 ? Math.round((summary.completed / summary.total_tasks) * 100) : 0

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>Analytics</h1>
        <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: '4px 0 0' }}>Token usage, task performance, agent stats</p>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Total Tasks',    value: summary?.total_tasks || 0,    color: '#a5b4fc' },
          { label: 'Success Rate',   value: `${successRate}%`,            color: '#10b981' },
          { label: 'Tokens Used',    value: fmt(summary?.total_tokens || 0), color: '#f59e0b' },
          { label: 'Est. Cost',      value: `$${costEstimate}`,           color: '#f43f5e' },
          { label: 'Avg Duration',   value: summary?.avg_duration_secs ? `${Math.round(summary.avg_duration_secs)}s` : 'N/A', color: '#06b6d4' },
          { label: 'Failed',         value: summary?.failed || 0,         color: '#ef4444' },
        ].map(kpi => (
          <div key={kpi.label} style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.5)', marginBottom: 4 }}>{kpi.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
          </div>
        ))}
      </div>

      {/* Tasks per day bar chart */}
      <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, color: 'white', fontSize: 14, marginBottom: 14 }}>Tasks Last 14 Days</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 }}>
          {(byDay || []).map((d: any) => {
            const max = Math.max(...(byDay || []).map((x: any) => x.count), 1)
            const h = Math.max((d.count / max) * 72, 4)
            return (
              <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                <div title={`${d.count} tasks`} style={{ width: '100%', height: h, background: 'linear-gradient(180deg,#6366f1,#4338ca)', borderRadius: 3, minHeight: 4 }} />
                <span style={{ fontSize: 8, color: 'rgba(148,163,184,0.3)', transform: 'rotate(-45deg)', transformOrigin: 'center' }}>{d.day?.slice(5)}</span>
              </div>
            )
          })}
          {!byDay?.length && <div style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12 }}>No data yet</div>}
        </div>
      </div>

      {/* Agent breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 18 }}>
          <div style={{ fontWeight: 600, color: 'white', fontSize: 14, marginBottom: 12 }}>By Agent</div>
          {(byAgent || []).map((a: any) => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: a.accent, flexShrink: 0 }} />
              <span style={{ color: 'rgba(148,163,184,0.7)', fontSize: 12, flex: 1 }}>{a.name}</span>
              <span style={{ color: 'white', fontSize: 12, fontWeight: 600 }}>{a.task_count}</span>
              <span style={{ color: 'rgba(148,163,184,0.4)', fontSize: 11 }}>{fmt(a.tokens || 0)} tok</span>
            </div>
          ))}
        </div>
        <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 18 }}>
          <div style={{ fontWeight: 600, color: 'white', fontSize: 14, marginBottom: 12 }}>By Type</div>
          {(byType || []).map((t: any) => (
            <div key={t.type} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ color: 'rgba(148,163,184,0.7)', fontSize: 12 }}>{t.type}</span>
              <span style={{ color: '#a5b4fc', fontSize: 12, fontWeight: 600 }}>{t.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Pipelines View ──────────────────────────────────────────────────────────

interface PipelineStep { agent_id: string; title: string; description: string; type: string; use_previous: boolean }
interface PipelineDef  { id: number; name: string; description: string; steps: PipelineStep[]; enabled: number; created_at: string }

function PipelinesView({ agents }: { agents: Agent[] }) {
  const [pipelines, setPipelines] = useState<PipelineDef[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [running, setRunning] = useState<number | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const res = await fetch('/api/pipelines')
    if (res.ok) {
      const raw = await res.json()
      setPipelines(raw.map((p: any) => ({ ...p, steps: JSON.parse(p.steps || '[]') })))
    }
  }

  async function run(p: PipelineDef) {
    setRunning(p.id)
    await fetch(`/api/pipelines/${p.id}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    setTimeout(() => setRunning(null), 2000)
  }

  async function remove(id: number) {
    await fetch(`/api/pipelines?id=${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>Pipelines</h1>
          <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: '4px 0 0' }}>Chain agents together — output of one feeds the next</p>
        </div>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={() => setShowCreate(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          <Plus size={14} /> New Pipeline
        </motion.button>
      </div>

      {pipelines.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(148,163,184,0.3)' }}>
          <GitBranch size={40} style={{ margin: '0 auto 12px', display: 'block', opacity: 0.3 }} />
          <p>No pipelines yet. Create one to chain agents together.</p>
          <p style={{ fontSize: 12, marginTop: 8 }}>Example: Research → Writer → Email</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {pipelines.map(p => (
          <div key={p.id} style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 14, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ color: 'white', fontWeight: 600, fontSize: 15 }}>{p.name}</div>
                {p.description && <div style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, marginTop: 2 }}>{p.description}</div>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => run(p)} disabled={running === p.id}
                  style={{ padding: '6px 14px', background: running === p.id ? 'rgba(99,102,241,0.2)' : 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 7, color: 'white', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Play size={11} />{running === p.id ? 'Starting…' : 'Run'}
                </motion.button>
                <button onClick={() => remove(p.id)} style={{ padding: '6px 10px', background: 'transparent', border: '1px solid rgba(244,63,94,0.2)', borderRadius: 7, color: 'rgba(244,63,94,0.5)', cursor: 'pointer' }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
            {/* Step flow */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {p.steps.map((step, i) => {
                const ag = agents.find(a => a.id === step.agent_id)
                return (
                  <React.Fragment key={i}>
                    <div style={{ padding: '4px 10px', background: `${ag?.accent || '#6366f1'}20`, border: `1px solid ${ag?.accent || '#6366f1'}40`, borderRadius: 20, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: ag?.accent || '#6366f1' }} />
                      <span style={{ fontSize: 11, color: 'white' }}>{ag?.name || step.agent_id}</span>
                    </div>
                    {i < p.steps.length - 1 && <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12 }}>→</span>}
                  </React.Fragment>
                )
              })}
              {!p.steps.length && <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12 }}>No steps configured</span>}
            </div>
          </div>
        ))}
      </div>

      {showCreate && <CreatePipelineModal agents={agents} onClose={() => { setShowCreate(false); load() }} />}
    </div>
  )
}

function CreatePipelineModal({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<PipelineStep[]>([{ agent_id: agents[0]?.id || '', title: '', description: '', type: 'general', use_previous: true }])
  const [saving, setSaving] = useState(false)

  function addStep() { setSteps(s => [...s, { agent_id: agents[0]?.id || '', title: '', description: '', type: 'general', use_previous: true }]) }
  function removeStep(i: number) { setSteps(s => s.filter((_, idx) => idx !== i)) }
  function updateStep(i: number, field: string, val: any) { setSteps(s => s.map((step, idx) => idx === i ? { ...step, [field]: val } : step)) }

  async function save() {
    if (!name.trim() || !steps.length) return
    setSaving(true)
    await fetch('/api/pipelines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, steps }) })
    setSaving(false)
    onClose()
  }

  const inputStyle = { width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }
  const labelStyle = { color: 'rgba(148,163,184,0.6)', fontSize: 10, marginBottom: 4, display: 'block' as const }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 560, maxHeight: '88vh', overflowY: 'auto', background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Create Pipeline</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          <div><label style={labelStyle}>PIPELINE NAME</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Lead Research & Outreach" style={inputStyle} /></div>
          <div><label style={labelStyle}>DESCRIPTION (optional)</label><input value={description} onChange={e => setDescription(e.target.value)} placeholder="What this pipeline does" style={inputStyle} /></div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>Steps</span>
            <button onClick={addStep} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 6, color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>
              <Plus size={10} /> Add Step
            </button>
          </div>
          {steps.map((step, i) => (
            <div key={i} style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 10, padding: 14, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ color: '#a5b4fc', fontWeight: 600, fontSize: 12 }}>Step {i + 1}</span>
                {steps.length > 1 && <button onClick={() => removeStep(i)} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.5)', cursor: 'pointer', fontSize: 11 }}>Remove</button>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <div>
                  <label style={labelStyle}>AGENT</label>
                  <select value={step.agent_id} onChange={e => updateStep(i, 'agent_id', e.target.value)} style={{ ...inputStyle, fontFamily: 'inherit' }}>
                    {agents.map(a => <option key={a.id} value={a.id} style={{ background: '#0f1623' }}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>TYPE</label>
                  <select value={step.type} onChange={e => updateStep(i, 'type', e.target.value)} style={{ ...inputStyle, fontFamily: 'inherit' }}>
                    {['general','code','search','scrape','browser','file','api','approval'].map(t => <option key={t} value={t} style={{ background: '#0f1623' }}>{t === 'approval' ? '⏳ approval (gate)' : t}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 8 }}><label style={labelStyle}>TASK TITLE</label><input value={step.title} onChange={e => updateStep(i, 'title', e.target.value)} placeholder="Step title (supports {{variables}})" style={inputStyle} /></div>
              <div><label style={labelStyle}>TASK DESCRIPTION / PROMPT</label><textarea value={step.description} onChange={e => updateStep(i, 'description', e.target.value)} rows={3} placeholder={i > 0 ? "What to do. Previous step's output is appended automatically." : "What to do. Use {{variable_name}} for dynamic inputs."} style={{ ...inputStyle, resize: 'vertical' as const, lineHeight: 1.5 }} /></div>
              {i > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, cursor: 'pointer', color: 'rgba(148,163,184,0.6)', fontSize: 11 }}>
                  <input type="checkbox" checked={step.use_previous} onChange={e => updateStep(i, 'use_previous', e.target.checked)} />
                  Pass previous step output to this step
                </label>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={save} disabled={saving || !name.trim()}
            style={{ flex: 1, padding: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: !name.trim() ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Create Pipeline'}
          </motion.button>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </motion.div>
    </div>
  )
}


// ── Company Knowledge Base Panel ──────────────────────────────────────────

function CompanyKbPanel() {
  const [files, setFiles] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState<{text:string;ok:boolean}|null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/company-knowledge'); if(r.ok) setFiles(await r.json()) }

  async function upload(files: FileList|null) {
    if (!files?.length) return
    setUploading(true); setMsg(null)
    const fd = new FormData()
    Array.from(files).forEach(f => fd.append('files', f))
    const r = await fetch('/api/company-knowledge', { method: 'POST', body: fd })
    const d = await r.json()
    setMsg({ text: `✅ ${(d.saved||[]).filter((s:any)=>!s.error).length} file(s) uploaded`, ok: true })
    setUploading(false); load()
    setTimeout(() => setMsg(null), 3000)
  }

  async function remove(id: number) { await fetch(`/api/company-knowledge?id=${id}`, { method: 'DELETE' }); load() }

  return (
    <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <BookOpen size={14} color="#a5b4fc" />
        <span style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>Company Knowledge Base</span>
        <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)' }}>— shared by ALL agents automatically</span>
      </div>
      <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        style={{ border: '2px dashed rgba(99,102,241,0.25)', borderRadius: 10, padding: '16px', textAlign: 'center', cursor: 'pointer', marginBottom: 12, background: 'rgba(99,102,241,0.04)' }}>
        <input ref={inputRef} type="file" multiple accept=".pdf,.txt,.md,.csv,.json,.html" style={{ display: 'none' }} onChange={e => upload(e.target.files)} />
        <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, margin: 0 }}>{uploading ? 'Uploading…' : 'Drop files here or click — PDF, TXT, MD, CSV, JSON'}</p>
      </div>
      {msg && <div style={{ padding: '6px 12px', borderRadius: 8, background: msg.ok?'rgba(16,185,129,0.08)':'rgba(244,63,94,0.08)', border: `1px solid ${msg.ok?'rgba(16,185,129,0.2)':'rgba(244,63,94,0.2)'}`, color: msg.ok?'#10b981':'#f43f5e', fontSize: 12, marginBottom: 10 }}>{msg.text}</div>}
      {files.length === 0 && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, textAlign: 'center', margin: 0 }}>No company files yet. Upload your service catalog, pricing, FAQs, etc.</p>}
      {files.map((f:any) => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid rgba(99,102,241,0.07)' }}>
          <div>
            <span style={{ color: 'white', fontSize: 13 }}>{f.filename}</span>
            <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, marginLeft: 8 }}>{(f.file_size/1024).toFixed(1)} KB</span>
          </div>
          <button onClick={() => remove(f.id)} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}><Trash2 size={12} /></button>
        </div>
      ))}
    </div>
  )
}

// ── Outbound Webhooks Panel ────────────────────────────────────────────────

function WebhooksPanel() {
  const [webhooks, setWebhooks] = useState<any[]>([])
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState('task.completed')
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/webhooks'); if(r.ok) setWebhooks(await r.json()) }

  async function create() {
    if (!name.trim() || !url.trim()) return
    setSaving(true)
    await fetch('/api/webhooks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, url, events }) })
    setName(''); setUrl(''); setSaving(false); load()
  }

  async function remove(id: number) { await fetch(`/api/webhooks?id=${id}`, { method: 'DELETE' }); load() }

  const inputStyle = { background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' as const }

  return (
    <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Globe size={14} color="#a5b4fc" />
        <span style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>Outbound Webhooks</span>
        <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)' }}>— POST task results to external systems</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. GHL Webhook)" style={inputStyle} />
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://your-endpoint.com/webhook" style={inputStyle} />
        <select value={events} onChange={e => setEvents(e.target.value)} style={{ ...inputStyle, fontFamily: 'inherit' }}>
          <option value="task.completed">task.completed</option>
          <option value="task.failed">task.failed</option>
          <option value="task.completed,task.failed">task.completed + task.failed</option>
        </select>
        <motion.button whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={create} disabled={saving || !name.trim() || !url.trim()}
          style={{ padding: '8px', background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 8, color: 'white', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: (!name.trim()||!url.trim())?0.5:1 }}>
          {saving ? 'Adding…' : 'Add Webhook'}
        </motion.button>
      </div>
      {webhooks.length === 0 && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, textAlign: 'center', margin: 0 }}>No webhooks yet</p>}
      {webhooks.map((w:any) => (
        <div key={w.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(99,102,241,0.07)' }}>
          <div>
            <span style={{ color: 'white', fontSize: 13 }}>{w.name}</span>
            <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, display: 'block' }}>{w.url.slice(0, 50)}…</span>
            <span style={{ color: '#a5b4fc', fontSize: 10 }}>{w.events}</span>
          </div>
          <button onClick={() => remove(w.id)} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}><Trash2 size={12} /></button>
        </div>
      ))}
    </div>
  )
}

// ── Event Triggers Panel ───────────────────────────────────────────────────

function TriggersPanel({ agents }: { agents: Agent[] }) {
  const [triggers, setTriggers] = useState<any[]>([])
  const [showAdd, setShowAdd] = useState(false)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/triggers'); if(r.ok) setTriggers(await r.json()) }

  async function toggle(t: any) {
    await fetch('/api/triggers', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: t.id, enabled: t.enabled ? 0 : 1 }) })
    load()
  }

  async function remove(id: number) { await fetch(`/api/triggers?id=${id}`, { method: 'DELETE' }); load() }

  const EVENT_LABELS: Record<string, string> = {
    'ghl.contact.created': '🟢 GHL New Contact',
    'ghl.opportunity.created': '💰 GHL New Opportunity',
  }

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>Event Triggers</h1>
          <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: '4px 0 0' }}>Auto-run agents when things happen in GHL</p>
        </div>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={() => setShowAdd(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
          <Plus size={14} /> New Trigger
        </motion.button>
      </div>

      {triggers.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'rgba(148,163,184,0.3)' }}>
          <Zap size={40} style={{ margin: '0 auto 12px', display: 'block', opacity: 0.3 }} />
          <p>No triggers yet.</p>
          <p style={{ fontSize: 12, marginTop: 8 }}>Example: New GHL contact → Research agent writes a personalised follow-up</p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {triggers.map((t:any) => {
          const cfg = JSON.parse(t.config || '{}')
          const ag = agents.find((a:Agent) => a.id === cfg.agent_id)
          return (
            <div key={t.id} style={{ background: 'rgba(15,20,35,0.8)', border: `1px solid ${t.enabled ? 'rgba(99,102,241,0.2)' : 'rgba(148,163,184,0.08)'}`, borderRadius: 14, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>{t.name}</span>
                    <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: t.enabled?'rgba(16,185,129,0.12)':'rgba(148,163,184,0.08)', color: t.enabled?'#10b981':'rgba(148,163,184,0.4)' }}>{t.enabled?'Active':'Paused'}</span>
                  </div>
                  <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, margin: '4px 0 0' }}>{EVENT_LABELS[t.event_type] || t.event_type} → {ag?.name || cfg.agent_id || 'No agent'}</p>
                  {t.last_check && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, margin: '2px 0 0' }}>Last checked: {new Date(t.last_check).toLocaleString()}</p>}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => toggle(t)} style={{ padding: '5px 12px', background: t.enabled?'rgba(16,185,129,0.1)':'rgba(99,102,241,0.1)', border: `1px solid ${t.enabled?'rgba(16,185,129,0.25)':'rgba(99,102,241,0.25)'}`, borderRadius: 7, color: t.enabled?'#10b981':'#a5b4fc', fontSize: 11, cursor: 'pointer' }}>
                    {t.enabled ? 'Pause' : 'Activate'}
                  </button>
                  <button onClick={() => remove(t.id)} style={{ padding: '5px 8px', background: 'transparent', border: '1px solid rgba(244,63,94,0.2)', borderRadius: 7, color: 'rgba(244,63,94,0.5)', cursor: 'pointer' }}><Trash2 size={11} /></button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {showAdd && <AddTriggerModal agents={agents} onClose={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddTriggerModal({ agents, onClose }: { agents: Agent[]; onClose: () => void }) {
  const [name, setName] = useState('')
  const [eventType, setEventType] = useState('ghl.contact.created')
  const [agentId, setAgentId] = useState(agents[0]?.id || '')
  const [apiKey, setApiKey] = useState('')
  const [locationId, setLocationId] = useState('')
  const [template, setTemplate] = useState('New GHL contact: {{name}} ({{email}}, {{phone}}). Research this lead and draft a personalised follow-up email for Phoenix Home Remodeling.')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim() || !apiKey.trim() || !locationId.trim()) return
    setSaving(true)
    await fetch('/api/triggers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, event_type: eventType, config: { apiKey, locationId, agent_id: agentId, task_description_template: template }, action_type: 'task', action_id: agentId }),
    })
    setSaving(false); onClose()
  }

  const inp = { background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' as const }
  const lbl = { color: 'rgba(148,163,184,0.6)', fontSize: 10, marginBottom: 4, display: 'block' as const }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 520, maxHeight: '88vh', overflowY: 'auto', background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>New Event Trigger</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label style={lbl}>TRIGGER NAME</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. New Lead Auto-Research" style={inp} /></div>
          <div><label style={lbl}>WHEN THIS HAPPENS</label>
            <select value={eventType} onChange={e => setEventType(e.target.value)} style={{ ...inp, fontFamily: 'inherit' }}>
              <option value="ghl.contact.created">GHL — New Contact Created</option>
              <option value="ghl.opportunity.created">GHL — New Opportunity Created</option>
            </select>
          </div>
          <div><label style={lbl}>GHL API KEY</label><input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="eyJhbGci..." style={inp} /></div>
          <div><label style={lbl}>GHL LOCATION ID</label><input value={locationId} onChange={e => setLocationId(e.target.value)} placeholder="abc123..." style={inp} /></div>
          <div><label style={lbl}>RUN THIS AGENT</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ ...inp, fontFamily: 'inherit' }}>
              {agents.map(a => <option key={a.id} value={a.id} style={{ background: '#0f1623' }}>{a.name}</option>)}
            </select>
          </div>
          <div><label style={lbl}>TASK DESCRIPTION TEMPLATE (use {"{{"}) {"{{name}}"}, {"{{email}}"}, {"{{phone}}"} {"{{value}}"}, {"{{stage}}"})</label>
            <textarea value={template} onChange={e => setTemplate(e.target.value)} rows={4} style={{ ...inp, resize: 'vertical' as const, lineHeight: 1.5, fontFamily: 'inherit' }} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={save} disabled={saving || !name.trim() || !apiKey.trim() || !locationId.trim()}
            style={{ flex: 1, padding: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: (!name.trim()||!apiKey.trim()||!locationId.trim())?0.5:1 }}>
            {saving ? 'Creating…' : 'Create Trigger'}
          </motion.button>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
        <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, marginTop: 12, textAlign: 'center' }}>Triggers poll GHL every 5 minutes. First check covers the past hour.</p>
      </motion.div>
    </div>
  )
}

// ── Google Drive Sync Panel ────────────────────────────────────────────────

function DriveSyncPanel({ agents }: { agents: Agent[] }) {
  const [configs, setConfigs] = useState<any[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [syncing, setSyncing] = useState<number | null>(null)
  const [syncResult, setSyncResult] = useState<string[]>([])
  const [oauthStatus, setOauthStatus] = useState<{connected:boolean;has_credentials:boolean} | null>(null)
  const [showOauthSetup, setShowOauthSetup] = useState(false)

  useEffect(() => { load(); checkOauth() }, [])

  async function checkOauth() {
    const r = await fetch('/api/drive-sync/oauth?action=status')
    if (r.ok) setOauthStatus(await r.json())
  }

  async function load() { const r = await fetch('/api/drive-sync'); if(r.ok) setConfigs(await r.json()) }

  async function sync(id?: number) {
    setSyncing(id || 0); setSyncResult([])
    const r = await fetch('/api/drive-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync', id }) })
    const d = await r.json()
    setSyncResult(d.results || [])
    setSyncing(null); load()
  }

  async function remove(id: number) { await fetch(`/api/drive-sync?id=${id}`, { method: 'DELETE' }); load() }

  return (
    <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 20, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Globe size={14} color="#a5b4fc" />
          <span style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>Google Drive Sync</span>
          <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)' }}>— pull files into knowledge base</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {oauthStatus && (
            oauthStatus.connected
              ? <span style={{ fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4 }}>✓ Google Connected
                  <button onClick={async () => { await fetch('/api/drive-sync/oauth?action=disconnect'); checkOauth() }} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.5)', cursor: 'pointer', fontSize: 10, marginLeft: 4 }}>Disconnect</button>
                </span>
              : <button onClick={() => setShowOauthSetup(true)} style={{ padding: '5px 12px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 7, color: '#10b981', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>🔗 Connect Google</button>
          )}
          {configs.length > 0 && <button onClick={() => sync()} disabled={syncing !== null} style={{ padding: '5px 12px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 7, color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>{syncing !== null ? 'Syncing…' : '↻ Sync All'}</button>}
          <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => setShowAdd(true)}
            style={{ padding: '5px 12px', background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 7, color: 'white', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
            <Plus size={10} style={{ display: 'inline', marginRight: 4 }} />Add Folder
          </motion.button>
        </div>
      </div>

      {syncResult.length > 0 && (
        <div style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 8, padding: 10, marginBottom: 12 }}>
          {syncResult.map((r,i) => <p key={i} style={{ color: r.includes('ERROR')?'#f43f5e':'#10b981', fontSize: 12, margin: '2px 0' }}>{r}</p>)}
        </div>
      )}

      {configs.length === 0 && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, textAlign: 'center', margin: 0 }}>No Drive folders connected. Add a folder to auto-sync files into agent knowledge.</p>}
      {configs.map((c:any) => {
        const ag = agents.find((a:Agent) => a.id === c.agent_id)
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid rgba(99,102,241,0.07)' }}>
            <div>
              <span style={{ color: 'white', fontSize: 13 }}>{c.name}</span>
              <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, marginLeft: 8 }}>{ag ? `→ ${ag.name}` : '→ Company KB'}</span>
              {c.last_synced && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, margin: '2px 0 0' }}>Last synced: {new Date(c.last_synced).toLocaleString()}</p>}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => sync(c.id)} disabled={syncing !== null} style={{ padding: '4px 10px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>Sync</button>
              <button onClick={() => remove(c.id)} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}><Trash2 size={12} /></button>
            </div>
          </div>
        )
      })}

      {showAdd && <AddDriveFolderModal agents={agents} onClose={() => { setShowAdd(false); load() }} />}
      {showOauthSetup && <GoogleOAuthSetupModal onClose={() => { setShowOauthSetup(false); checkOauth() }} />}
    </div>
  )
}

function GoogleOAuthSetupModal({ onClose }: { onClose: () => void }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function saveCredentials() {
    if (!clientId.trim() || !clientSecret.trim()) return
    setSaving(true)
    await fetch('/api/drive-sync/oauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    })
    setSaving(false); setSaved(true)
  }

  const inp = { background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' as const }
  const lbl = { color: 'rgba(148,163,184,0.6)', fontSize: 10, marginBottom: 4, display: 'block' as const }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 500, background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Connect Google Drive</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {!saved ? (
          <>
            <div style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 12, color: 'rgba(148,163,184,0.7)', lineHeight: 1.7 }}>
              <strong style={{ color: 'white' }}>Before you start:</strong><br/>
              1. Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" style={{ color: '#a5b4fc' }}>Google Cloud Console → Credentials</a><br/>
              2. Edit your OAuth client → add this redirect URI:<br/>
              <code style={{ background: 'rgba(0,0,0,0.3)', padding: '3px 8px', borderRadius: 4, color: '#c4b5fd', fontSize: 11 }}>https://ai.phoenixhomeremodeling.net/api/drive-sync/oauth</code><br/>
              3. Save, then paste your Client ID and Secret below.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              <div><label style={lbl}>CLIENT ID</label><input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="413578649111-...apps.googleusercontent.com" style={inp} /></div>
              <div><label style={lbl}>CLIENT SECRET</label><input type="password" value={clientSecret} onChange={e => setClientSecret(e.target.value)} placeholder="GOCSPX-..." style={inp} /></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={saveCredentials} disabled={saving || !clientId.trim() || !clientSecret.trim()}
                style={{ flex: 1, padding: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: (!clientId.trim()||!clientSecret.trim())?0.5:1 }}>
                {saving ? 'Saving…' : 'Save Credentials'}
              </motion.button>
              <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ color: '#10b981', fontSize: 15, fontWeight: 600, marginBottom: 12 }}>✓ Credentials saved</p>
            <p style={{ color: 'rgba(148,163,184,0.6)', fontSize: 13, marginBottom: 20 }}>Now click the button below to authorize access to your Google Drive.</p>
            <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              onClick={() => window.location.href = '/api/drive-sync/oauth?action=start'}
              style={{ padding: '12px 32px', background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 10, color: 'white', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
              🔗 Authorize Google Drive Access
            </motion.button>
          </div>
        )}
      </motion.div>
    </div>
  )
}

function AddDriveFolderModal({ agents, onClose, defaultAgentId }: { agents: Agent[]; onClose: () => void; defaultAgentId?: string }) {
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [saJson, setSaJson] = useState('')
  const [agentId, setAgentId] = useState(defaultAgentId || '')
  const [saving, setSaving] = useState(false)
  const [oauthConnected, setOauthConnected] = useState(false)

  useEffect(() => {
    fetch('/api/drive-sync/oauth?action=status')
      .then(r => r.json())
      .then(d => setOauthConnected(d.connected))
      .catch(() => {})
  }, [])

  async function save() {
    if (!name.trim() || !folderId.trim()) return
    if (!oauthConnected && !saJson.trim()) return
    setSaving(true)
    await fetch('/api/drive-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder_id: folderId, service_account_json: saJson || 'oauth', agent_id: agentId || null }),
    })
    setSaving(false); onClose()
  }

  const inp = { background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' as const }
  const lbl = { color: 'rgba(148,163,184,0.6)', fontSize: 10, marginBottom: 4, display: 'block' as const }
  const canSave = name.trim() && folderId.trim() && (oauthConnected || saJson.trim())

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 500, maxHeight: '88vh', overflowY: 'auto', background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 18 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Add Drive Folder</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {oauthConnected && (
          <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: '#10b981' }}>
            ✓ Using your connected Google account — no service account needed
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div><label style={lbl}>NAME</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. PHR Marketing Materials" style={inp} /></div>
          <div>
            <label style={lbl}>GOOGLE DRIVE FOLDER ID</label>
            <input value={folderId} onChange={e => setFolderId(e.target.value)} placeholder="Paste the folder ID from the Drive URL" style={inp} />
            <p style={{ color: 'rgba(148,163,184,0.35)', fontSize: 11, margin: '5px 0 0' }}>
              Open the folder in Google Drive → copy the ID from the URL:<br/>
              drive.google.com/drive/folders/<strong style={{ color: '#a5b4fc' }}>THIS_PART_HERE</strong>
            </p>
          </div>
          <div><label style={lbl}>SYNC INTO</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)} style={{ ...inp, fontFamily: 'inherit' }}>
              <option value="">Company Knowledge Base (all agents)</option>
              {agents.map(a => <option key={a.id} value={a.id} style={{ background: '#0f1623' }}>{a.name} only</option>)}
            </select>
          </div>

          {!oauthConnected && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0' }}>
                <div style={{ flex: 1, height: 1, background: 'rgba(99,102,241,0.15)' }} />
                <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11 }}>OR use service account</span>
                <div style={{ flex: 1, height: 1, background: 'rgba(99,102,241,0.15)' }} />
              </div>
              <div><label style={lbl}>SERVICE ACCOUNT JSON (optional if not using OAuth)</label>
                <textarea value={saJson} onChange={e => setSaJson(e.target.value)} rows={4} placeholder='{"type":"service_account","private_key":"..."}' style={{ ...inp, resize: 'vertical' as const, fontFamily: 'monospace', lineHeight: 1.4 }} />
              </div>
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={save} disabled={saving || !canSave}
            style={{ flex: 1, padding: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: !canSave ? 0.5 : 1 }}>
            {saving ? 'Saving…' : 'Add Folder'}
          </motion.button>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Task Templates Panel ───────────────────────────────────────────────────

function TaskTemplatesPanel({ agent, onUseTemplate }: { agent: Agent; onUseTemplate: (title: string, description: string, type: string) => void }) {
  const [templates, setTemplates] = useState<any[]>([])
  const [showSave, setShowSave] = useState(false)
  const [varModal, setVarModal] = useState<any | null>(null)

  useEffect(() => { load() }, [agent.id])
  async function load() { const r = await fetch(`/api/templates?agent_id=${agent.id}`); if(r.ok) setTemplates(await r.json()) }
  async function remove(id: number) { await fetch(`/api/templates?id=${id}`, { method: 'DELETE' }); load() }

  function use(tpl: any) {
    const vars: string[] = JSON.parse(tpl.variables || '[]')
    if (vars.length) { setVarModal(tpl); return }
    onUseTemplate(tpl.title_template, tpl.description_template, tpl.type)
  }

  return (
    <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(99,102,241,0.1)', marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={14} color="#a5b4fc" />
          <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>Task Templates</span>
        </div>
        <button onClick={() => setShowSave(true)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>
          <Plus size={10} /> Save Template
        </button>
      </div>

      {templates.length === 0 && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, margin: 0 }}>No templates yet. Save a reusable task with {'{{'} {"{{variables}}"} {'}}'} for quick dispatch.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {templates.map((tpl:any) => (
          <div key={tpl.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.1)', borderRadius: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'white', fontSize: 12, fontWeight: 500 }}>{tpl.name}</div>
              <div style={{ color: 'rgba(148,163,184,0.4)', fontSize: 11, marginTop: 1 }}>{tpl.type} · {tpl.title_template.slice(0, 40)}</div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => use(tpl)}
                style={{ padding: '3px 10px', background: `linear-gradient(135deg,${agent.accent_dark},${agent.accent})`, border: 'none', borderRadius: 6, color: 'white', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                Use
              </motion.button>
              <button onClick={() => remove(tpl.id)} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}><Trash2 size={11} /></button>
            </div>
          </div>
        ))}
      </div>

      {showSave && <SaveTemplateModal agent={agent} onClose={() => { setShowSave(false); load() }} />}
      {varModal && <FillVariablesModal template={varModal} onClose={() => setVarModal(null)} onSubmit={(title, desc) => { onUseTemplate(title, desc, varModal.type); setVarModal(null) }} />}
    </div>
  )
}

function SaveTemplateModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [desc, setDesc] = useState('')
  const [type, setType] = useState('general')
  const [saving, setSaving] = useState(false)

  // Hoist extractVars to component scope so JSX can use it too
  const extractVars = (s: string) => { const r: string[] = []; let m; const re = /\{\{(\w+)\}\}/g; while ((m = re.exec(s)) !== null) r.push(m[1]); return r }

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    const vars = Array.from(new Set([...extractVars(title), ...extractVars(desc)]))
    await fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_id: agent.id, name, title_template: title, description_template: desc, type, variables: vars }) })
    setSaving(false); onClose()
  }

  const inp = { background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 12, outline: 'none', width: '100%', boxSizing: 'border-box' as const }
  const lbl = { color: 'rgba(148,163,184,0.6)', fontSize: 10, marginBottom: 4, display: 'block' as const }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 480, background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Save Task Template</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div><label style={lbl}>TEMPLATE NAME</label><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Lead Follow-up Email" style={inp} /></div>
          <div><label style={lbl}>TASK TITLE (use {"{{variable}}"} for dynamic parts)</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Write follow-up for {{lead_name}}" style={inp} /></div>
          <div><label style={lbl}>TASK DESCRIPTION</label><textarea value={desc} onChange={e => setDesc(e.target.value)} rows={4} placeholder={"Write a personalised follow-up email for {{lead_name}} who is interested in {{service}}. Budget: {{budget}}."} style={{ ...inp, resize: 'vertical' as const, lineHeight: 1.5, fontFamily: 'inherit' }} /></div>
          <div><label style={lbl}>TYPE</label>
            <select value={type} onChange={e => setType(e.target.value)} style={{ ...inp, fontFamily: 'inherit' }}>
              {['general','search','browser','code','scrape','file','api'].map(t => <option key={t} value={t} style={{ background: '#0f1623' }}>{t}</option>)}
            </select>
          </div>
          <p style={{ color: 'rgba(99,102,241,0.6)', fontSize: 11, margin: 0 }}>Variables detected: {Array.from(new Set([...extractVars(title), ...extractVars(desc)])).map((v:string) => `{{${v}}}`).join(', ') || 'none'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={save} disabled={saving || !name.trim()}
            style={{ flex: 1, padding: 10, background: `linear-gradient(135deg,${agent.accent_dark},${agent.accent})`, border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            {saving ? 'Saving…' : 'Save Template'}
          </motion.button>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </motion.div>
    </div>
  )
}

function FillVariablesModal({ template, onClose, onSubmit }: { template: any; onClose: () => void; onSubmit: (title: string, desc: string) => void }) {
  const extractVars2 = (s: string) => { const r: string[] = []; let m; const re = /\{\{(\w+)\}\}/g; while ((m = re.exec(s)) !== null) r.push(m[1]); return r }
  const vars: string[] = Array.from(new Set([...extractVars2(template.title_template), ...extractVars2(template.description_template)]))
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(vars.map(v => [v, ''])))

  function submit() {
    let title = template.title_template
    let desc = template.description_template
    for (const [k, v] of Object.entries(values)) {
      title = title.replace(new RegExp(`\{\{${k}\}\}`, 'g'), v)
      desc  = desc.replace(new RegExp(`\{\{${k}\}\}`, 'g'), v)
    }
    onSubmit(title, desc)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400 }}>
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        style={{ width: 420, background: '#0f1623', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 16, padding: 24 }}>
        <div style={{ marginBottom: 16 }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Fill in Variables</span>
          <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, marginTop: 4 }}>{template.name}</p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {vars.map(v => (
            <div key={v}>
              <label style={{ color: 'rgba(148,163,184,0.6)', fontSize: 10, marginBottom: 4, display: 'block', textTransform: 'uppercase' }}>{v.replace(/_/g, ' ')}</label>
              <input value={values[v]} onChange={e => setValues(prev => ({ ...prev, [v]: e.target.value }))} placeholder={`Enter ${v}`}
                style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 10px', color: 'white', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={submit}
            style={{ flex: 1, padding: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 9, color: 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            Run Task
          </motion.button>
          <button onClick={onClose} style={{ padding: '10px 16px', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 9, color: 'rgba(148,163,184,0.5)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </motion.div>
    </div>
  )
}


// ── Per-Agent Google Drive Panel ──────────────────────────────────────────

function AgentDrivePanel({ agent }: { agent: Agent }) {
  const [configs, setConfigs] = useState<any[]>([])
  const [oauthConnected, setOauthConnected] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [syncing, setSyncing] = useState<number | null>(null)
  const [syncMsg, setSyncMsg] = useState<string | null>(null)

  useEffect(() => {
    load()
    fetch('/api/drive-sync/oauth?action=status').then(r => r.json()).then(d => setOauthConnected(d.connected)).catch(() => {})
  }, [agent.id])

  async function load() {
    const r = await fetch('/api/drive-sync')
    if (r.ok) {
      const all = await r.json()
      setConfigs(all.filter((c: any) => c.agent_id === agent.id))
    }
  }

  async function toggle(cfg: any) {
    // Toggle = just remove (simplest approach — re-add to enable)
    if (!window.confirm(`Remove "${cfg.name}" from this agent?`)) return
    await fetch(`/api/drive-sync?id=${cfg.id}`, { method: 'DELETE' })
    load()
  }

  async function sync(id: number) {
    setSyncing(id); setSyncMsg(null)
    const r = await fetch('/api/drive-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sync', id }) })
    const d = await r.json()
    setSyncMsg((d.results || []).join(' · '))
    setSyncing(null)
    setTimeout(() => setSyncMsg(null), 4000)
  }

  return (
    <div style={{ padding: '16px 24px', borderTop: '1px solid rgba(99,102,241,0.1)', marginTop: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Globe size={14} color="#a5b4fc" />
          <span style={{ color: 'white', fontWeight: 600, fontSize: 13 }}>Google Drive Folders</span>
          {oauthConnected
            ? <span style={{ fontSize: 10, color: '#10b981', padding: '1px 7px', borderRadius: 10, background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)' }}>Connected</span>
            : <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)' }}>Not connected — go to Settings</span>
          }
        </div>
        {oauthConnected && (
          <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => setShowAdd(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 9px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 6, color: '#a5b4fc', fontSize: 11, cursor: 'pointer' }}>
            <Plus size={10} /> Add Folder
          </motion.button>
        )}
      </div>

      {syncMsg && <div style={{ padding: '6px 10px', borderRadius: 7, background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', color: '#10b981', fontSize: 11, marginBottom: 10 }}>{syncMsg}</div>}

      {configs.length === 0 && oauthConnected && (
        <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, margin: 0 }}>No Drive folders linked. Add one and files will be injected into every task this agent runs.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {configs.map((cfg: any) => (
          <div key={cfg.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.1)', borderRadius: 8 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ color: 'white', fontSize: 12, fontWeight: 500 }}>{cfg.name}</div>
              {cfg.last_synced && <div style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11 }}>Last synced {new Date(cfg.last_synced).toLocaleString()}</div>}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => sync(cfg.id)} disabled={syncing === cfg.id}
                style={{ padding: '3px 8px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 5, color: '#a5b4fc', fontSize: 10, cursor: 'pointer' }}>
                {syncing === cfg.id ? '…' : '↻ Sync'}
              </button>
              <button onClick={() => toggle(cfg)} style={{ padding: '3px 6px', background: 'transparent', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}><Trash2 size={11} /></button>
            </div>
          </div>
        ))}
      </div>

      {showAdd && <AddDriveFolderModal agents={[agent]} defaultAgentId={agent.id} onClose={() => { setShowAdd(false); load() }} />}
    </div>
  )
}


// ── Projects View ──────────────────────────────────────────────────────────

function ProjectsView({ agents, onSelectAgent }: { agents: Agent[]; onSelectAgent: (a: Agent) => void }) {
  const [projects, setProjects] = useState<any[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [selected, setSelected] = useState<any | null>(null)
  const [projectTasks, setProjectTasks] = useState<Task[]>([])

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/projects'); if(r.ok) setProjects(await r.json()) }
  async function selectProject(p: any) {
    setSelected(p)
    const r = await fetch(`/api/projects?id=${p.id}`)
    if (r.ok) setProjectTasks(await r.json())
  }
  async function remove(id: number) { await fetch(`/api/projects?id=${id}`, { method: 'DELETE' }); load(); if(selected?.id===id) setSelected(null) }
  async function updateStatus(id: number, status: string) { await fetch('/api/projects', { method: 'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id,status}) }); load() }

  const statusColor: Record<string,string> = { active:'#10b981', paused:'#f59e0b', completed:'#6366f1', archived:'rgba(148,163,184,0.4)' }

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>
      {/* Project list */}
      <div style={{ width:280, borderRight:'1px solid rgba(99,102,241,0.1)', display:'flex', flexDirection:'column', background:'rgba(8,12,20,0.6)' }}>
        <div style={{ padding:'16px 16px 10px', borderBottom:'1px solid rgba(99,102,241,0.1)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ color:'white', fontWeight:700, fontSize:15 }}>Projects</span>
          <motion.button whileHover={{scale:1.05}} whileTap={{scale:0.95}} onClick={() => setShowCreate(true)}
            style={{ padding:'4px 10px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:7, color:'white', fontSize:11, fontWeight:600, cursor:'pointer' }}>
            + New
          </motion.button>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:8 }}>
          {projects.length === 0 && <p style={{ color:'rgba(148,163,184,0.3)', fontSize:12, textAlign:'center', padding:'24px 0' }}>No projects yet</p>}
          {projects.map((p:any) => (
            <div key={p.id} onClick={() => selectProject(p)}
              style={{ padding:'10px 12px', borderRadius:10, cursor:'pointer', marginBottom:4, background: selected?.id===p.id ? 'rgba(99,102,241,0.12)' : 'transparent', border:`1px solid ${selected?.id===p.id ? 'rgba(99,102,241,0.25)' : 'transparent'}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:3 }}>
                <div style={{ width:7, height:7, borderRadius:'50%', background: statusColor[p.status] || '#94a3b8', flexShrink:0 }} />
                <span style={{ color:'white', fontSize:13, fontWeight:500 }}>{p.name}</span>
              </div>
              {p.description && <p style={{ color:'rgba(148,163,184,0.4)', fontSize:11, margin:0 }}>{p.description.slice(0,60)}</p>}
              <div style={{ display:'flex', gap:6, marginTop:6 }}>
                {['active','paused','completed'].map(s => (
                  <button key={s} onClick={e => { e.stopPropagation(); updateStatus(p.id, s) }}
                    style={{ padding:'2px 7px', borderRadius:10, fontSize:9, fontWeight:600, cursor:'pointer', background: p.status===s?`${statusColor[s]}20`:'transparent', border:`1px solid ${p.status===s?statusColor[s]:'rgba(148,163,184,0.15)'}`, color: p.status===s?statusColor[s]:'rgba(148,163,184,0.3)' }}>
                    {s}
                  </button>
                ))}
                <button onClick={e => { e.stopPropagation(); remove(p.id) }} style={{ marginLeft:'auto', background:'none', border:'none', color:'rgba(244,63,94,0.3)', cursor:'pointer' }}><Trash2 size={10}/></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Project detail */}
      <div style={{ flex:1, overflowY:'auto', padding:24 }}>
        {!selected ? (
          <div style={{ textAlign:'center', paddingTop:60, color:'rgba(148,163,184,0.3)' }}>
            <GitBranch size={40} style={{ margin:'0 auto 12px', display:'block', opacity:0.2 }} />
            <p>Select a project to view its tasks</p>
          </div>
        ) : (
          <>
            <h2 style={{ color:'white', fontWeight:700, fontSize:20, margin:'0 0 4px' }}>{selected.name}</h2>
            {selected.description && <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, margin:'0 0 20px' }}>{selected.description}</p>}
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {projectTasks.length === 0 && <p style={{ color:'rgba(148,163,184,0.3)', fontSize:13 }}>No tasks in this project yet. Assign tasks to this project from the agent view.</p>}
              {projectTasks.map((t:any) => {
                const ag = agents.find(a => a.id === t.agent_id)
                const dot = t.status==='completed'?'#10b981':t.status==='failed'?'#f43f5e':t.status==='running'?'#6366f1':'#94a3b8'
                return (
                  <div key={t.id} style={{ background:'rgba(15,20,35,0.8)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:12, padding:'12px 16px', cursor:'pointer' }}
                    onClick={() => { if(ag) onSelectAgent(ag) }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                      <div style={{ width:8, height:8, borderRadius:'50%', background:dot, flexShrink:0 }} />
                      <span style={{ color:'white', fontSize:13, fontWeight:500, flex:1 }}>{t.title}</span>
                      {ag && <span style={{ fontSize:10, color:ag.accent }}>{ag.name}</span>}
                      <span style={{ fontSize:10, color:'rgba(148,163,184,0.4)' }}>{new Date(t.created_at).toLocaleDateString()}</span>
                    </div>
                    {t.result && <p style={{ color:'rgba(148,163,184,0.4)', fontSize:12, margin:'6px 0 0', paddingLeft:16 }}>{t.result.slice(0,100)}…</p>}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {showCreate && <CreateProjectModal onClose={() => { setShowCreate(false); load() }} />}
    </div>
  )
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  async function save() {
    if (!name.trim()) return
    setSaving(true)
    await fetch('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, description}) })
    setSaving(false); onClose()
  }
  const inp = { background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 10px', color:'white', fontSize:13, outline:'none', width:'100%', boxSizing:'border-box' as const }
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300 }}>
      <motion.div initial={{opacity:0,scale:0.95}} animate={{opacity:1,scale:1}} style={{ width:420, background:'#0f1623', border:'1px solid rgba(99,102,241,0.2)', borderRadius:16, padding:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:16 }}>
          <span style={{ color:'white', fontWeight:700, fontSize:15 }}>New Project</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'rgba(148,163,184,0.5)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:16 }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Project name" style={inp} />
          <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3} placeholder="Description (optional)" style={{ ...inp, resize:'vertical' as const, lineHeight:1.5, fontFamily:'inherit' }} />
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={save} disabled={saving||!name.trim()}
            style={{ flex:1, padding:10, background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:9, color:'white', fontWeight:600, fontSize:13, cursor:'pointer', opacity:!name.trim()?0.5:1 }}>
            {saving?'Creating…':'Create Project'}
          </motion.button>
          <button onClick={onClose} style={{ padding:'10px 16px', background:'transparent', border:'1px solid rgba(148,163,184,0.15)', borderRadius:9, color:'rgba(148,163,184,0.5)', fontSize:13, cursor:'pointer' }}>Cancel</button>
        </div>
      </motion.div>
    </div>
  )
}

// ── Skills View ─────────────────────────────────────────────────────────────

function SkillsView() {
  const [skills, setSkills] = useState<any[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [testing, setTesting] = useState<number|null>(null)
  const [testResult, setTestResult] = useState<{id:number;ok:boolean;msg:string}|null>(null)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/skills'); if(r.ok) setSkills(await r.json()) }
  async function remove(id: number) { await fetch(`/api/skills?id=${id}`, {method:'DELETE'}); load() }
  async function test(s: any) {
    setTesting(s.id); setTestResult(null)
    const r = await fetch('/api/skills', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({action:'test', base_url:s.base_url, api_key:s.api_key, model:s.model}) })
    const d = await r.json()
    setTestResult({id:s.id, ok:d.ok, msg: d.ok ? `✓ ${d.response}` : `✗ ${d.error}`})
    setTesting(null)
  }

  const PRESETS = [
    { name:'Hermes 3 (Ollama)', base_url:'http://localhost:11434/v1', model:'nous-hermes3', api_key:'ollama' },
    { name:'OpenClaw', base_url:'https://api.openclaw.ai/v1', model:'openclaw-1', api_key:'' },
    { name:'Groq (Llama 3)', base_url:'https://api.groq.com/openai/v1', model:'llama-3.3-70b-versatile', api_key:'' },
    { name:'Together AI', base_url:'https://api.together.xyz/v1', model:'meta-llama/Llama-3-70b-chat-hf', api_key:'' },
  ]

  return (
    <div style={{ padding:24, height:'100%', overflowY:'auto' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <h1 style={{ color:'white', fontWeight:700, fontSize:22, margin:0 }}>Skills</h1>
          <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, margin:'4px 0 0' }}>External AI models agents can call — Hermes, OpenClaw, Groq, and more</p>
        </div>
        <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={() => setShowAdd(true)}
          style={{ display:'flex', alignItems:'center', gap:6, padding:'8px 16px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:9, color:'white', fontWeight:600, fontSize:13, cursor:'pointer' }}>
          <Plus size={14} /> Add Skill
        </motion.button>
      </div>

      {/* Preset quick-adds */}
      <div style={{ marginBottom:20 }}>
        <p style={{ color:'rgba(148,163,184,0.4)', fontSize:11, marginBottom:8 }}>QUICK ADD</p>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {PRESETS.map(p => (
            <button key={p.name} onClick={async () => {
              await fetch('/api/skills', { method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({name:p.name, description:`${p.model} via ${p.base_url}`, base_url:p.base_url, api_key:p.api_key, model:p.model, system_prompt:'', enabled:1}) })
              load()
            }} style={{ padding:'5px 12px', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, color:'#a5b4fc', fontSize:11, cursor:'pointer' }}>
              + {p.name}
            </button>
          ))}
        </div>
      </div>

      {skills.length === 0 && (
        <div style={{ textAlign:'center', padding:'60px 0', color:'rgba(148,163,184,0.3)' }}>
          <Cpu size={40} style={{ margin:'0 auto 12px', display:'block', opacity:0.3 }} />
          <p>No skills yet. Add Hermes, OpenClaw, or any OpenAI-compatible endpoint.</p>
          <p style={{ fontSize:12, marginTop:8 }}>Agents call skills with: {"{{SKILL:skill_name:your prompt}}"}</p>
        </div>
      )}

      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {skills.map((s:any) => (
          <div key={s.id} style={{ background:'rgba(15,20,35,0.8)', border:'1px solid rgba(99,102,241,0.15)', borderRadius:14, padding:18 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
              <div>
                <span style={{ color:'white', fontWeight:600, fontSize:14 }}>{s.name}</span>
                <span style={{ color:'rgba(148,163,184,0.4)', fontSize:11, marginLeft:10 }}>{s.model}</span>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <button onClick={() => test(s)} disabled={testing===s.id} style={{ padding:'4px 10px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:6, color:'#a5b4fc', fontSize:11, cursor:'pointer' }}>
                  {testing===s.id?'…':'▶ Test'}
                </button>
                <button onClick={() => remove(s.id)} style={{ background:'none', border:'none', color:'rgba(244,63,94,0.4)', cursor:'pointer' }}><Trash2 size={12}/></button>
              </div>
            </div>
            <p style={{ color:'rgba(148,163,184,0.4)', fontSize:12, margin:'0 0 6px' }}>{s.base_url}</p>
            <code style={{ fontSize:11, color:'rgba(148,163,184,0.3)', background:'rgba(99,102,241,0.05)', padding:'3px 8px', borderRadius:5, display:'inline-block' }}>
              {"{{SKILL:"}{s.name}{":your prompt}}"}
            </code>
            {testResult && testResult.id===s.id && (
              <div style={{ marginTop:8, padding:'6px 10px', borderRadius:6, background:testResult.ok?'rgba(16,185,129,0.08)':'rgba(244,63,94,0.08)', border:`1px solid ${testResult.ok?'rgba(16,185,129,0.2)':'rgba(244,63,94,0.2)'}`, color:testResult.ok?'#10b981':'#f43f5e', fontSize:11 }}>
                {testResult.msg}
              </div>
            )}
          </div>
        ))}
      </div>

      {showAdd && <AddSkillModal onClose={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddSkillModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [description, setDescription] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim() || !baseUrl.trim() || !model.trim()) return
    setSaving(true)
    await fetch('/api/skills', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({name, description, base_url:baseUrl, api_key:apiKey, model, system_prompt:systemPrompt, enabled:1}) })
    setSaving(false); onClose()
  }
  const inp = { background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 10px', color:'white', fontSize:12, outline:'none', width:'100%', boxSizing:'border-box' as const }
  const lbl = { color:'rgba(148,163,184,0.6)', fontSize:10, marginBottom:4, display:'block' as const }
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:300 }}>
      <motion.div initial={{opacity:0,scale:0.95}} animate={{opacity:1,scale:1}} style={{ width:480, maxHeight:'88vh', overflowY:'auto', background:'#0f1623', border:'1px solid rgba(99,102,241,0.2)', borderRadius:16, padding:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:18 }}>
          <span style={{ color:'white', fontWeight:700, fontSize:15 }}>Add Skill</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'rgba(148,163,184,0.5)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <div><label style={lbl}>NAME</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="e.g. Hermes 3" style={inp}/></div>
          <div><label style={lbl}>DESCRIPTION</label><input value={description} onChange={e=>setDescription(e.target.value)} placeholder="What this skill does" style={inp}/></div>
          <div><label style={lbl}>BASE URL (OpenAI-compatible)</label><input value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" style={inp}/></div>
          <div><label style={lbl}>MODEL</label><input value={model} onChange={e=>setModel(e.target.value)} placeholder="nous-hermes3" style={inp}/></div>
          <div><label style={lbl}>API KEY (if required)</label><input type="password" value={apiKey} onChange={e=>setApiKey(e.target.value)} placeholder="sk-... or leave blank for Ollama" style={inp}/></div>
          <div><label style={lbl}>SYSTEM PROMPT (optional)</label><textarea value={systemPrompt} onChange={e=>setSystemPrompt(e.target.value)} rows={3} placeholder="You are..." style={{ ...inp, resize:'vertical' as const, lineHeight:1.5, fontFamily:'inherit' }}/></div>
        </div>
        <div style={{ display:'flex', gap:8, marginTop:16 }}>
          <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={save} disabled={saving||!name.trim()||!baseUrl.trim()||!model.trim()}
            style={{ flex:1, padding:10, background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:9, color:'white', fontWeight:600, fontSize:13, cursor:'pointer', opacity:(!name.trim()||!baseUrl.trim()||!model.trim())?0.5:1 }}>
            {saving?'Saving…':'Add Skill'}
          </motion.button>
          <button onClick={onClose} style={{ padding:'10px 16px', background:'transparent', border:'1px solid rgba(148,163,184,0.15)', borderRadius:9, color:'rgba(148,163,184,0.5)', fontSize:13, cursor:'pointer' }}>Cancel</button>
        </div>
      </motion.div>
    </div>
  )
}


// ── Hermes Full View ────────────────────────────────────────────────────────

function HermesView({ messages, onSend, loading }: { messages: Message[]; onSend: (text: string) => void; loading: boolean }) {
  const [input, setInput] = useState('')
  const [backend, setBackend] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/hermes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }] }) })
      .then(r => r.json()).then(d => { if (d.backend) setBackend(d.backend) }).catch(() => {})
  }, [])
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  useEffect(() => { inputRef.current?.focus() }, [])

  function send() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    onSend(text)
  }

  const QUICK_ACTIONS = [
    { label: '📊 System status',        prompt: 'Give me a full system overview: agents status, recent tasks, token usage, and any issues.' },
    { label: '🚀 Dispatch task',         prompt: 'I want to dispatch a task. Ask me which agent and what to do.' },
    { label: '🔍 Search tasks',          prompt: 'Search all my past task results for something specific. What should I search for?' },
    { label: '📋 Create pipeline',       prompt: 'Help me create a new pipeline. What agents do you want to chain together?' },
    { label: '📁 Create project',        prompt: 'Help me set up a new project to track a group of related tasks.' },
    { label: '⚙️ Agent help',            prompt: "Which agent should I use for my current task? Describe what you need and I'll recommend." },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg, #080c14)' }}>
      {/* Header */}
      <div style={{ padding: '20px 28px 16px', borderBottom: '1px solid rgba(99,102,241,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'linear-gradient(135deg,#4338ca,#6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>⚡</div>
          <div>
            <h1 style={{ color: 'white', fontWeight: 700, fontSize: 18, margin: 0 }}>Hermes</h1>
            <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, margin: 0 }}>Your AI command center — dispatch tasks, manage agents, get answers</p>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {backend && <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: backend === 'hermes-agent' ? 'rgba(16,185,129,0.12)' : 'rgba(99,102,241,0.12)', color: backend === 'hermes-agent' ? '#10b981' : '#a5b4fc', border: `1px solid ${backend === 'hermes-agent' ? 'rgba(16,185,129,0.25)' : 'rgba(99,102,241,0.25)'}` }}>{backend === 'hermes-agent' ? '⚡ Hermes Agent' : 'GPT-5.4'}</span>}
            {loading && <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              {[0,1,2].map(i => <motion.div key={i} animate={{ opacity:[0.3,1,0.3] }} transition={{ repeat:Infinity, duration:1.2, delay:i*0.2 }} style={{ width:5, height:5, borderRadius:'50%', background:'#6366f1' }} />)}
            </div>}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Welcome state */}
        {messages.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '40px 20px' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚡</div>
            <h2 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: '0 0 8px' }}>How can I help?</h2>
            <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 14, maxWidth: 400, margin: '0 0 32px' }}>
              I can dispatch tasks to your agents, create pipelines, search past results, and manage your entire system.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, width: '100%', maxWidth: 500 }}>
              {QUICK_ACTIONS.map(a => (
                <motion.button key={a.label} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={() => { onSend(a.prompt) }}
                  style={{ padding: '10px 14px', background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 10, color: 'rgba(148,163,184,0.8)', fontSize: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                  {a.label}
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* Conversation */}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 10, alignItems: 'flex-start' }}>
            {m.role === 'assistant' && (
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#4338ca,#6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0, marginTop: 2 }}>⚡</div>
            )}
            <div style={{ maxWidth: '75%', padding: '10px 14px', borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '4px 14px 14px 14px', background: m.role === 'user' ? 'linear-gradient(135deg,#4338ca,#6366f1)' : 'rgba(15,20,35,0.9)', border: m.role === 'assistant' ? '1px solid rgba(99,102,241,0.12)' : 'none', color: 'white', fontSize: 13.5, lineHeight: 1.6 }}>
              {m.role === 'assistant' ? <Markdown text={m.content} /> : m.content}
            </div>
          </div>
        ))}

        {loading && messages.length > 0 && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#4338ca,#6366f1)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>⚡</div>
            <div style={{ padding: '10px 14px', borderRadius: '4px 14px 14px 14px', background: 'rgba(15,20,35,0.9)', border: '1px solid rgba(99,102,241,0.12)', display: 'flex', gap: 5 }}>
              {[0,1,2].map(i => <motion.div key={i} animate={{ opacity:[0.3,1,0.3] }} transition={{ repeat:Infinity, duration:1.2, delay:i*0.2 }} style={{ width:6, height:6, borderRadius:'50%', background:'#6366f1' }} />)}
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 20px 20px', borderTop: '1px solid rgba(99,102,241,0.1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 8, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 14, padding: '8px 8px 8px 16px', alignItems: 'center' }}>
          <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Message Hermes… (dispatch tasks, manage agents, search results)"
            style={{ flex: 1, background: 'none', border: 'none', color: 'white', fontSize: 14, outline: 'none', lineHeight: 1.5 }} />
          <motion.button whileTap={{ scale: 0.9 }} onClick={send} disabled={loading || !input.trim()}
            style={{ width: 36, height: 36, borderRadius: 10, background: input.trim() ? 'linear-gradient(135deg,#4338ca,#6366f1)' : 'rgba(99,102,241,0.1)', border: 'none', color: 'white', cursor: input.trim() ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, opacity: loading ? 0.5 : 1, transition: 'all 0.15s' }}>
            <Send size={15} />
          </motion.button>
        </div>
        <p style={{ color: 'rgba(148,163,184,0.25)', fontSize: 11, margin: '6px 0 0', textAlign: 'center' }}>Hermes can dispatch tasks, create pipelines, and control your agents</p>
      </div>
    </div>
  )
}


// ── Prompt Version History ────────────────────────────────────────────────

function PromptVersionHistory({ agent }: { agent: Agent }) {
  const [versions, setVersions] = useState<any[]>([])
  const [preview, setPreview] = useState<any | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [open, setOpen] = useState(false)

  async function load() {
    const r = await fetch(`/api/agents/${agent.id}/versions`)
    if (r.ok) setVersions(await r.json())
  }

  async function restore(v: any) {
    setRestoring(true)
    await fetch(`/api/agents/${agent.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: v.prompt }),
    })
    setRestoring(false)
    setPreview(null)
    setOpen(false)
  }

  return (
    <div style={{ padding: '8px 24px 0' }}>
      <button onClick={() => { setOpen(o => !o); if (!open) load() }}
        style={{ background: 'none', border: 'none', color: 'rgba(148,163,184,0.4)', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
        <SlidersHorizontal size={11} /> {open ? 'Hide' : 'Version history'}
      </button>
      {open && (
        <div style={{ marginTop: 8, background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)', borderRadius: 10, overflow: 'hidden' }}>
          {versions.length === 0 && <p style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, padding: '10px 14px', margin: 0 }}>No versions saved yet</p>}
          {versions.map((v:any) => (
            <div key={v.id} style={{ padding: '8px 14px', borderBottom: '1px solid rgba(99,102,241,0.07)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ color: 'rgba(148,163,184,0.5)', fontSize: 11 }}>{new Date(v.created_at).toLocaleString()}</span>
                {v.note && <span style={{ color: '#a5b4fc', fontSize: 11, marginLeft: 8 }}>{v.note}</span>}
                <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 11, margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.prompt.slice(0, 80)}</p>
              </div>
              <button onClick={() => setPreview(preview?.id === v.id ? null : v)}
                style={{ padding: '3px 8px', background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 5, color: '#a5b4fc', fontSize: 10, cursor: 'pointer' }}>
                {preview?.id === v.id ? 'Hide' : 'Preview'}
              </button>
              <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }} onClick={() => restore(v)} disabled={restoring}
                style={{ padding: '3px 8px', background: `${agent.accent}20`, border: `1px solid ${agent.accent}40`, borderRadius: 5, color: agent.accent, fontSize: 10, cursor: 'pointer' }}>
                Restore
              </motion.button>
            </div>
          ))}
          {preview && (
            <div style={{ padding: '10px 14px', background: 'rgba(0,0,0,0.2)' }}>
              <p style={{ color: 'rgba(148,163,184,0.4)', fontSize: 10, margin: '0 0 4px' }}>PREVIEW</p>
              <pre style={{ color: 'rgba(148,163,184,0.7)', fontSize: 11, whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.6 }}>{preview.prompt}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Output Templates Panel ────────────────────────────────────────────────

function OutputTemplatesPanel() {
  const [templates, setTemplates] = useState<any[]>([])
  const [name, setName] = useState('')
  const [format, setFormat] = useState('markdown')
  const [tmpl, setTmpl] = useState(`# {{title}}\n\n{{result}}\n\n---\n*Generated by {{agent}} on {{date}}*`)
  const [saving, setSaving] = useState(false)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/output-templates'); if(r.ok) setTemplates(await r.json()) }
  async function create() {
    if (!name.trim()) return
    setSaving(true)
    await fetch('/api/output-templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, format, template: tmpl }) })
    setName(''); setSaving(false); load()
  }
  async function remove(id: number) { await fetch(`/api/output-templates?id=${id}`, { method: 'DELETE' }); load() }

  const inp = { background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 10px', color:'white', fontSize:12, outline:'none', width:'100%', boxSizing:'border-box' as const }

  return (
    <div style={{ background:'rgba(15,20,35,0.8)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:20, marginBottom:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
        <Layers size={14} color="#a5b4fc" />
        <span style={{ color:'white', fontWeight:600, fontSize:14 }}>Output Templates</span>
        <span style={{ fontSize:11, color:'rgba(148,163,184,0.4)' }}>— format task results automatically</span>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:12 }}>
        <div style={{ display:'flex', gap:8 }}>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="Template name" style={{ ...inp, flex:1 }}/>
          <select value={format} onChange={e=>setFormat(e.target.value)} style={{ ...inp, width:120, flex:'none', fontFamily:'inherit' }}>
            <option value="markdown" style={{background:'#0f1623'}}>Markdown</option>
            <option value="structured" style={{background:'#0f1623'}}>Structured</option>
            <option value="json" style={{background:'#0f1623'}}>JSON</option>
          </select>
        </div>
        <textarea value={tmpl} onChange={e=>setTmpl(e.target.value)} rows={4}
          style={{ ...inp, resize:'vertical' as const, lineHeight:1.5, fontFamily:'monospace', fontSize:11 }} />
        <p style={{ color:'rgba(148,163,184,0.3)', fontSize:10, margin:0 }}>Variables: {"{{result}}"} {"{{title}}"} {"{{agent}}"} {"{{date}}"}</p>
        <motion.button whileHover={{scale:1.01}} whileTap={{scale:0.98}} onClick={create} disabled={saving||!name.trim()}
          style={{ padding:'8px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:8, color:'white', fontSize:12, fontWeight:600, cursor:'pointer', opacity:!name.trim()?0.5:1 }}>
          {saving?'Saving…':'Save Template'}
        </motion.button>
      </div>
      {templates.length === 0 && <p style={{ color:'rgba(148,163,184,0.3)', fontSize:12, textAlign:'center', margin:0 }}>No templates yet</p>}
      {templates.map((t:any) => (
        <div key={t.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 0', borderBottom:'1px solid rgba(99,102,241,0.07)' }}>
          <div>
            <span style={{ color:'white', fontSize:13 }}>{t.name}</span>
            <span style={{ color:'rgba(148,163,184,0.3)', fontSize:11, marginLeft:8 }}>{t.format}</span>
          </div>
          <button onClick={()=>remove(t.id)} style={{ background:'none', border:'none', color:'rgba(244,63,94,0.4)', cursor:'pointer' }}><Trash2 size={12}/></button>
        </div>
      ))}
    </div>
  )
}

// ── Pending Approvals Badge + Modal ────────────────────────────────────────

function PendingApprovalsBadge({ onClick }: { onClick: () => void }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const check = async () => { const r = await fetch('/api/approvals'); if(r.ok) { const d = await r.json(); setCount(d.length) } }
    check()
    const interval = setInterval(check, 15000)
    return () => clearInterval(interval)
  }, [])
  if (count === 0) return null
  return (
    <motion.button whileHover={{scale:1.05}} whileTap={{scale:0.95}} onClick={onClick}
      style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 10px', background:'rgba(245,158,11,0.12)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:8, color:'#fcd34d', fontSize:12, fontWeight:600, cursor:'pointer', flexShrink:0 }}>
      ⏳ {count} approval{count > 1 ? 's' : ''} waiting
    </motion.button>
  )
}

function ApprovalsModal({ onClose }: { onClose: () => void }) {
  const [approvals, setApprovals] = useState<any[]>([])
  const [notes, setNotes] = useState<Record<number,string>>({})
  const [acting, setActing] = useState<number|null>(null)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/approvals'); if(r.ok) setApprovals(await r.json()) }

  async function act(id: number, action: 'approve'|'reject') {
    setActing(id)
    await fetch('/api/approvals', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ approval_id: id, action, note: notes[id] || '' }) })
    setActing(null)
    load()
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:400 }}>
      <motion.div initial={{opacity:0,scale:0.95}} animate={{opacity:1,scale:1}}
        style={{ width:560, maxHeight:'80vh', overflowY:'auto', background:'#0f1623', border:'1px solid rgba(245,158,11,0.25)', borderRadius:16, padding:24 }}>
        <div style={{ display:'flex', justifyContent:'space-between', marginBottom:18 }}>
          <span style={{ color:'white', fontWeight:700, fontSize:15 }}>⏳ Pending Approvals</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'rgba(148,163,184,0.5)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        {approvals.length === 0 && <p style={{ color:'rgba(148,163,184,0.4)', textAlign:'center', padding:'20px 0' }}>No pending approvals</p>}
        {approvals.map((a:any) => (
          <div key={a.id} style={{ background:'rgba(245,158,11,0.05)', border:'1px solid rgba(245,158,11,0.15)', borderRadius:12, padding:16, marginBottom:12 }}>
            <div style={{ marginBottom:8 }}>
              <span style={{ color:'white', fontWeight:600, fontSize:14 }}>{a.step_title}</span>
              <span style={{ color:'rgba(148,163,184,0.4)', fontSize:11, marginLeft:8 }}>{a.pipeline_name}</span>
            </div>
            {a.step_context && (
              <div style={{ background:'rgba(0,0,0,0.3)', borderRadius:8, padding:'8px 10px', marginBottom:10, fontSize:12, color:'rgba(148,163,184,0.6)', maxHeight:100, overflowY:'auto' }}>
                {a.step_context}
              </div>
            )}
            <input value={notes[a.id]||''} onChange={e=>setNotes(n=>({...n,[a.id]:e.target.value}))}
              placeholder="Optional note (reason for approval/rejection)"
              style={{ background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, padding:'6px 10px', color:'white', fontSize:12, outline:'none', width:'100%', boxSizing:'border-box', marginBottom:10 }}/>
            <div style={{ display:'flex', gap:8 }}>
              <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={()=>act(a.id,'approve')} disabled={acting===a.id}
                style={{ flex:1, padding:'8px', background:'rgba(16,185,129,0.15)', border:'1px solid rgba(16,185,129,0.3)', borderRadius:8, color:'#10b981', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                {acting===a.id?'…':'✓ Approve'}
              </motion.button>
              <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={()=>act(a.id,'reject')} disabled={acting===a.id}
                style={{ flex:1, padding:'8px', background:'rgba(244,63,94,0.1)', border:'1px solid rgba(244,63,94,0.25)', borderRadius:8, color:'#f43f5e', fontWeight:600, fontSize:13, cursor:'pointer' }}>
                ✕ Reject
              </motion.button>
            </div>
          </div>
        ))}
      </motion.div>
    </div>
  )
}


// ── MCD Reports View ──────────────────────────────────────────────────────

interface McdReport {
  id: number
  report_type: string
  period_start: string
  period_end: string
  content: string
  delivered_gchat: number
  email_sent: number
  created_at: string
}

// ── MCD Chat View ─────────────────────────────────────────────────────────

interface McdChatMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: string[]
  loading?: boolean
}

const MCD_QUICK_PROMPTS = [
  "How many leads did we get this week?",
  "What's our Discovery Call conversion rate?",
  "What should I focus on today?",
  "Show me pipeline status",
  "How's our organic traffic trending?",
  "What are the top performing lead sources?",
]

function McdChatView() {
  const [messages, setMessages]     = useState<McdChatMessage[]>([])
  const [input, setInput]           = useState('')
  const [loading, setLoading]       = useState(false)
  const bottomRef                   = useRef<HTMLDivElement>(null)
  const inputRef                    = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function renderMcd(text: string) {
    return text.split('\n').map((line, i) => {
      if (line.startsWith('## '))  return <div key={i} style={{ fontSize:13, fontWeight:700, color:'#a5b4fc', marginTop:14, marginBottom:5, borderBottom:'1px solid rgba(99,102,241,0.15)', paddingBottom:3 }}>{line.slice(3)}</div>
      if (line.startsWith('### ')) return <div key={i} style={{ fontSize:12, fontWeight:600, color:'#94a3b8', marginTop:10, marginBottom:3 }}>{line.slice(4)}</div>
      if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} style={{ fontSize:13, color:'rgba(203,213,225,0.9)', lineHeight:1.7, paddingLeft:12, position:'relative' }}><span style={{position:'absolute',left:0,color:'#6366f1'}}>•</span>{line.slice(2)}</div>
      if (line.trim() === '') return <div key={i} style={{ height:6 }} />
      const parts = line.split(/(\*\*[^*]+\*\*)/g)
      return (
        <div key={i} style={{ fontSize:13, color:'rgba(203,213,225,0.9)', lineHeight:1.8 }}>
          {parts.map((p,j) => p.startsWith('**') && p.endsWith('**')
            ? <strong key={j} style={{ color:'white', fontWeight:600 }}>{p.slice(2,-2)}</strong>
            : p)}
        </div>
      )
    })
  }

  async function send(msg?: string) {
    const text = (msg ?? input).trim()
    if (!text || loading) return
    setInput('')

    const userMsg: McdChatMessage = { role: 'user', content: text }
    const history = messages.filter(m => !m.loading).map(m => ({ role: m.role, content: m.content }))
    const placeholder: McdChatMessage = { role: 'assistant', content: '', loading: true, sources: [] }

    setMessages(prev => [...prev, userMsg, placeholder])
    setLoading(true)

    try {
      const res = await fetch('/api/mcd/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''
      let   sources: string[] = []
      let   full    = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break
          try {
            const ev = JSON.parse(raw)
            if (ev.type === 'sources') { sources = ev.sources || [] }
            if (ev.type === 'delta')   {
              full += ev.content
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last?.loading) next[next.length - 1] = { ...last, content: full, sources, loading: true }
                return next
              })
            }
          } catch {}
        }
      }

      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.loading) next[next.length - 1] = { role: 'assistant', content: full || '(no response)', sources }
        return next
      })
    } catch (e: any) {
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last?.loading) next[next.length - 1] = { role: 'assistant', content: `Error: ${e.message}`, sources: [] }
        return next
      })
    } finally {
      setLoading(false)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', background:'#080c14' }}>
      {/* Header */}
      <div style={{ padding:'12px 22px', borderBottom:'1px solid rgba(99,102,241,0.1)', background:'rgba(15,20,35,0.97)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:18 }}>💬</span>
          <div>
            <div style={{ color:'white', fontWeight:700, fontSize:15 }}>Ask MCD</div>
            <div style={{ color:'rgba(148,163,184,0.5)', fontSize:11 }}>Live data from GHL, GA4, GSC · Responds in MCD&apos;s voice</div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:'auto', padding:'20px 22px', display:'flex', flexDirection:'column', gap:16 }}>
        {messages.length === 0 && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:24, paddingBottom:40 }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:36, marginBottom:8 }}>📊</div>
              <div style={{ color:'white', fontWeight:700, fontSize:17, marginBottom:4 }}>Marketing Director, at your service</div>
              <div style={{ color:'rgba(148,163,184,0.5)', fontSize:13 }}>Ask me anything about leads, traffic, conversions, or what to focus on.</div>
            </div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:8, justifyContent:'center', maxWidth:560 }}>
              {MCD_QUICK_PROMPTS.map((p, i) => (
                <button key={i} onClick={() => send(p)}
                  style={{ padding:'7px 13px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:20, color:'rgba(165,180,252,0.85)', fontSize:12, cursor:'pointer', transition:'all 0.1s' }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.background='rgba(99,102,241,0.2)' }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.background='rgba(99,102,241,0.1)' }}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} style={{ display:'flex', gap:12, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row', alignItems:'flex-start' }}>
            {/* Avatar */}
            <div style={{ width:30, height:30, borderRadius:'50%', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:700,
              background: msg.role === 'user' ? 'rgba(99,102,241,0.25)' : 'rgba(59,130,246,0.2)',
              color:       msg.role === 'user' ? '#a5b4fc'               : '#93c5fd',
              border:      msg.role === 'user' ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(59,130,246,0.25)',
            }}>
              {msg.role === 'user' ? 'J' : 'M'}
            </div>

            <div style={{ maxWidth:'75%', display:'flex', flexDirection:'column', gap:4 }}>
              {/* Sources badge */}
              {msg.sources && msg.sources.length > 0 && (
                <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                  {msg.sources.map((s,j) => (
                    <span key={j} style={{ fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:4, background:'rgba(16,185,129,0.1)', color:'#34d399', border:'1px solid rgba(16,185,129,0.2)' }}>
                      {s}
                    </span>
                  ))}
                </div>
              )}

              {/* Bubble */}
              <div style={{
                padding:'10px 14px', borderRadius: msg.role === 'user' ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
                background: msg.role === 'user' ? 'rgba(99,102,241,0.15)' : 'rgba(15,23,42,0.8)',
                border:     msg.role === 'user' ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(99,102,241,0.1)',
                lineHeight: 1.6,
              }}>
                {msg.role === 'user'
                  ? <span style={{ fontSize:13, color:'rgba(203,213,225,0.9)' }}>{msg.content}</span>
                  : msg.loading && !msg.content
                    ? <div style={{ display:'flex', gap:6, alignItems:'center', padding:'2px 0' }}>
                        <span style={{ fontSize:13, color:'rgba(99,102,241,0.6)' }}>⏳</span>
                        <span style={{ fontSize:11, color:'rgba(148,163,184,0.4)' }}>Pulling live data...</span>
                      </div>
                    : renderMcd(msg.content)
                }
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding:'12px 22px 16px', borderTop:'1px solid rgba(99,102,241,0.1)', background:'rgba(10,15,28,0.95)', flexShrink:0 }}>
        {messages.length > 0 && (
          <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:10 }}>
            {MCD_QUICK_PROMPTS.slice(0,3).map((p,i) => (
              <button key={i} onClick={() => send(p)} disabled={loading}
                style={{ padding:'4px 10px', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.15)', borderRadius:14, color:'rgba(148,163,184,0.6)', fontSize:11, cursor:loading?'not-allowed':'pointer' }}>
                {p}
              </button>
            ))}
          </div>
        )}
        <div style={{ display:'flex', gap:10, alignItems:'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={loading}
            placeholder="Ask MCD anything... (Enter to send, Shift+Enter for new line)"
            rows={1}
            style={{ flex:1, background:'rgba(15,20,35,0.8)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:10, color:'white', fontSize:13, padding:'10px 14px', resize:'none', outline:'none', fontFamily:'inherit', minHeight:42, maxHeight:120, overflowY:'auto', lineHeight:1.5 }}
          />
          <button
            onClick={() => send()}
            disabled={loading || !input.trim()}
            style={{ padding:'10px 18px', background: loading || !input.trim() ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.85)', border:'1px solid rgba(99,102,241,0.4)', borderRadius:10, color: loading || !input.trim() ? 'rgba(165,180,252,0.4)' : 'white', fontSize:13, fontWeight:600, cursor: loading || !input.trim() ? 'not-allowed' : 'pointer', flexShrink:0, height:42 }}>
            {loading ? '⏳' : '↑ Send'}
          </button>
        </div>
        <div style={{ fontSize:10, color:'rgba(148,163,184,0.3)', marginTop:6, textAlign:'center' }}>
          Fetches live data from GHL, GA4 &amp; GSC · Powered by GPT-5.4 mini in MCD voice
        </div>
      </div>

    </div>
  )
}

function McdReportsView() {
  const [reports, setReports]       = useState<McdReport[]>([])
  const [selected, setSelected]     = useState<McdReport | null>(null)
  const [loading, setLoading]       = useState(true)
  const [running, setRunning]       = useState(false)
  const [runMsg, setRunMsg]         = useState('')
  const [pollTimer, setPollTimer]   = useState<ReturnType<typeof setInterval> | null>(null)
  const [sendingEmail, setSendingEmail] = useState(false)
  const [emailMsg, setEmailMsg]     = useState('')
  const [activeTab, setActiveTab]   = useState<'reports' | 'chat'>('reports')

  const fetchReports = async () => {
    try {
      const r = await fetch('/api/mcd/reports?limit=20')
      const d = await r.json()
      if (d.reports) {
        setReports(d.reports)
        if (!selected && d.reports.length > 0) setSelected(d.reports[0])
        // Update selected if a new one appeared
        if (selected && d.reports[0]?.id !== selected.id) setSelected(d.reports[0])
      }
    } catch {}
    setLoading(false)
  }

  useEffect(() => {
    fetchReports()
    return () => { if (pollTimer) clearInterval(pollTimer) }
  }, [])

  async function handleSendEmail() {
    if (!selected) return
    setSendingEmail(true)
    setEmailMsg('Sending email...')
    try {
      const r = await fetch('/api/mcd/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report_id: selected.id }),
      })
      const d = await r.json()
      if (d.ok) {
        setEmailMsg(`✓ Sent: ${d.subject || 'Email delivered'}`)
        // Update the selected report's email_sent flag locally
        setSelected(prev => prev ? { ...prev, email_sent: 1 } : prev)
        setReports(prev => prev.map(rpt => rpt.id === selected.id ? { ...rpt, email_sent: 1 } : rpt))
      } else {
        setEmailMsg(`✗ ${d.error || 'Failed to send email'}`)
      }
    } catch (e: any) {
      setEmailMsg('✗ Error: ' + e.message)
    } finally {
      setSendingEmail(false)
      setTimeout(() => setEmailMsg(''), 8000)
    }
  }

  async function handleRunNow() {
    setRunning(true)
    setRunMsg('Queuing report run...')
    try {
      const r = await fetch('/api/mcd/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'run' }) })
      const d = await r.json()
      setRunMsg(d.message || 'Report queued. Refreshing every 15s...')
      // Poll for new report
      const t = setInterval(fetchReports, 15000)
      setPollTimer(t)
      setTimeout(() => { clearInterval(t); setPollTimer(null); setRunning(false) }, 300000)
    } catch (e: any) {
      setRunMsg('Error: ' + e.message)
      setRunning(false)
    }
  }

  const fmtDate = (s: string) => {
    try { return new Date(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) }
    catch { return s }
  }

  const typeColor: Record<string, string> = {
    weekly: '#6366f1', monthly: '#8b5cf6', quarterly: '#06b6d4', daily: '#10b981', manual: '#f59e0b',
  }

  // Simple markdown-to-JSX: bold headers and line breaks
  function renderReport(text: string) {
    return text.split('\n').map((line, i) => {
      if (line.startsWith('## ')) return <div key={i} style={{ fontSize: 14, fontWeight: 700, color: '#a5b4fc', marginTop: 18, marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid rgba(99,102,241,0.15)' }}>{line.slice(3)}</div>
      if (line.startsWith('### ')) return <div key={i} style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginTop: 12, marginBottom: 4 }}>{line.slice(4)}</div>
      if (line.startsWith('# '))  return <div key={i} style={{ fontSize: 16, fontWeight: 700, color: 'white', marginTop: 8, marginBottom: 10 }}>{line.slice(2)}</div>
      if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} style={{ fontSize: 12, color: 'rgba(203,213,225,0.85)', lineHeight: 1.7, paddingLeft: 14, position: 'relative' }}><span style={{ position:'absolute', left:2 }}>•</span>{line.slice(2)}</div>
      if (line.match(/^\d+\./)) return <div key={i} style={{ fontSize: 12, color: 'rgba(203,213,225,0.85)', lineHeight: 1.7, paddingLeft: 20 }}>{line}</div>
      if (line.trim() === '') return <div key={i} style={{ height: 8 }} />
      // Inline bold
      const parts = line.split(/(\*\*[^*]+\*\*)/g)
      return (
        <div key={i} style={{ fontSize: 12, color: 'rgba(203,213,225,0.85)', lineHeight: 1.8 }}>
          {parts.map((p, j) => p.startsWith('**') && p.endsWith('**')
            ? <strong key={j} style={{ color: 'white', fontWeight: 600 }}>{p.slice(2,-2)}</strong>
            : p)}
        </div>
      )
    })
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#080c14' }}>
      {/* Top bar */}
      <div style={{ padding: '12px 22px', borderBottom: '1px solid rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(15,20,35,0.97)', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16 }}>📊</span>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>MCD Reports</span>
          <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.5)', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)', padding: '1px 7px', borderRadius: 10 }}>Marketing &amp; Conversions Director</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Tab toggle */}
          <div style={{ display: 'flex', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 8, padding: 2, marginRight: 4 }}>
            <button onClick={() => setActiveTab('reports')}
              style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: activeTab === 'reports' ? 'rgba(99,102,241,0.25)' : 'transparent', color: activeTab === 'reports' ? '#a5b4fc' : 'rgba(148,163,184,0.5)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              📊 Reports
            </button>
            <button onClick={() => setActiveTab('chat')}
              style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: activeTab === 'chat' ? 'rgba(99,102,241,0.25)' : 'transparent', color: activeTab === 'chat' ? '#a5b4fc' : 'rgba(148,163,184,0.5)', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
              💬 Ask MCD
            </button>
          </div>
          <button
            onClick={handleSendEmail}
            disabled={sendingEmail || !selected}
            title={selected ? `Send report #${selected.id} via email` : 'Select a report first'}
            style={{ padding: '6px 14px', background: sendingEmail ? 'rgba(16,185,129,0.08)' : 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 8, color: (sendingEmail || !selected) ? 'rgba(52,211,153,0.4)' : '#34d399', fontSize: 12, fontWeight: 600, cursor: (sendingEmail || !selected) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            {sendingEmail ? '⏳ Sending...' : '✉ Send Email'}
          </button>
          <button
            onClick={handleRunNow}
            disabled={running}
            style={{ padding: '6px 14px', background: running ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.2)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 8, color: running ? 'rgba(165,180,252,0.5)' : '#a5b4fc', fontSize: 12, fontWeight: 600, cursor: running ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            {running ? '⏳ Running...' : '▶ Run Now'}
          </button>
        </div>
      </div>

      {runMsg && (
        <div style={{ margin: '10px 22px', padding: '8px 14px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, fontSize: 12, color: '#a5b4fc' }}>
          {runMsg}
        </div>
      )}
      {emailMsg && (
        <div style={{ margin: emailMsg && runMsg ? '0 22px 10px' : '10px 22px', padding: '8px 14px', background: emailMsg.startsWith('✓') ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)', border: `1px solid ${emailMsg.startsWith('✓') ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'}`, borderRadius: 8, fontSize: 12, color: emailMsg.startsWith('✓') ? '#34d399' : '#f87171' }}>
          {emailMsg}
        </div>
      )}

      {activeTab === 'chat' ? (
        <div style={{ flex: 1, height: 'calc(100% - 56px)', display: 'flex', flexDirection: 'column' }}>
          <McdChatView />
        </div>
      ) : (
      <div style={{ display: 'flex', gap: 0, height: 'calc(100% - 56px)' }}>
        {/* Left: report list */}
        <div style={{ width: 240, flexShrink: 0, borderRight: '1px solid rgba(99,102,241,0.1)', overflowY: 'auto', padding: '12px 0' }}>
          {loading && <div style={{ padding: '20px', color: 'rgba(148,163,184,0.4)', fontSize: 12, textAlign: 'center' }}>Loading...</div>}
          {!loading && reports.length === 0 && (
            <div style={{ padding: '20px 16px', color: 'rgba(148,163,184,0.4)', fontSize: 12, textAlign: 'center', lineHeight: 1.6 }}>
              No reports yet.<br /><br />
              Reports run automatically Monday 7:30 AM Phoenix time, or click "Run Now" above.
            </div>
          )}
          {reports.map(r => (
            <div key={r.id} onClick={() => setSelected(r)}
              style={{ padding: '10px 14px', cursor: 'pointer', borderLeft: selected?.id === r.id ? '2px solid #6366f1' : '2px solid transparent', background: selected?.id === r.id ? 'rgba(99,102,241,0.08)' : 'transparent', transition: 'all 0.1s' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' as const }}>
                <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 4, background: `${typeColor[r.report_type] || '#6366f1'}22`, color: typeColor[r.report_type] || '#6366f1', textTransform: 'uppercase' as const }}>
                  {r.report_type}
                </span>
                {r.delivered_gchat ? <span title="Delivered to Google Chat" style={{ fontSize: 9, color: '#10b981' }}>✓ Chat</span> : null}
                {r.email_sent ? <span title="Sent via email" style={{ fontSize: 9, color: '#34d399' }}>✉ Email</span> : null}
              </div>
              <div style={{ fontSize: 12, color: 'rgba(203,213,225,0.8)', fontWeight: 500 }}>{fmtDate(r.period_start)}</div>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)' }}>through {fmtDate(r.period_end)}</div>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.3)', marginTop: 2 }}>{new Date(r.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>

        {/* Right: report content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
          {!selected && !loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'rgba(148,163,184,0.3)', fontSize: 14 }}>
              Select a report to read it
            </div>
          )}
          {selected && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 5, background: `${typeColor[selected.report_type] || '#6366f1'}22`, color: typeColor[selected.report_type] || '#6366f1', textTransform: 'uppercase' as const }}>
                  {selected.report_type} report
                </span>
                <span style={{ fontSize: 12, color: 'rgba(148,163,184,0.5)' }}>
                  {fmtDate(selected.period_start)} &rarr; {fmtDate(selected.period_end)}
                </span>
                {selected.delivered_gchat
                  ? <span style={{ fontSize: 10, color: '#10b981', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)', padding: '1px 7px', borderRadius: 10 }}>✓ Google Chat</span>
                  : <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', background: 'rgba(148,163,184,0.05)', border: '1px solid rgba(148,163,184,0.1)', padding: '1px 7px', borderRadius: 10 }}>Not delivered</span>}
                {selected.email_sent
                  ? <span style={{ fontSize: 10, color: '#34d399', background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.2)', padding: '1px 7px', borderRadius: 10 }}>✉ Email sent</span>
                  : null}
              </div>
              <div style={{ background: 'rgba(15,20,35,0.6)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: '20px 24px', lineHeight: 1.75 }}>
                {renderReport(selected.content)}
              </div>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  )
}

// ── Email Health Report View ───────────────────────────────────────────────

const ACTION_BADGE_COLORS: Record<string,string> = { high:'#f43f5e', medium:'#f59e0b', low:'#06b6d4' }
function ActionBadge({ level }: { level: string }) {
  const c = ACTION_BADGE_COLORS[level] || '#6366f1'
  const s: React.CSSProperties = { padding:'1px 6px', borderRadius:4, background:c+'20', border:'1px solid '+c+'40', color:c, fontSize:9, fontWeight:700, textTransform:'uppercase', marginRight:6 }
  return <span style={s}>{level}</span>
}

function EmailHealthReportView() {
  const currentMonth = new Date().toISOString().slice(0,7)
  const [availableMonths, setAvailableMonths] = useState<{month:string;label:string}[]>([])
  const [selectedMonth, setSelectedMonth] = useState('')
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<any | null>(null)
  const [reportGeneratedAt, setReportGeneratedAt] = useState<string|null>(null)
  const [error, setError] = useState('')
  const [postmasterData, setPostmasterData] = useState<any | null>(null)
  const [postmasterConnected, setPostmasterConnected] = useState(false)
  const [backend, setBackend] = useState<{configured:boolean;domain:string}|null>(null)
  const [sending, setSending] = useState(false)
  const [sendMsg, setSendMsg] = useState('')

  // Load available months (only those with baselines, excluding current month)
  async function loadAvailableMonths() {
    try {
      const r = await fetch('/api/reports/email-health?action=baselines')
      const d = await r.json()
      const months = ((d.baselines || []) as any[])
        .filter((b: any) => b.month < currentMonth)
        .map((b: any) => ({
          month: b.month,
          label: new Date(b.month + '-15').toLocaleString('default', { month: 'long', year: 'numeric' }),
        }))
      setAvailableMonths(months)
      if (months.length > 0 && !selectedMonth) {
        setSelectedMonth(months[0].month)
      }
    } catch {}
  }

  // Auto-load cached report when month changes
  async function loadCachedReport(month: string) {
    if (!month) return
    setReport(null); setReportGeneratedAt(null); setError('')
    try {
      const r = await fetch(`/api/reports/email-health?action=report&month=${month}`)
      const d = await r.json()
      if (d.cached) {
        setReport(d.cached)
        setReportGeneratedAt(d.generated_at)
        if (postmasterConnected) {
          fetch('/api/postmaster/data?domain=l.phxhomeremodeling.com')
            .then(r2=>r2.json()).then(pd=>{ if(!pd.error) setPostmasterData(pd) }).catch(()=>{})
        }
      }
    } catch {}
  }

  useEffect(() => {
    fetch('/api/reports/email-health').then(r=>r.json()).then(d=>setBackend(d)).catch(()=>{})
    fetch('/api/postmaster/oauth?action=status').then(r=>r.json()).then(d=>setPostmasterConnected(d.connected)).catch(()=>{})
    loadAvailableMonths()
  }, [])

  useEffect(() => {
    if (selectedMonth) loadCachedReport(selectedMonth)
  }, [selectedMonth])

  // When postmaster status resolves after report is already loaded, fetch the data
  useEffect(() => {
    if (postmasterConnected && report && !report.in_progress && !report.no_baseline) {
      fetch('/api/postmaster/data?domain=l.phxhomeremodeling.com')
        .then(r=>r.json()).then(pd=>{ if(!pd.error) setPostmasterData(pd) }).catch(()=>{})
    }
  }, [postmasterConnected])

  async function generate() {
    if (!selectedMonth) return
    setLoading(true); setError(''); setPostmasterData(null)
    try {
      const r = await fetch('/api/reports/email-health', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: selectedMonth }),
      })
      const d = await r.json()
      if (!r.ok && !d.in_progress && !d.no_baseline) { setError(d.error || 'Failed'); return }
      setReport(d)
      setReportGeneratedAt(d.generated_at)
      if (postmasterConnected && !d.in_progress && !d.no_baseline) {
        fetch('/api/postmaster/data?domain=l.phxhomeremodeling.com')
          .then(r2=>r2.json()).then(pd=>{ if(!pd.error) setPostmasterData(pd) }).catch(()=>{})
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  const sc = !report ? '#6366f1' : report.strict_score >= 800 ? '#10b981' : report.strict_score >= 650 ? '#06b6d4' : report.strict_score >= 500 ? '#f59e0b' : report.strict_score >= 300 ? '#f43f5e' : '#dc2626'
  const pct = (n: number, d: number) => d > 0 ? (n/d*100).toFixed(1)+'%' : '0%'


  return (
    <div style={{ height:'100%', overflowY:'auto', background:'#080c14' }}>
      {/* Sticky top bar */}
      <div style={{ padding:'12px 22px', borderBottom:'1px solid rgba(99,102,241,0.1)', display:'flex', alignItems:'center', justifyContent:'space-between', background:'rgba(15,20,35,0.97)', position:'sticky', top:0, zIndex:10, gap:8, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ color:'white', fontWeight:700, fontSize:15 }}>📧 Email Health Report</span>
          {backend?.configured && <span style={{ fontSize:10, color:'#10b981', background:'rgba(16,185,129,0.1)', border:'1px solid rgba(16,185,129,0.2)', padding:'1px 7px', borderRadius:10 }}>Connected</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
          {availableMonths.length === 0
            ? <span style={{ fontSize:12, color:'rgba(148,163,184,0.4)' }}>No baselines saved — add one in Settings</span>
            : <select value={selectedMonth} onChange={e=>{ setSelectedMonth(e.target.value) }}
                style={{ background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, padding:'5px 10px', color:'white', fontSize:12, outline:'none', fontFamily:'inherit', colorScheme:'dark', cursor:'pointer' }}>
                {availableMonths.map(m=>(
                  <option key={m.month} value={m.month}>{m.label}</option>
                ))}
              </select>
          }
          {postmasterConnected
            ? <span style={{ fontSize:10, color:'#10b981', background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.2)', padding:'3px 8px', borderRadius:6 }}>✓ Postmaster</span>
            : <button onClick={()=>{window.location.href='/api/postmaster/oauth?action=start'}} style={{ padding:'5px 10px', background:'rgba(16,185,129,0.1)', border:'1px solid rgba(16,185,129,0.2)', borderRadius:7, color:'#10b981', fontSize:11, cursor:'pointer' }}>+ Connect Postmaster</button>
          }
          <button onClick={async ()=>{
            try {
              const r = await fetch('/api/reports/email-snapshot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({}) })
              const d = await r.json()
              alert(d.ok ? `✓ Snapshot saved — ${d.saved} workflows recorded for ${d.snapshot_date}` : `Error: ${d.error}`)
            } catch(e:any) { alert('Snapshot failed: '+e.message) }
          }} style={{ padding:'5px 10px', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.15)', borderRadius:7, color:'rgba(148,163,184,0.6)', fontSize:11, cursor:'pointer' }} title="Save current workflow stats as a baseline snapshot">📸 Snapshot</button>
          <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={generate} disabled={loading || !selectedMonth}
            style={{ padding:'7px 16px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:8, color:'white', fontWeight:700, fontSize:12, cursor: !selectedMonth ? 'not-allowed' : 'pointer', opacity: loading || !selectedMonth ? 0.5 : 1 }}>
            {loading ? '⏳ Generating…' : report && !report.in_progress && !report.no_baseline ? '🔄 Regenerate' : '⚡ Generate'}
          </motion.button>
          {reportGeneratedAt && report && !report.in_progress && !report.no_baseline && (
            <span style={{ fontSize:10, color:'rgba(148,163,184,0.35)' }}>
              {new Date(reportGeneratedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}
            </span>
          )}
          {report && !report.in_progress && !report.no_baseline && <button onClick={()=>{
            const html = buildEmailReportHTML(report, postmasterData)
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html],{type:'text/html'}))
            a.download = `email-health-${selectedMonth}.html`; a.click()
          }} style={{ padding:'5px 10px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, color:'#a5b4fc', fontSize:11, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
            <Download size={11}/> Export
          </button>}
          {report && !report.in_progress && !report.no_baseline && (
            <button onClick={async ()=>{
              setSending(true); setSendMsg('')
              try {
                const r = await fetch(`/api/reports/email-health?action=send&month=${selectedMonth}`)
                const d = await r.json()
                setSendMsg(d.ok ? `✓ Sent to ${d.to}` : `✗ ${d.error}`)
              } catch(e:any) { setSendMsg('✗ ' + e.message) }
              setSending(false)
            }} disabled={sending} style={{ padding:'5px 10px', background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.2)', borderRadius:7, color: sending ? 'rgba(16,185,129,0.4)' : '#10b981', fontSize:11, cursor: sending ? 'not-allowed' : 'pointer', display:'flex', alignItems:'center', gap:4 }}>
              {sending ? '⏳ Sending…' : '📧 Send'}
            </button>
          )}
          {sendMsg && <span style={{ fontSize:11, color: sendMsg.startsWith('✓') ? '#10b981' : '#f43f5e' }}>{sendMsg}</span>}
        </div>
      </div>

      {error && <div style={{ margin:16, padding:'10px 14px', background:'rgba(244,63,94,0.08)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:9, color:'#f43f5e', fontSize:13 }}>{error}</div>}

      {!report && !loading && availableMonths.length > 0 && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:14, padding:40, textAlign:'center' }}>
          <div style={{ fontSize:44 }}>📧</div>
          <h2 style={{ color:'white', fontWeight:700, fontSize:20, margin:0 }}>Email Health Report</h2>
          <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, maxWidth:400 }}>Hit Generate to run the report for {availableMonths.find(m=>m.month===selectedMonth)?.label || selectedMonth}.</p>
        </div>
      )}
      {!report && !loading && availableMonths.length === 0 && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:14, padding:40, textAlign:'center' }}>
          <div style={{ fontSize:44 }}>📋</div>
          <h2 style={{ color:'white', fontWeight:700, fontSize:20, margin:0 }}>No Baselines Yet</h2>
          <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, maxWidth:400 }}>Go to Settings → Email Health Baselines and enter June's numbers to get started.</p>
        </div>
      )}

      {/* In-progress state */}
      {report?.in_progress && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:12, padding:40, textAlign:'center' }}>
          <div style={{ fontSize:44 }}>⏳</div>
          <h2 style={{ color:'white', fontWeight:700, fontSize:18, margin:0 }}>Month In Progress</h2>
          <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, maxWidth:400 }}>{report.message}</p>
        </div>
      )}

      {/* No baseline state */}
      {report?.no_baseline && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:12, padding:40, textAlign:'center' }}>
          <div style={{ fontSize:44 }}>📋</div>
          <h2 style={{ color:'white', fontWeight:700, fontSize:18, margin:0 }}>Baseline Required</h2>
          <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, maxWidth:420 }}>{report.message}</p>
        </div>
      )}

      {report && !report.in_progress && !report.no_baseline && (
        <div style={{ maxWidth:1700, margin:'0 auto', padding:'20px 32px 60px' }}>

          {/* ── 1. SCORE HERO ── */}
          <div style={{ background:`linear-gradient(135deg,${sc}18,rgba(15,20,35,0.95))`, border:`1px solid ${sc}30`, borderRadius:16, padding:'24px 28px', marginBottom:14, display:'flex', alignItems:'center', gap:24 }}>
            <div style={{ flexShrink:0, textAlign:'center' }}>
              <div style={{ fontSize:58, fontWeight:900, color:sc, lineHeight:1 }}>{report.strict_score}</div>
              <div style={{ color:'rgba(148,163,184,0.35)', fontSize:9, marginTop:3 }}>out of 999</div>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                <span style={{ color:sc, fontWeight:800, fontSize:22 }}>{report.score_label}</span>
                <span style={{ padding:'1px 8px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.15)', borderRadius:20, color:'rgba(148,163,184,0.4)', fontSize:9 }}>Strict Email Health Score</span>
                {report.score_delta !== null && <span style={{ padding:'1px 8px', borderRadius:20, fontSize:10, fontWeight:700, background: report.score_delta > 0 ? 'rgba(16,185,129,0.1)' : report.score_delta < 0 ? 'rgba(244,63,94,0.1)' : 'rgba(99,102,241,0.1)', color: report.score_delta > 0 ? '#10b981' : report.score_delta < 0 ? '#f43f5e' : '#a5b4fc', border: `1px solid ${report.score_delta > 0 ? 'rgba(16,185,129,0.2)' : report.score_delta < 0 ? 'rgba(244,63,94,0.2)' : 'rgba(99,102,241,0.2)'}` }}>
                  {report.score_delta > 0 ? `▲ +${report.score_delta}` : report.score_delta < 0 ? `▼ ${report.score_delta}` : '— no change'} vs {report.prev_month}
                </span>}
              </div>
              <div style={{ color:'rgba(148,163,184,0.7)', fontSize:13, margin:'0 0 6px', lineHeight:1.7 }}>
                {(report.analysis?.executive_summary || 'Generating analysis…').split('\n').map((line:string, i:number) => (
                  line.trim() ? <p key={i} style={{ margin:'0 0 8px' }}>{line}</p> : <div key={i} style={{ height:4 }} />
                ))}
              </div>
              <div style={{ display:'flex', gap:16 }}>
                <div><span style={{ color:'rgba(148,163,184,0.4)', fontSize:10 }}>STRICT </span><span style={{ color:sc, fontWeight:700, fontSize:13 }}>{report.strict_score}</span></div>
                <div><span style={{ color:'rgba(148,163,184,0.4)', fontSize:10 }}>RELAXED </span><span style={{ color:'#06b6d4', fontWeight:700, fontSize:13 }}>{report.relaxed_score}</span></div>
                <div><span style={{ color:'rgba(148,163,184,0.35)', fontSize:10 }}>{report.month_label}</span></div>
              </div>
            </div>
          </div>

          {/* ── 2. ANALYST NOTE ── */}
          {report.analysis?.analyst_note && (
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:8 }}>Key Insight</div>
            <p style={{ color:'rgba(148,163,184,0.8)', fontSize:13.5, margin:0, lineHeight:1.7 }}>{report.analysis.analyst_note}</p>
          </div>
          )}

          {/* ── 3. GOOD NEWS ── */}
          {Array.isArray(report.analysis?.good_news) && report.analysis.good_news.length > 0 && (
          <div style={{ background:'rgba(16,185,129,0.04)', border:'1px solid rgba(16,185,129,0.15)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#10b981', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>✅ Good News</div>
            {report.analysis.good_news.map((b:string,i:number)=>(
              <div key={i} style={{ display:'flex', gap:10, padding:'6px 0', borderBottom:'1px solid rgba(16,185,129,0.07)' }}>
                <span style={{ color:'#10b981', flexShrink:0, fontSize:14 }}>•</span>
                <span style={{ color:'rgba(148,163,184,0.75)', fontSize:13 }}>{b}</span>
              </div>
            ))}
          </div>
          )}

          {/* ── 4. PROBLEMS COSTING REVENUE ── */}
          {Array.isArray(report.analysis?.problems) && report.analysis.problems.length > 0 && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(244,63,94,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ color:'#f43f5e', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>⚠️ Problems Costing You Revenue</div>
              {report.analysis.problems.map((p:any,i:number)=>(
                <div key={i} style={{ padding:'10px 0', borderBottom:'1px solid rgba(244,63,94,0.07)' }}>
                  <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:3 }}>
                    <span style={{ color:'white', fontWeight:600, fontSize:13 }}>{p.title}</span>
                  </div>
                  <p style={{ color:'rgba(148,163,184,0.6)', fontSize:12, margin:0, lineHeight:1.6 }}>{p.description}</p>
                </div>
              ))}
            </div>
          )}

          {/* ── 5. ACTIONS — NEW CONTACTS ── */}
          {Array.isArray(report.analysis?.actions_new_contacts) && report.analysis.actions_new_contacts.length > 0 && (
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>Actions To Take — New Leads Added &amp; Emailed in {report.month_label?.split(' ')[0]} ({report.new_leads?.mailed?.toLocaleString()} contacts)</div>
            {report.analysis.actions_new_contacts.map((a:string,i:number)=>(
              <div key={i} style={{ display:'flex', gap:8, padding:'8px 0', borderBottom:'1px solid rgba(99,102,241,0.06)', alignItems:'flex-start' }}>
                <span style={{ flexShrink:0, marginTop:1 }}><ActionBadge level="medium" /></span>
                <span style={{ color:'rgba(148,163,184,0.75)', fontSize:13, lineHeight:1.55 }}>{a}</span>
              </div>
            ))}
          </div>
          )}

          {/* ── 5b. ACTIONS — EXISTING CONTACTS ── */}
          {Array.isArray(report.analysis?.actions_existing_contacts) && report.analysis.actions_existing_contacts.length > 0 && (
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>Actions To Take — Existing Contacts Emailed in {report.month_label?.split(' ')[0]} ({report.existing?.mailed?.toLocaleString()} contacts)</div>
            {report.analysis.actions_existing_contacts.map((a:string,i:number)=>(
              <div key={i} style={{ display:'flex', gap:8, padding:'8px 0', borderBottom:'1px solid rgba(99,102,241,0.06)', alignItems:'flex-start' }}>
                <span style={{ flexShrink:0, marginTop:1 }}><ActionBadge level="high" /></span>
                <span style={{ color:'rgba(148,163,184,0.75)', fontSize:13, lineHeight:1.55 }}>{a}</span>
              </div>
            ))}
          </div>
          )}

          {/* ── 5c. MAINTENANCE ACTIONS ── */}
          {Array.isArray(report.analysis?.actions_maintenance) && report.analysis.actions_maintenance.length > 0 && (
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>Maintenance</div>
            {report.analysis.actions_maintenance.map((a:string,i:number)=>(
              <div key={i} style={{ display:'flex', gap:8, padding:'8px 0', borderBottom:'1px solid rgba(99,102,241,0.06)', alignItems:'flex-start' }}>
                <span style={{ flexShrink:0, marginTop:1 }}><ActionBadge level="low" /></span>
                <span style={{ color:'rgba(148,163,184,0.75)', fontSize:13, lineHeight:1.55 }}>{a}</span>
              </div>
            ))}
          </div>
          )}

          {/* ── 6. EMAIL PERFORMANCE ── */}
          {report.stats && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>📊 Email Performance — {report.month_label}</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
                {[
                  ['Open Rate', report.stats.open_rate+'%', report.stats.open_rate>=25],
                  ['Click Rate', report.stats.click_rate+'%', report.stats.click_rate>=2],
                  ['Bounce Rate', report.stats.bounce_rate+'%', report.stats.bounce_rate<2],
                  ['Delivered', report.stats.delivered.toLocaleString(), true],
                  ['Unsubscribed', report.stats.unsub.toLocaleString(), report.stats.unsub<10],
                ].map(([l,v,g])=>(
                  <div key={l as string} style={{ background:'rgba(99,102,241,0.06)', borderRadius:9, padding:'10px 12px' }}>
                    <div style={{ fontSize:10, color:'rgba(148,163,184,0.4)', marginBottom:2, textTransform:'uppercase' as const }}>{l}</div>
                    <div style={{ fontSize:18, fontWeight:700, color:(g as boolean)?'#10b981':'#f43f5e' }}>{v}</div>
                  </div>
                ))}
              </div>
              {/* Engagement table */}
              <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, textTransform:'uppercase' as const, marginBottom:8, letterSpacing:'0.05em' }}>Engagement Breakdown</div>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.15)' }}>
                    {['','Mailed','Opened','Clicked','Open %','Click %'].map(h=>(
                      <th key={h} style={{ padding:'5px 10px', textAlign:'left', color:'rgba(148,163,184,0.4)', fontWeight:600, fontSize:10, textTransform:'uppercase' as const }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                    <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.8)', fontSize:12 }}>Existing contacts emailed in {report.month_label?.split(' ')[0]}</td>
                    <td style={{ padding:'7px 10px', color:'white', fontWeight:600, fontSize:12 }}>{report.existing?.mailed?.toLocaleString()}</td>
                    <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.7)', fontSize:12 }}>{report.existing?.opened?.toLocaleString()}</td>
                    <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.7)', fontSize:12 }}>{report.existing?.clicked?.toLocaleString()}</td>
                    <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.existing?.open_pct}%</td>
                    <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.existing?.click_pct}%</td>
                  </tr>
                  <tr>
                    <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.8)', fontSize:12 }}>New leads added &amp; emailed in {report.month_label?.split(' ')[0]}</td>
                    <td style={{ padding:'7px 10px', color:'white', fontWeight:600, fontSize:12 }}>{report.new_leads?.mailed?.toLocaleString()}</td>
                    <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.7)', fontSize:12 }}>{report.new_leads?.opened?.toLocaleString()}</td>
                    <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.7)', fontSize:12 }}>{report.new_leads?.clicked?.toLocaleString()}</td>
                    <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.new_leads?.open_pct}%</td>
                    <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.new_leads?.click_pct}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* ── 7. AUDIENCE BREAKDOWN ── */}
          {report.list && (
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:4 }}>List Health — Engagement Segments</div>
            <p style={{ color:'rgba(148,163,184,0.35)', fontSize:11, margin:'0 0 14px' }}>Current list snapshot — lifetime engagement classification</p>
            <div style={{ display:'flex', height:10, borderRadius:8, overflow:'hidden', marginBottom:14 }}>
              {([
                [report.list.green,'#10b981'],[report.list.slipping,'#f59e0b'],[report.list.never_engaged,'#f43f5e'],
              ] as [number,string][]).map(([n,c],i)=>(
                <div key={i} style={{ width:`${report.list.total>0?(n as number)/report.list.total*100:0}%`, background:c, minWidth:(n as number)>0?3:0 }}/>
              ))}
            </div>
            {[
              { label:'Green — Safe to Send', sub:'Engaged within last 30 days', count:report.list.green, color:'#10b981' },
              { label:'Liabilities — Slipping', sub:'No engagement in 90-365 days', count:report.list.slipping, color:'#f59e0b' },
              { label:'Worst Liabilities', sub:'Never engaged or over 1 year', count:report.list.never_engaged, color:'#f43f5e' },
              { label:'Never Sent', sub:'Have not received any email', count:report.list.never_sent, color:'#475569' },
            ].map(s=>(
              <div key={s.label} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0', borderBottom:'1px solid rgba(99,102,241,0.06)' }}>
                <div style={{ width:9, height:9, borderRadius:'50%', background:s.color, flexShrink:0 }}/>
                <div style={{ flex:1 }}><span style={{ color:'white', fontSize:13, fontWeight:600 }}>{s.label} </span><span style={{ color:'rgba(148,163,184,0.4)', fontSize:11 }}>{s.sub}</span></div>
                <span style={{ color:'white', fontWeight:700, fontSize:13 }}>{s.count.toLocaleString()}</span>
                <span style={{ color:'rgba(148,163,184,0.3)', fontSize:11, width:44, textAlign:'right' as const }}>{report.list.total>0?(s.count/report.list.total*100).toFixed(1)+'%':'0%'}</span>
              </div>
            ))}
            <div style={{ display:'flex', gap:16, marginTop:12, padding:'10px 14px', background:'rgba(99,102,241,0.05)', borderRadius:9 }}>
              {[['Total',report.list.total,'#a5b4fc'],['Red/DND',report.list.red,'#f43f5e'],['Marketable',report.list.marketable,'#10b981']].map(([l,v,c])=>(
                <div key={l as string} style={{ flex:1, textAlign:'center' as const }}>
                  <div style={{ fontSize:18, fontWeight:700, color:c as string }}>{(v as number).toLocaleString()}</div>
                  <div style={{ fontSize:9, color:'rgba(148,163,184,0.4)', marginTop:2, textTransform:'uppercase' as const }}>{l}</div>
                </div>
              ))}
            </div>
          </div>
          )}

          {/* ── 8. EMAIL QUALITY + PROVIDERS ── */}
          {report.list && report.providers && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px' }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:4 }}>Email Quality</div>
              <p style={{ color:'rgba(148,163,184,0.3)', fontSize:10, margin:'0 0 10px' }}>Current list snapshot</p>
              {[['✅ Safe to send',report.list.green,'#10b981'],['🚫 Do not send',report.list.red,'#f43f5e'],['⚠️ Bounced',report.list.bounced_tag,'#f59e0b'],['🚨 Spam risk',report.list.spam_tag,'#dc2626'],['❓ Invalid',report.list.not_found,'rgba(148,163,184,0.4)'],['🔀 Catchall',report.list.catchall,'rgba(148,163,184,0.4)']].map(([l,c,col])=>(
                <div key={l as string} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                  <span style={{ color:'rgba(148,163,184,0.6)', fontSize:12 }}>{l as string}</span>
                  <span style={{ color:col as string, fontWeight:700, fontSize:12 }}>{(c as number).toLocaleString()}</span>
                </div>
              ))}
            </div>
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px' }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:10 }}>Marketable Contacts by Provider</div>
              {report.providers && [['Gmail',report.providers.google,'#10b981'],['Yahoo',report.providers.yahoo,'#f59e0b'],['Outlook/Microsoft',report.providers.microsoft,'#06b6d4'],['Other',report.providers.other,'rgba(148,163,184,0.5)']].map(([l,c,col])=>(
                <div key={l as string} style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 0', borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                  <div style={{ width:7, height:7, borderRadius:'50%', background:col as string, flexShrink:0 }}/>
                  <span style={{ color:'rgba(148,163,184,0.6)', fontSize:12, flex:1 }}>{l as string}</span>
                  <span style={{ color:'white', fontWeight:600, fontSize:12 }}>{(c as number).toLocaleString()}</span>
                  <span style={{ color:'rgba(148,163,184,0.3)', fontSize:10, width:38, textAlign:'right' as const }}>{pct(c as number, report.providers.scanned)}</span>
                </div>
              ))}
            </div>
          </div>
          )}

          {/* ── 9. DMARC + GOOGLE SIGNALS ── always shown ── */}
          {report && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(16,185,129,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>DMARC & Google Postmaster Signals</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                <div>
                  <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, marginBottom:6 }}>DMARC Compliance</div>
                  <div style={{ fontSize:28, fontWeight:800, color:'#10b981', marginBottom:4 }}>{postmasterData?.dmarc_success_ratio!=null?(postmasterData.dmarc_success_ratio*100).toFixed(1)+'%':'N/A'}</div>
                  <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, marginBottom:10 }}>Excellent DMARC Compliance Score</div>
                  {[['SPF', postmasterData?.spf_success_ratio],['DKIM', postmasterData?.dkim_success_ratio]].map(([l,v])=>(
                    <div key={l as string} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid rgba(99,102,241,0.06)' }}>
                      <span style={{ color:'rgba(148,163,184,0.5)', fontSize:12 }}>{l as string} Pass Rate</span>
                      <span style={{ color:'#10b981', fontWeight:700, fontSize:12 }}>{v!=null?((v as number)*100).toFixed(1)+'%':'N/A'}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, marginBottom:6 }}>Domain Reputation</div>
                  <div style={{ fontSize:22, fontWeight:700, color: postmasterData?.domain_reputation==='HIGH'?'#10b981':'rgba(148,163,184,0.5)', marginBottom:10 }}>{postmasterData?.domain_reputation||'UNKNOWN'}</div>
                  {[['Gmail Spam Rate', postmasterData?.spam_rate!=null?((postmasterData.spam_rate*100).toFixed(3)+'%'):null],['Inbox Rate', postmasterData?.inbox_placement_rate!=null?((postmasterData.inbox_placement_rate*100).toFixed(1)+'%'):null]].filter(([,v])=>v!==null).map(([l,v])=>(
                    <div key={l as string} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid rgba(99,102,241,0.06)' }}>
                      <span style={{ color:'rgba(148,163,184,0.5)', fontSize:12 }}>{l as string}</span>
                      <span style={{ color: v?'#10b981':'rgba(148,163,184,0.4)', fontWeight:700, fontSize:12 }}>{(v as string)||'N/A'}</span>
                    </div>
                  ))}
                  {!postmasterConnected && <div style={{ marginTop:8, color:'rgba(148,163,184,0.3)', fontSize:10 }}>Connect Google Postmaster for live data</div>}
                </div>
              </div>
            </div>
          )}

          {/* ── 10. WORKFLOW TABLE ── */}
          {report.workflows && report.workflows.length > 0 && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const }}>Workflow Campaign Details</div>
                <span style={{ fontSize:9, color: report.workflows_are_monthly ? '#10b981' : 'rgba(148,163,184,0.3)', background: report.workflows_are_monthly ? 'rgba(16,185,129,0.08)' : 'rgba(99,102,241,0.06)', border:`1px solid ${report.workflows_are_monthly ? 'rgba(16,185,129,0.2)' : 'rgba(99,102,241,0.1)'}`, padding:'2px 7px', borderRadius:4 }}>
                  {report.workflows_are_monthly ? `📅 ${report.month_label}` : 'All-time cumulative'}
                </span>
              </div>
              {!report.workflows_are_monthly && <p style={{ color:'rgba(148,163,184,0.25)', fontSize:10, margin:'0 0 12px', lineHeight:1.5 }}>Upload the GHL Workflow CSV in Settings → Workflow Import to see monthly numbers.</p>}
              <div style={{ overflowX:'auto' as const }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.15)' }}>
                      {['Workflow','Sent','Open %','Click %','Bounce %'].map(h=>(
                        <th key={h} style={{ padding:'5px 8px', textAlign:'left' as const, color:'rgba(148,163,184,0.4)', fontWeight:600, fontSize:9, textTransform:'uppercase' as const }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...(report.workflows as any[])].sort((a,b)=>b.sent-a.sent).map((w:any)=>(
                      <tr key={w.name} style={{ borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                        <td style={{ padding:'6px 8px', color:'rgba(148,163,184,0.8)', maxWidth:340, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }} title={w.name}>{w.name}</td>
                        <td style={{ padding:'6px 8px', color:'white', fontWeight:600 }}>{w.sent.toLocaleString()}</td>
                        <td style={{ padding:'6px 8px', color:w.openRate>=25?'#10b981':'#f59e0b', fontWeight:600 }}>{w.openRate.toFixed(1)}%</td>
                        <td style={{ padding:'6px 8px', color:w.clickRate>=3?'#10b981':'#f59e0b', fontWeight:600 }}>{w.clickRate.toFixed(1)}%</td>
                        <td style={{ padding:'6px 8px', color:w.bounced/w.sent*100<2?'#10b981':'#f43f5e', fontWeight:600 }}>{w.sent>0?(w.bounced/w.sent*100).toFixed(2):0}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── 11. 12-MONTH WORKFLOW CAMPAIGN DETAILS (flat annual — same format as monthly) ── */}
          {report.workflow_history_campaigns && report.workflow_history_campaigns.length > 0 && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:4 }}>
                <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const }}>Workflow Campaign Details</div>
                <span style={{ fontSize:9, color:'#10b981', background:'rgba(16,185,129,0.08)', border:'1px solid rgba(16,185,129,0.2)', padding:'2px 7px', borderRadius:4 }}>
                  📅 {report.workflow_history_label || 'Annual'}
                </span>
              </div>
              <div style={{ overflowX:'auto' as const }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.15)' }}>
                      {['Workflow','Sent','Open %','Click %','Bounce %'].map(h=>(
                        <th key={h} style={{ padding:'5px 8px', textAlign:'left' as const, color:'rgba(148,163,184,0.4)', fontWeight:600, fontSize:9, textTransform:'uppercase' as const }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.workflow_history_campaigns.map((w: any, i: number) => (
                      <tr key={i} style={{ borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                        <td style={{ padding:'6px 8px', color:'rgba(148,163,184,0.8)', maxWidth:340, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }} title={w.name}>{w.name}</td>
                        <td style={{ padding:'6px 8px', color:'white', fontWeight:600 }}>{(w.sent||0).toLocaleString()}</td>
                        <td style={{ padding:'6px 8px', color:(w.openRate??0)>=25?'#10b981':'#f59e0b', fontWeight:600 }}>{(w.openRate??0).toFixed(1)}%</td>
                        <td style={{ padding:'6px 8px', color:(w.clickRate??0)>=3?'#10b981':'#f59e0b', fontWeight:600 }}>{(w.clickRate??0).toFixed(1)}%</td>
                        <td style={{ padding:'6px 8px', color:w.sent>0&&(w.bounced/w.sent*100)<2?'#10b981':'#f43f5e', fontWeight:600 }}>{w.sent>0?((w.bounced/w.sent)*100).toFixed(2):'0.00'}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p style={{ color:'rgba(148,163,184,0.2)', fontSize:11, textAlign:'center' as const }}>Generated {new Date(report.generated_at).toLocaleString()} · {report.domain} via HighLevel</p>
        </div>
      )}
    </div>
  )
}

function buildEmailReportHTML(report: any, pm: any): string {
  const sc = report.strict_score >= 800 ? '#10b981' : report.strict_score >= 650 ? '#06b6d4' : report.strict_score >= 500 ? '#f59e0b' : report.strict_score >= 300 ? '#f43f5e' : '#dc2626'
  const pct = (n: number, d: number) => d > 0 ? (n/d*100).toFixed(1)+'%' : '0%'
  const lst = report.list || {}
  const ex  = report.existing || {}
  const nl  = report.new_leads || {}

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Email Health Report - ${report.month_label}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080c14;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;padding:32px;max-width:1700px;margin:0 auto}
.card{background:rgba(15,20,35,.9);border:1px solid rgba(99,102,241,.15);border-radius:14px;padding:20px;margin:14px 0}
.title{color:#a5b4fc;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}
p{color:rgba(148,163,184,.7);line-height:1.7;margin-bottom:8px}
.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(99,102,241,.06)}
.kpi{text-align:center;flex:1;padding:8px 4px}
.kpi-val{font-size:20px;font-weight:700;color:${sc}}
.kpi-lbl{font-size:9px;color:rgba(148,163,184,.4);text-transform:uppercase;margin-top:2px}
.badge-high{background:rgba(244,63,94,.15);border:1px solid rgba(244,63,94,.3);color:#f43f5e;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:700;text-transform:uppercase}
.badge-medium{background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.3);color:#f59e0b;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:700;text-transform:uppercase}
.badge-low{background:rgba(6,182,212,.15);border:1px solid rgba(6,182,212,.3);color:#06b6d4;padding:1px 7px;border-radius:4px;font-size:9px;font-weight:700;text-transform:uppercase}
table{width:100%;border-collapse:collapse}
th{color:rgba(148,163,184,.4);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;padding:6px 10px;text-align:left;border-bottom:1px solid rgba(99,102,241,.1)}
td{padding:8px 10px;border-bottom:1px solid rgba(99,102,241,.06);font-size:13px;color:rgba(148,163,184,.75)}
</style></head><body>

<!-- HEADER -->
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
  <div>
    <div style="font-size:64px;font-weight:900;color:${sc};line-height:1">${report.strict_score}</div>
    <div style="font-size:22px;font-weight:800;color:${sc};margin-top:2px">${report.score_label}</div>
    <div style="color:rgba(148,163,184,.4);font-size:11px;margin-top:6px">Strict Email Health Score · ${report.month_label} · via HighLevel</div>
    <div style="margin-top:8px;font-size:13px">
      <span style="color:rgba(148,163,184,.5)">Strict: </span><span style="color:${sc};font-weight:700">${report.strict_score}</span>&nbsp;&nbsp;
      <span style="color:rgba(148,163,184,.5)">Relaxed: </span><span style="color:#06b6d4;font-weight:700">${report.relaxed_score}</span>
    </div>
  </div>
  <div style="text-align:right">
    <div style="font-size:20px;font-weight:700;color:white">Phoenix Home Remodeling</div>
    <div style="color:rgba(148,163,184,.4);font-size:13px;margin-top:4px">${report.domain}</div>
  </div>
</div>

<!-- ANALYST NOTES -->
<div class="card"><div class="title">Analyst Notes</div><p>${report.analysis?.analyst_note||''}</p></div>

<!-- EXECUTIVE SUMMARY -->
<div class="card"><div class="title">Executive Summary</div>
  <p>${report.analysis?.executive_summary||''}</p>
</div>

<!-- PROBLEMS -->
${Array.isArray(report.analysis?.problems)&&report.analysis.problems.length?`
<div class="card" style="border-color:rgba(244,63,94,.2)">
  <div class="title" style="color:#f43f5e">⚠️ Problems Costing You Revenue</div>
  ${report.analysis.problems.map((p:any)=>`
    <div style="padding:10px 0;border-bottom:1px solid rgba(244,63,94,.08)">
      <strong style="color:white;font-size:14px">${p.title}</strong>
      <p style="margin-top:4px">${p.description}</p>
    </div>`).join('')}
</div>`:''}

<!-- ACTIONS -->
<div class="card"><div class="title">Actions — New Contacts</div>
  ${(report.analysis?.actions_new_contacts||[]).map((a:string)=>`
    <div style="padding:8px 0;border-bottom:1px solid rgba(99,102,241,.06)">
      <span style="color:rgba(148,163,184,.8);font-size:13px">• ${a}</span>
    </div>`).join('')}
</div>
<div class="card"><div class="title">Actions — Existing Contacts</div>
  ${(report.analysis?.actions_existing_contacts||[]).map((a:string)=>`
    <div style="padding:8px 0;border-bottom:1px solid rgba(99,102,241,.06)">
      <span style="color:rgba(148,163,184,.8);font-size:13px">• ${a}</span>
    </div>`).join('')}
</div>
<div class="card"><div class="title">Actions — Maintenance</div>
  ${(report.analysis?.actions_maintenance||[]).map((a:string)=>`
    <div style="padding:8px 0;border-bottom:1px solid rgba(99,102,241,.06)">
      <span style="color:rgba(148,163,184,.8);font-size:13px">• ${a}</span>
    </div>`).join('')}
</div>

<!-- EMAIL PERFORMANCE STATS -->
${report.stats.campaigns_analyzed>0?`
<div class="card">
  <div class="title">Email Performance — ${report.stats.campaigns_analyzed} Workflows</div>
  <div style="display:flex;margin-bottom:8px">
    ${[['Open Rate',report.stats.open_rate+'%'],['Click Rate',report.stats.click_rate+'%'],['Bounce Rate',report.stats.bounce_rate+'%'],['Delivered',report.stats.delivered.toLocaleString()],['Unsubscribed',report.stats.unsub.toLocaleString()]].map(([l,v])=>`
    <div class="kpi"><div class="kpi-val">${v}</div><div class="kpi-lbl">${l}</div></div>`).join('')}
  </div>
</div>`:''}

<!-- ENGAGEMENT TABLE -->
${(ex.mailed||nl.mailed)?`
<div class="card">
  <div class="title">Engagement This Period</div>
  <table>
    <tr><th>Segment</th><th>Mailed</th><th>Open %</th><th>Click %</th></tr>
    <tr>
      <td style="color:white;font-weight:600">Existing Subscribers</td>
      <td style="color:white;font-weight:600">${(ex.mailed||0).toLocaleString()}</td>
      <td style="color:#10b981;font-weight:600">${ex.open_pct||'—'}%</td>
      <td style="color:#10b981;font-weight:600">${ex.click_pct||'—'}%</td>
    </tr>
    <tr>
      <td style="color:white;font-weight:600">New Leads</td>
      <td style="color:white;font-weight:600">${(nl.mailed||0).toLocaleString()}</td>
      <td style="color:#10b981;font-weight:600">${nl.open_pct||'—'}%</td>
      <td style="color:#10b981;font-weight:600">${nl.click_pct||'—'}%</td>
    </tr>
  </table>
</div>`:''}

<!-- SEGMENTS -->
${lst.total?`
<div class="card">
  <div class="title">List Health — Engagement Segments</div>
  <p style="color:rgba(148,163,184,.35);font-size:11px;margin-bottom:12px">Current list snapshot — HTI tag-based classification</p>
  <!-- Segment bar -->
  <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin-bottom:16px;background:rgba(99,102,241,.08)">
    ${[[lst.green,'#10b981'],[lst.slipping,'#f59e0b'],[lst.never_engaged,'#f43f5e'],[lst.never_sent,'rgba(99,102,241,.3)']].map(([n,c])=>`<div style="width:${lst.total>0?(n as number)/lst.total*100:0}%;background:${c};min-width:${(n as number)>0?3:0}px"></div>`).join('')}
  </div>
  ${[
    {label:'Best Assets',sub:'Green tag — engaged 0-30 days',count:lst.green,color:'#10b981'},
    {label:'Liabilities',sub:'Slipping tag — 90-365 days inactive',count:lst.slipping,color:'#f59e0b'},
    {label:'Worst Liabilities',sub:'Never engaged or >1 year',count:lst.never_engaged,color:'#f43f5e'},
    {label:'Never Sent',sub:'No emails sent yet',count:lst.never_sent,color:'rgba(99,102,241,.6)'},
  ].map(s=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(99,102,241,.06)">
      <div>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0"></div>
          <span style="color:white;font-size:13px;font-weight:600">${s.label}</span>
        </div>
        <div style="color:rgba(148,163,184,.4);font-size:11px;margin-left:18px;margin-top:2px">${s.sub}</div>
      </div>
      <div style="text-align:right">
        <span style="color:${s.color};font-weight:700;font-size:15px">${((s.count||0) as number).toLocaleString()}</span>
        <span style="color:rgba(148,163,184,.3);font-size:11px;margin-left:6px">${pct((s.count||0) as number,lst.total)}</span>
      </div>
    </div>`).join('')}
  <!-- Summary stats -->
  <div style="display:flex;gap:0;margin-top:14px;border-top:1px solid rgba(99,102,241,.08);padding-top:12px">
    ${[['Total',lst.total,'#a5b4fc'],['Marketable',lst.marketable,'#10b981'],['Bounced',lst.bounced_tag,'#f59e0b'],['Spam',lst.spam_tag,'#f43f5e']].map(([l,v,c])=>`
    <div style="flex:1;text-align:center">
      <div style="font-size:18px;font-weight:700;color:${c}">${((v||0) as number).toLocaleString()}</div>
      <div style="font-size:9px;color:rgba(148,163,184,.4);text-transform:uppercase;margin-top:2px">${l}</div>
    </div>`).join('')}
  </div>
</div>`:''}

<!-- EMAIL QUALITY + PROVIDERS -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
  <div class="card">
    <div class="title">Email Quality</div>
    ${[['✅ Safe to send',lst.green,'#10b981'],['🚫 Do not send',lst.red,'#f43f5e'],['⚠️ Bounced',lst.bounced_tag,'#f59e0b'],['🚨 Spam risk',lst.spam_tag,'#dc2626']].map(([l,c,col])=>`
    <div class="row"><span>${l}</span><span style="color:${col};font-weight:700">${((c||0) as number).toLocaleString()}</span></div>`).join('')}
  </div>
  <div class="card">
    <div class="title">Marketable by Provider</div>
    ${report.providers?[['Gmail',report.providers.google],['Yahoo',report.providers.yahoo],['Outlook',report.providers.microsoft],['Other',report.providers.other]].map(([l,c])=>`
    <div class="row"><span>${l}</span><span style="color:white;font-weight:700">${((c||0) as number).toLocaleString()} (${pct((c||0) as number,report.providers.scanned)})</span></div>`).join(''):'<p>No provider data</p>'}
  </div>
</div>

<!-- DMARC + GOOGLE SIGNALS -->
<div class="card" style="border-color:rgba(16,185,129,.15)">
  <div class="title">DMARC &amp; Google Postmaster Signals</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div>
      <div style="color:rgba(148,163,184,.4);font-size:10px;margin-bottom:8px">DMARC Compliance</div>
      <div style="font-size:28px;font-weight:700;color:#10b981">${pm?.dmarc_success_ratio!=null?(pm.dmarc_success_ratio*100).toFixed(1)+'%':'N/A'}</div>
      <div style="color:rgba(148,163,184,.4);font-size:11px;margin-top:4px">Excellent DMARC Compliance Score</div>
      <div style="margin-top:12px">
        <div class="row"><span>SPF Pass Rate</span><span style="color:#10b981;font-weight:700">${pm?.spf_success_ratio!=null?(pm.spf_success_ratio*100).toFixed(0)+'%':'N/A'}</span></div>
        <div class="row"><span>DKIM Pass Rate</span><span style="color:#10b981;font-weight:700">${pm?.dkim_success_ratio!=null?(pm.dkim_success_ratio*100).toFixed(0)+'%':'N/A'}</span></div>
      </div>
    </div>
    <div>
      <div style="color:rgba(148,163,184,.4);font-size:10px;margin-bottom:8px">Domain Reputation</div>
      <div style="font-size:22px;font-weight:700;color:#10b981">${pm?.domain_reputation||'UNKNOWN'}</div>
      <div style="margin-top:12px">
        <div class="row"><span>Spam Rate</span><span style="color:white;font-weight:700">${pm?.spam_rate!=null?(pm.spam_rate*100).toFixed(3)+'%':'N/A'}</span></div>
        <div class="row"><span>Inbox Rate</span><span style="color:#10b981;font-weight:700">${pm?.inbox_placement_rate!=null?(pm.inbox_placement_rate*100).toFixed(1)+'%':'N/A'}</span></div>
      </div>
    </div>
  </div>
</div>

<!-- MONTHLY WORKFLOW CAMPAIGN DETAILS -->
${Array.isArray(report.workflows)&&report.workflows.length>0?`
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="title" style="margin-bottom:0">Workflow Campaign Details</div>
    <span style="font-size:10px;color:#10b981;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);padding:2px 8px;border-radius:4px">${report.workflows_are_monthly?`📅 ${report.month_label}`:'All-time cumulative'}</span>
  </div>
  <table>
    <tr><th>Workflow</th><th>Sent</th><th>Open %</th><th>Click %</th><th>Bounce %</th></tr>
    ${[...(report.workflows as any[])].sort((a:any,b:any)=>b.sent-a.sent).map((w:any)=>`
    <tr>
      <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${w.name}">${w.name}</td>
      <td style="color:white;font-weight:600">${(w.sent||0).toLocaleString()}</td>
      <td style="color:${(w.openRate||0)>=25?'#10b981':'#f59e0b'};font-weight:600">${(w.openRate||0).toFixed(1)}%</td>
      <td style="color:${(w.clickRate||0)>=3?'#10b981':'#f59e0b'};font-weight:600">${(w.clickRate||0).toFixed(1)}%</td>
      <td style="color:${w.sent>0&&(w.bounced/w.sent*100)<2?'#10b981':'#f43f5e'};font-weight:600">${w.sent>0?(w.bounced/w.sent*100).toFixed(2):'0.00'}%</td>
    </tr>`).join('')}
  </table>
</div>`:''}

<!-- ANNUAL WORKFLOW CAMPAIGN DETAILS -->
${Array.isArray(report.workflow_history_campaigns)&&report.workflow_history_campaigns.length>0?`
<div class="card">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <div class="title" style="margin-bottom:0">Workflow Campaign Details</div>
    <span style="font-size:10px;color:#10b981;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);padding:2px 8px;border-radius:4px">📅 ${report.workflow_history_label||'Annual'}</span>
  </div>
  <table>
    <tr><th>Workflow</th><th>Sent</th><th>Open %</th><th>Click %</th><th>Bounce %</th></tr>
    ${(report.workflow_history_campaigns as any[]).map((w:any)=>`
    <tr>
      <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${w.name}">${w.name}</td>
      <td style="color:white;font-weight:600">${(w.sent||0).toLocaleString()}</td>
      <td style="color:${(w.openRate??0)>=25?'#10b981':'#f59e0b'};font-weight:600">${(w.openRate??0).toFixed(1)}%</td>
      <td style="color:${(w.clickRate??0)>=3?'#10b981':'#f59e0b'};font-weight:600">${(w.clickRate??0).toFixed(1)}%</td>
      <td style="color:${w.sent>0&&(w.bounced/w.sent*100)<2?'#10b981':'#f43f5e'};font-weight:600">${w.sent>0?((w.bounced/w.sent)*100).toFixed(2):'0.00'}%</td>
    </tr>`).join('')}
  </table>
</div>`:''}

<p style="color:rgba(148,163,184,.2);font-size:11px;text-align:center;padding:24px 0">Generated ${new Date(report.generated_at).toLocaleString()} · ${report.domain} · Phoenix Home Remodeling</p>
</body></html>`
}


// ── Dashboard View ─────────────────────────────────────────────────────────

function DashboardView({ agents, metrics, activity, onSelectAgent }: { agents: Agent[]; metrics: Metrics | null; activity: LogEntry[]; onSelectAgent: (a: Agent) => void }) {
  const totalTokens = metrics?.total_tokens || 0
  const activeCount = metrics?.active_agents || 0
  const tasksDone   = metrics?.tasks_completed || 0
  const tasksPending = metrics?.tasks_pending || 0
  const [dateStr, setDateStr] = useState('')
  useEffect(() => {
    setDateStr(new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }))
  }, [])

  return (
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>Mission Control</h1>
        <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 13, margin: '4px 0 0' }}>Production · Hermes AI{dateStr ? ` · ${dateStr}` : ''}</p>
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
    '⬡ PHR OS Terminal v2.0 — Production',
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
        lines.push('  PHR OS v2.0.0 · Next.js 14 · SQLite · OpenAI · JWT Auth')
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


// ── API Keys Panel ─────────────────────────────────────────────────────────

function ApiKeysPanel() {
  const [keys, setKeys] = useState<any[]>([])
  const [name, setName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    const res = await fetch('/api/keys')
    if (res.ok) setKeys(await res.json())
  }

  async function create() {
    if (!name.trim()) return
    setCreating(true)
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await res.json()
    setNewKey(data.key)
    setName('')
    setCreating(false)
    load()
  }

  async function remove(id: number) {
    await fetch(`/api/keys?id=${id}`, { method: 'DELETE' })
    load()
  }

  return (
    <div style={{ background: 'rgba(15,20,35,0.8)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 20, marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <Key size={14} color="#a5b4fc" />
        <span style={{ color: 'white', fontWeight: 600, fontSize: 14 }}>API Keys</span>
        <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)' }}>— trigger agents from GHL, N8N, Zapier and more</span>
      </div>

      {newKey && (
        <div style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: 10, padding: 14, marginBottom: 14 }}>
          <div style={{ color: '#10b981', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>✓ Key created — copy it now, it won&#39;t be shown again</div>
          <code style={{ color: 'white', fontSize: 12, wordBreak: 'break-all', background: 'rgba(0,0,0,0.3)', padding: '6px 10px', borderRadius: 6, display: 'block' }}>{newKey}</code>
          <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.5)', marginTop: 8 }}>
            Send as header: <code style={{ color: '#a5b4fc' }}>x-api-key: {newKey}</code> to <code style={{ color: '#a5b4fc' }}>POST /api/trigger</code>
          </div>
          <button onClick={() => setNewKey(null)} style={{ marginTop: 8, padding: '4px 10px', background: 'transparent', border: '1px solid rgba(148,163,184,0.2)', borderRadius: 6, color: 'rgba(148,163,184,0.5)', fontSize: 11, cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()}
          placeholder="Key name e.g. GHL Webhook, N8N, Zapier"
          style={{ flex: 1, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '8px 12px', color: 'white', fontSize: 13, outline: 'none' }} />
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} onClick={create} disabled={creating || !name.trim()}
          style={{ padding: '8px 16px', background: 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 8, color: 'white', fontSize: 12, fontWeight: 600, cursor: 'pointer', opacity: !name.trim() ? 0.5 : 1 }}>
          {creating ? '…' : 'Generate Key'}
        </motion.button>
      </div>

      {keys.length === 0 && <div style={{ color: 'rgba(148,163,184,0.3)', fontSize: 12, textAlign: 'center', padding: '10px 0' }}>No API keys yet</div>}

      {keys.map(k => (
        <div key={k.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid rgba(99,102,241,0.07)' }}>
          <div>
            <span style={{ color: 'white', fontSize: 13 }}>{k.name}</span>
            <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11, marginLeft: 8 }}>{k.key_prefix}…</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {k.last_used && <span style={{ color: 'rgba(148,163,184,0.3)', fontSize: 11 }}>last used {new Date(k.last_used).toLocaleDateString()}</span>}
            <button onClick={() => remove(k.id)} style={{ background: 'none', border: 'none', color: 'rgba(244,63,94,0.4)', cursor: 'pointer' }}><Trash2 size={12} /></button>
          </div>
        </div>
      ))}

      <div style={{ marginTop: 14, padding: 12, background: 'rgba(99,102,241,0.05)', borderRadius: 8, fontSize: 11, color: 'rgba(148,163,184,0.5)', lineHeight: 1.7 }}>
        <strong style={{ color: '#a5b4fc' }}>Endpoint:</strong> POST https://ai.phoenixhomeremodeling.net/api/trigger<br/>
        <strong style={{ color: '#a5b4fc' }}>Headers:</strong> x-api-key: your-key, Content-Type: application/json<br/>
        <strong style={{ color: '#a5b4fc' }}>Body:</strong> {'{'}&#34;agent_id&#34;:&#34;writer&#34;,&#34;title&#34;:&#34;Task title&#34;,&#34;description&#34;:&#34;Details&#34;,&#34;type&#34;:&#34;general&#34;{'}'}
      </div>
    </div>
  )
}


// ── Users Panel ────────────────────────────────────────────────────────────

function UsersPanel() {
  const [users, setUsers] = useState<any[]>([])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('operator')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string|null>(null)

  useEffect(() => { load() }, [])
  async function load() { const r = await fetch('/api/users'); if(r.ok) setUsers(await r.json()) }
  async function create() {
    if (!email.trim() || !password.trim()) return
    setSaving(true)
    const r = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email, password, role}) })
    const d = await r.json()
    if (d.error) setMsg(`✗ ${d.error}`)
    else { setMsg('✓ User created'); setEmail(''); setPassword('') }
    setSaving(false); load()
    setTimeout(() => setMsg(null), 3000)
  }
  async function changeRole(id: number, newRole: string) { await fetch('/api/users', { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id, role:newRole}) }); load() }
  async function remove(id: number) { await fetch(`/api/users?id=${id}`, {method:'DELETE'}); load() }

  const inp = { background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 10px', color:'white', fontSize:12, outline:'none', flex:1 as any }
  const ROLE_COLORS: Record<string,string> = { admin:'#f59e0b', operator:'#6366f1', viewer:'rgba(148,163,184,0.5)' }

  return (
    <div style={{ background:'rgba(15,20,35,0.8)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:20, marginBottom:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:14 }}>
        <span style={{ color:'white', fontWeight:600, fontSize:14 }}>👥 Team Members</span>
      </div>
      <div style={{ display:'flex', gap:6, marginBottom:12, flexWrap:'wrap' }}>
        <input value={email} onChange={e=>setEmail(e.target.value)} placeholder="email@example.com" style={inp}/>
        <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" style={{ ...inp, flex: 'none', width:120 }}/>
        <select value={role} onChange={e=>setRole(e.target.value)} style={{ ...inp, flex:'none', fontFamily:'inherit', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 10px', color:'white', outline:'none' }}>
          <option value="operator" style={{background:'#0f1623'}}>Operator</option>
          <option value="viewer" style={{background:'#0f1623'}}>Viewer</option>
          <option value="admin" style={{background:'#0f1623'}}>Admin</option>
        </select>
        <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={create} disabled={saving}
          style={{ padding:'8px 14px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:8, color:'white', fontSize:12, fontWeight:600, cursor:'pointer' }}>
          {saving?'…':'Add'}
        </motion.button>
      </div>
      {msg && <div style={{ padding:'5px 10px', borderRadius:6, background:msg.startsWith('✓')?'rgba(16,185,129,0.08)':'rgba(244,63,94,0.08)', color:msg.startsWith('✓')?'#10b981':'#f43f5e', fontSize:12, marginBottom:10 }}>{msg}</div>}
      {users.map((u:any) => (
        <div key={u.id} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 0', borderBottom:'1px solid rgba(99,102,241,0.07)' }}>
          <span style={{ color:'white', fontSize:13 }}>{u.email}</span>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <select value={u.role||'admin'} onChange={e=>changeRole(u.id, e.target.value)}
              style={{ background:'transparent', border:'none', color:ROLE_COLORS[u.role||'admin'], fontSize:11, cursor:'pointer', outline:'none', fontFamily:'inherit' }}>
              <option value="admin" style={{background:'#0f1623'}}>admin</option>
              <option value="operator" style={{background:'#0f1623'}}>operator</option>
              <option value="viewer" style={{background:'#0f1623'}}>viewer</option>
            </select>
            <button onClick={() => remove(u.id)} style={{ background:'none', border:'none', color:'rgba(244,63,94,0.3)', cursor:'pointer' }}><Trash2 size={11}/></button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Semantic Search Modal ──────────────────────────────────────────────────

function SemanticSearchModal({ onClose, onNavigate }: { onClose: () => void; onNavigate: (agentId: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  async function search() {
    if (!query.trim()) return
    setLoading(true)
    const r = await fetch('/api/search/semantic', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({query}) })
    if (r.ok) setResults(await r.json())
    setLoading(false)
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'flex-start', justifyContent:'center', paddingTop:'12vh', zIndex:500 }}>
      <motion.div initial={{opacity:0,y:-20}} animate={{opacity:1,y:0}} style={{ width:600, background:'#0f1623', border:'1px solid rgba(99,102,241,0.25)', borderRadius:16, overflow:'hidden' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 16px', borderBottom:'1px solid rgba(99,102,241,0.1)' }}>
          <Search size={16} color="#a5b4fc"/>
          <input ref={inputRef} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')search();if(e.key==='Escape')onClose()}}
            placeholder="Search task results by meaning… (AI-powered)"
            style={{ flex:1, background:'none', border:'none', color:'white', fontSize:14, outline:'none' }}/>
          <button onClick={search} disabled={loading} style={{ padding:'5px 12px', background:'rgba(99,102,241,0.15)', border:'1px solid rgba(99,102,241,0.25)', borderRadius:6, color:'#a5b4fc', fontSize:12, cursor:'pointer' }}>
            {loading?'…':'Search'}
          </button>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'rgba(148,163,184,0.4)', cursor:'pointer', fontSize:18 }}>✕</button>
        </div>
        <div style={{ maxHeight:400, overflowY:'auto' }}>
          {results.length === 0 && !loading && query && <p style={{ color:'rgba(148,163,184,0.3)', fontSize:13, textAlign:'center', padding:'24px 0' }}>No results found</p>}
          {results.map((r:any) => (
            <div key={r.id} onClick={() => { onNavigate(r.agent_id); onClose() }}
              style={{ padding:'12px 16px', borderBottom:'1px solid rgba(99,102,241,0.07)', cursor:'pointer' }}
              onMouseEnter={e=>(e.currentTarget.style.background='rgba(99,102,241,0.06)')}
              onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                <span style={{ color:'white', fontSize:13, fontWeight:500, flex:1 }}>{r.title}</span>
                <span style={{ fontSize:10, color:'#10b981', background:'rgba(16,185,129,0.1)', padding:'1px 6px', borderRadius:10 }}>{r.score}% match</span>
                <span style={{ fontSize:10, color:'rgba(148,163,184,0.3)' }}>{r.type}</span>
              </div>
              {r.result && <p style={{ color:'rgba(148,163,184,0.4)', fontSize:12, margin:0 }}>{r.result.slice(0,120)}…</p>}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  )
}

// ── Email Health Baseline Panel ────────────────────────────────────────────

function EmailHealthBaselinePanel() {
  const now = new Date()
  // Default to last completed month
  const _dm = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const defaultMonth = `${_dm.getFullYear()}-${String(_dm.getMonth() + 1).padStart(2, '0')}`

  const [month, setMonth] = useState(defaultMonth)
  const [form, setForm] = useState({
    existing_mailed: '', new_mailed: '', open_rate: '', delivered: '',
    total_opened: '', total_clicked: '', bounced: '', spam: '', unsub: '', engaged_90d: '',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved]   = useState(false)
  const [error, setError]   = useState('')
  const [existing, setExisting] = useState<any[]>([])

  // Build last-24-completed-months list (use local date props to avoid UTC timezone shift)
  const toMonthStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  const monthOptions = Array.from({ length: 24 }, (_, i) => {
    return toMonthStr(new Date(now.getFullYear(), now.getMonth() - 1 - i, 1))
  })

  async function loadBaselines() {
    const r = await fetch('/api/reports/email-health?action=baselines')
    if (r.ok) { const d = await r.json(); setExisting(d.baselines || []) }
  }

  async function loadMonth(m: string) {
    setMonth(m)
    const r = await fetch(`/api/reports/email-health?action=baseline&month=${m}`)
    if (r.ok) {
      const d = await r.json()
      if (d.baseline) {
        setForm({
          existing_mailed: String(d.baseline.existing_mailed),
          new_mailed:      String(d.baseline.new_mailed),
          open_rate:       String(d.baseline.open_rate),
          delivered:       String(d.baseline.delivered),
          total_opened:    String(d.baseline.total_opened),
          total_clicked:   String(d.baseline.total_clicked),
          bounced:         String(d.baseline.bounced),
          spam:            String(d.baseline.spam),
          unsub:           String(d.baseline.unsub),
          engaged_90d:     String(d.baseline.engaged_90d),
        })
      } else {
        setForm({ existing_mailed:'', new_mailed:'', open_rate:'', delivered:'',
          total_opened:'', total_clicked:'', bounced:'', spam:'', unsub:'', engaged_90d:'' })
      }
    }
  }

  useEffect(() => { loadBaselines(); loadMonth(defaultMonth) }, [])

  async function save() {
    setSaving(true); setError('')
    const body = {
      month,
      existing_mailed: Number(form.existing_mailed),
      new_mailed:      Number(form.new_mailed),
      open_rate:       Number(form.open_rate),
      delivered:       Number(form.delivered),
      total_opened:    Number(form.total_opened),
      total_clicked:   Number(form.total_clicked),
      bounced:         Number(form.bounced),
      spam:            Number(form.spam),
      unsub:           Number(form.unsub),
      engaged_90d:     Number(form.engaged_90d),
    }
    const r = await fetch('/api/reports/email-health', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const d = await r.json()
    if (!r.ok) { setError(d.error || 'Save failed') } else { setSaved(true); setTimeout(() => setSaved(false), 2500); loadBaselines() }
    setSaving(false)
  }

  const cardStyle = { background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: '16px 18px', marginBottom: 14 }
  const lbl = { display: 'block' as const, fontSize: 10, color: 'rgba(148,163,184,0.5)', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, marginBottom: 5 }
  const inp = { width: '100%', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: 7, padding: '7px 10px', color: 'white', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }
  const fields: { key: keyof typeof form; label: string; hint?: string }[] = [
    { key: 'existing_mailed',  label: 'Existing Contacts Mailed',  hint: 'Smart list: existing contacts mailed this month' },
    { key: 'new_mailed',       label: 'New Contacts Mailed',       hint: 'Smart list: new contacts mailed this month' },
    { key: 'engaged_90d',      label: 'Engaged in 90 Days',        hint: 'Smart list: existing mailed + green OR slipping tag' },
    { key: 'delivered',        label: 'Emails Delivered',          hint: 'GHL Statistics page' },
    { key: 'open_rate',        label: 'Open Rate (%)',             hint: 'e.g. 34.50' },
    { key: 'total_opened',     label: 'Total Opened',              hint: 'GHL Statistics page' },
    { key: 'total_clicked',    label: 'Total Clicked',             hint: 'GHL Statistics page' },
    { key: 'bounced',          label: 'Bounced',                   hint: 'GHL Statistics page' },
    { key: 'spam',             label: 'Spam Complaints',           hint: 'GHL Statistics page' },
    { key: 'unsub',            label: 'Unsubscribed',              hint: 'GHL Statistics page' },
  ]

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 11, color: '#a5b4fc', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 14 }}>Email Health Baselines</div>
      <p style={{ fontSize: 12, color: 'rgba(148,163,184,0.5)', marginBottom: 14, lineHeight: 1.6 }}>Enter monthly numbers from GHL Statistics + smart lists. Used to generate the Email Health Report each month.</p>

      {/* Month picker */}
      <div style={{ marginBottom: 14 }}>
        <label style={lbl}>Month</label>
        <select value={month} onChange={e => loadMonth(e.target.value)} style={{ ...inp, fontFamily: 'inherit' }}>
          {monthOptions.map(m => (
            <option key={m} value={m} style={{ background: '#0f1423' }}>
              {new Date(m + '-15').toLocaleString('default', { month: 'long', year: 'numeric' })}
              {existing.some(b => b.month === m) ? ' ✓' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Fields in 2-col grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginBottom: 14 }}>
        {fields.map(f => (
          <div key={f.key}>
            <label style={lbl}>{f.label}</label>
            <input
              value={form[f.key]}
              onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
              placeholder={f.hint}
              style={inp}
              type="number"
              min="0"
              step={f.key === 'open_rate' ? '0.01' : '1'}
            />
          </div>
        ))}
      </div>

      {error && <p style={{ color: '#f43f5e', fontSize: 12, marginBottom: 10 }}>{error}</p>}

      <motion.button onClick={save} disabled={saving} whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
        style={{ width: '100%', padding: '9px 0', background: saved ? 'rgba(16,185,129,0.2)' : 'linear-gradient(135deg,#4338ca,#6366f1)', border: saved ? '1px solid rgba(16,185,129,0.4)' : 'none', borderRadius: 9, color: saved ? '#10b981' : 'white', fontWeight: 600, fontSize: 13, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
        {saved ? '✓ Baseline Saved' : saving ? 'Saving…' : 'Save Baseline'}
      </motion.button>

      {/* Saved baselines list */}
      {existing.length > 0 && (
        <div style={{ marginTop: 14, borderTop: '1px solid rgba(99,102,241,0.1)', paddingTop: 12 }}>
          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>Saved Baselines</div>
          {existing.map((b: any) => (
            <div key={b.month} onClick={() => loadMonth(b.month)} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(99,102,241,0.06)', cursor: 'pointer' }}>
              <span style={{ color: 'rgba(148,163,184,0.7)', fontSize: 12 }}>{new Date(b.month + '-15').toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
              <span style={{ color: '#a5b4fc', fontSize: 12, fontWeight: 600 }}>Score {b.strict_score} · Relaxed {b.relaxed_score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Workflow CSV Import Panel ──────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = []; let cur = ''; let inQ = false
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ }
    else if (ch === ',' && !inQ) { result.push(cur); cur = '' }
    else cur += ch
  }
  result.push(cur); return result
}

function WorkflowImportPanel() {
  const now = new Date()
  const defaultM = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 1, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` })()
  const [month, setMonth] = useState(defaultM)
  const [status, setStatus] = useState<string|null>(null)
  const [loading, setLoading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const monthOptions = Array.from({length:24},(_,i)=>{ const d=new Date(now.getFullYear(),now.getMonth()-1-i,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}` })

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setLoading(true); setStatus('Parsing CSV…')
    try {
      const text = await file.text()
      const lines = text.trim().split('\n')
      const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim())
      const gi = (n: string) => headers.indexOf(n)
      const idx = { date: gi('Execution Date'), id: gi('Campaign ID'), name: gi('Campaign Name'),
        sent: gi('Sent'), opened: gi('Opened'), clicked: gi('Clicked'),
        bounced: gi('Permanent Failures'), complained: gi('Complained'), unsubscribed: gi('Unsubscribed') }
      if (idx.id < 0 || idx.sent < 0) { setStatus('Invalid CSV — expected GHL Workflow Campaign Stats export.'); setLoading(false); return }

      const campaigns: Record<string,any> = {}
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]); if (!cols.length) continue
        const date = cols[idx.date]?.replace(/"/g,'').trim()
        if (!date?.startsWith(month)) continue
        const sid = cols[idx.id]?.replace(/"/g,'').trim(); if (!sid) continue
        if (!campaigns[sid]) campaigns[sid] = { name: cols[idx.name]?.replace(/"/g,'').trim()||'', sent:0, opened:0, clicked:0, bounced:0, complained:0, unsubscribed:0 }
        campaigns[sid].sent        += parseInt(cols[idx.sent]||'0')||0
        campaigns[sid].opened      += parseInt(cols[idx.opened]||'0')||0
        campaigns[sid].clicked     += parseInt(cols[idx.clicked]||'0')||0
        campaigns[sid].bounced     += parseInt(cols[idx.bounced]||'0')||0
        campaigns[sid].complained  += parseInt(cols[idx.complained]||'0')||0
        campaigns[sid].unsubscribed+= parseInt(cols[idx.unsubscribed]||'0')||0
      }

      const manual_campaigns = Object.entries(campaigns).filter(([,v])=>(v as any).sent>0).map(([source_id,v])=>({source_id,...(v as any)}))
      if (!manual_campaigns.length) { setStatus(`No data found for ${month} in this file.`); setLoading(false); return }

      const [y,m2] = month.split('-').map(Number)
      const endOfMonth = `${month}-${String(new Date(y,m2,0).getDate()).padStart(2,'0')}`
      const prevM = new Date(y, m2-2, 1)
      const prevEnd = `${prevM.getFullYear()}-${String(prevM.getMonth()+1).padStart(2,'0')}-${String(new Date(prevM.getFullYear(),prevM.getMonth()+1,0).getDate()).padStart(2,'0')}`
      const zeros = manual_campaigns.map(c=>({...c,sent:0,opened:0,clicked:0,bounced:0,complained:0,unsubscribed:0}))

      setStatus('Saving…')
      await fetch('/api/reports/email-snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({snapshot_date:prevEnd,manual_campaigns:zeros})})
      const r = await fetch('/api/reports/email-snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({snapshot_date:endOfMonth,manual_campaigns})})
      const d = await r.json()
      setStatus(d.ok ? `✓ Imported ${d.saved} workflows for ${month}. Regenerate the report to see monthly numbers.` : `Error: ${d.error}`)
    } catch(e:any) { setStatus('Error: '+e.message) }
    setLoading(false)
    if (fileRef.current) fileRef.current.value = ''
  }

  const card = { background:'rgba(15,20,35,0.7)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:12, padding:'16px 18px', marginBottom:14 }
  const inp  = { width:'100%', background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 12px', color:'white', fontSize:13, outline:'none', fontFamily:'inherit' }
  const lbl  = { display:'block' as const, fontSize:10, color:'rgba(148,163,184,0.5)', fontWeight:700, letterSpacing:'0.07em', textTransform:'uppercase' as const, marginBottom:5 }

  return (
    <div style={card}>
      <div style={{ fontSize:11, color:'#a5b4fc', fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:8 }}>Workflow Campaign Import</div>
      <p style={{ fontSize:12, color:'rgba(148,163,184,0.5)', marginBottom:14, lineHeight:1.6 }}>Upload the GHL Workflow Campaign Stats CSV. The report will show actual monthly numbers instead of all-time totals.</p>
      <div style={{ marginBottom:12 }}>
        <label style={lbl}>Month</label>
        <select value={month} onChange={e=>setMonth(e.target.value)} style={inp}>
          {monthOptions.map(m=><option key={m} value={m} style={{background:'#0f1423'}}>{new Date(m+'-15').toLocaleString('default',{month:'long',year:'numeric'})}</option>)}
        </select>
      </div>
      <label style={{ display:'block', cursor: loading?'not-allowed':'pointer' }}>
        <div style={{ width:'100%', padding:'9px 0', background:'linear-gradient(135deg,#4338ca,#6366f1)', borderRadius:9, color:'white', fontWeight:600, fontSize:13, textAlign:'center', opacity:loading?0.5:1 }}>
          {loading ? 'Processing…' : '📂 Upload Workflow CSV'}
        </div>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} disabled={loading} style={{display:'none'}} />
      </label>
      {status && <p style={{ marginTop:10, fontSize:12, color: status.startsWith('✓')?'#10b981':status.startsWith('Error')?'#f43f5e':'rgba(148,163,184,0.7)', lineHeight:1.5 }}>{status}</p>}
    </div>
  )
}

// (WorkflowHistoryTable removed — annual view now uses flat campaign list inline)

function WorkflowHistoryPanel() {
  const [status, setStatus] = useState<string|null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setLoading(true); setStatus('Parsing CSV…')
    try {
      const text = await file.text()
      const lines = text.trim().split('\n')
      const headers = lines[0].split(',').map((h: string) => h.replace(/"/g,'').trim())
      const gi = (n: string) => headers.indexOf(n)
      const idx = { date: gi('Execution Date'), id: gi('Campaign ID'), name: gi('Campaign Name'),
        sent: gi('Sent'), opened: gi('Opened'), clicked: gi('Clicked'),
        bounced: gi('Permanent Failures'), complained: gi('Complained'), unsubscribed: gi('Unsubscribed') }
      if (idx.id < 0 || idx.sent < 0) { setStatus('Invalid CSV — expected GHL Workflow Campaign Stats export.'); setLoading(false); return }

      // Group all rows by YYYY-MM month, then by campaign ID
      const byMonth: Record<string, Record<string, any>> = {}
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]); if (!cols.length) continue
        const rawDate = cols[idx.date]?.replace(/"/g,'').trim(); if (!rawDate) continue
        const m = rawDate.slice(0, 7) // YYYY-MM
        const sid = cols[idx.id]?.replace(/"/g,'').trim(); if (!sid) continue
        if (!byMonth[m]) byMonth[m] = {}
        if (!byMonth[m][sid]) byMonth[m][sid] = { name: cols[idx.name]?.replace(/"/g,'').trim()||'', sent:0, opened:0, clicked:0, bounced:0, complained:0, unsubscribed:0 }
        byMonth[m][sid].sent        += parseInt(cols[idx.sent]||'0')||0
        byMonth[m][sid].opened      += parseInt(cols[idx.opened]||'0')||0
        byMonth[m][sid].clicked     += parseInt(cols[idx.clicked]||'0')||0
        byMonth[m][sid].bounced     += parseInt(cols[idx.bounced]||'0')||0
        byMonth[m][sid].complained  += parseInt(cols[idx.complained]||'0')||0
        byMonth[m][sid].unsubscribed+= parseInt(cols[idx.unsubscribed]||'0')||0
      }

      const months = Object.keys(byMonth).sort()
      if (!months.length) { setStatus('No data found in this file.'); setLoading(false); return }
      setStatus(`Found ${months.length} months (${months[0]} → ${months[months.length-1]}). Saving…`)

      // Save per-month sends directly to YYYY-MM-01.
      // Route.ts checks for YYYY-MM-01 snapshots first (direct monthly) before
      // falling back to EOM delta — so no cumulative math or zero-baselines needed.
      let saved = 0

      for (let mi = 0; mi < months.length; mi++) {
        const m = months[mi]
        const campaigns = Object.entries(byMonth[m])
          .filter(([,v]) => (v as any).sent > 0)
          .map(([source_id, v]) => ({ source_id, ...(v as any) }))
        if (!campaigns.length) continue

        setProgress(`${m} (${mi+1}/${months.length})`)
        const r = await fetch('/api/reports/email-snapshot', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snapshot_date: `${m}-01`, manual_campaigns: campaigns })
        })
        const d = await r.json()
        if (d.ok) saved++
      }

      setStatus(`✓ Imported ${saved} monthly snapshots (${months[0]} → ${months[months.length-1]}). Regenerate the report to see 12-month history.`)
    } catch(e:any) { setStatus('Error: '+e.message) }
    setLoading(false); setProgress('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const card = { background:'rgba(15,20,35,0.7)', border:'1px solid rgba(20,184,166,0.15)', borderRadius:12, padding:'16px 18px', marginBottom:14 }

  return (
    <div style={card}>
      <div style={{ fontSize:11, color:'#14b8a6', fontWeight:700, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:8 }}>12-Month Workflow History</div>
      <p style={{ fontSize:12, color:'rgba(148,163,184,0.5)', marginBottom:14, lineHeight:1.6 }}>
        Upload one GHL Workflow Campaign Stats CSV containing all historical data. All months are auto-detected and saved — enabling the 12-month trend chart in the report.
      </p>
      <label style={{ display:'block', cursor: loading?'not-allowed':'pointer' }}>
        <div style={{ width:'100%', padding:'9px 0', background:'linear-gradient(135deg,#0f766e,#14b8a6)', borderRadius:9, color:'white', fontWeight:600, fontSize:13, textAlign:'center', opacity:loading?0.5:1 }}>
          {loading ? `Processing… ${progress}` : '📂 Upload Full History CSV'}
        </div>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} disabled={loading} style={{display:'none'}} />
      </label>
      {status && <p style={{ marginTop:10, fontSize:12, color: status.startsWith('✓')?'#14b8a6':status.startsWith('Error')?'#f43f5e':'rgba(148,163,184,0.7)', lineHeight:1.5 }}>{status}</p>}
    </div>
  )
}

// ── GHL Monitor View ──────────────────────────────────────────────────────

interface GhlFinding {
  rule_id: number | string
  title: string
  status: 'ok' | 'warning' | 'urgent' | 'error' | 'skipped'
  items: any[]
  count: number
  note?: string
  error?: string
}

interface GhlRun {
  id: number
  run_at: string
  triggered_by: string
  status: string
  findings_json: string
  summary: string
  duration_ms: number
}

function GhlMonitorView() {
  const [run, setRun]           = useState<GhlRun | null>(null)
  const [findings, setFindings] = useState<GhlFinding[]>([])
  const [running, setRunning]   = useState(false)
  const [expanded, setExpanded] = useState<Set<number | string>>(new Set())
  const [weeklyOn, setWeeklyOn]   = useState(true)
  const [monthlyOn, setMonthlyOn] = useState(true)
  const [savingCfg, setSavingCfg] = useState(false)

  useEffect(() => { load() }, [])

  async function load() {
    const r = await fetch('/api/ghl-monitor')
    if (r.ok) {
      const d = await r.json()
      if (d.run) {
        setRun(d.run)
        try { setFindings(JSON.parse(d.run.findings_json) || []) } catch {}
      }
      if (d.config) {
        if (d.config.weekly_enabled  !== undefined) setWeeklyOn(d.config.weekly_enabled  !== 'false')
        if (d.config.monthly_enabled !== undefined) setMonthlyOn(d.config.monthly_enabled !== 'false')
      }
    }
  }

  async function saveSchedule() {
    setSavingCfg(true)
    await fetch('/api/ghl-monitor', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'config', weekly_enabled: weeklyOn, monthly_enabled: monthlyOn })
    })
    setSavingCfg(false)
  }

  async function runNow() {
    setRunning(true)
    const r = await fetch('/api/ghl-monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ triggered_by: 'manual' }) })
    const d = await r.json()
    if (d.ok && d.run) {
      setRun(d.run)
      try { setFindings(JSON.parse(d.run.findings_json) || []) } catch {}
    }
    setRunning(false)
  }

  function toggleExpand(id: number | string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const statusColor = (s: string) =>
    s === 'urgent' ? '#f43f5e' : s === 'warning' ? '#f59e0b' : s === 'error' ? '#f97316' : s === 'skipped' ? 'rgba(148,163,184,0.3)' : '#10b981'

  const statusBg = (s: string) =>
    s === 'urgent' ? 'rgba(244,63,94,0.12)' : s === 'warning' ? 'rgba(245,158,11,0.1)' : s === 'error' ? 'rgba(249,115,22,0.1)' : s === 'skipped' ? 'rgba(148,163,184,0.05)' : 'rgba(16,185,129,0.08)'

  const statusLabel = (s: string) =>
    s === 'urgent' ? '🔴 URGENT' : s === 'warning' ? '🟡 Issues Found' : s === 'error' ? '⚠️ Error' : s === 'skipped' ? '— Skipped' : '🟢 All Clear'

  const overallColor = run ? statusColor(run.status) : 'rgba(148,163,184,0.4)'

  // Summary counts
  const urgentCount  = findings.filter(f => f.status === 'urgent').length
  const warningCount = findings.filter(f => f.status === 'warning').length
  const okCount      = findings.filter(f => f.status === 'ok').length

  return (
    <div style={{ padding: 24, maxWidth: 780, height: '100%', overflowY: 'auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 style={{ color: 'white', fontWeight: 700, fontSize: 22, margin: 0 }}>GHL Monitor</h1>
          <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 12, margin: '4px 0 0' }}>
            {run ? `Last run: ${new Date(run.run_at).toLocaleString('en-US', { timeZone: 'America/Phoenix' })} · ${run.duration_ms}ms` : 'Never run — click Run Now to start'}
          </p>
        </div>
        <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} onClick={runNow} disabled={running}
          style={{ background: running ? 'rgba(99,102,241,0.2)' : 'linear-gradient(135deg,#4338ca,#6366f1)', border: 'none', borderRadius: 10, padding: '9px 20px', color: 'white', fontWeight: 600, fontSize: 13, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.7 : 1 }}>
          {running ? '⏳ Running…' : '▶ Run Now'}
        </motion.button>
      </div>

      {/* Overall status banner */}
      {run && (
        <div style={{ background: statusBg(run.status), border: `1px solid ${overallColor}30`, borderRadius: 12, padding: '12px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ color: overallColor, fontWeight: 700, fontSize: 14 }}>{statusLabel(run.status)}</span>
          <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
            {urgentCount > 0  && <span style={{ color: '#f43f5e' }}>{urgentCount} urgent</span>}
            {warningCount > 0 && <span style={{ color: '#f59e0b' }}>{warningCount} warnings</span>}
            {okCount > 0      && <span style={{ color: '#10b981' }}>{okCount} clear</span>}
          </div>
        </div>
      )}

      {/* Schedule settings */}
      <div style={{ background:'rgba(15,20,35,0.7)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:12, padding:'14px 18px', marginBottom:16, display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:12 }}>
        <span style={{ color:'rgba(148,163,184,0.7)', fontSize:12, fontWeight:600 }}>AUTO-RUN SCHEDULE</span>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
            <div onClick={() => setWeeklyOn(v => !v)}
              style={{ width:36, height:20, borderRadius:10, background:weeklyOn?'#6366f1':'rgba(99,102,241,0.2)', position:'relative', transition:'background 0.2s', cursor:'pointer' }}>
              <div style={{ position:'absolute', top:2, left:weeklyOn?18:2, width:16, height:16, borderRadius:8, background:'white', transition:'left 0.2s' }} />
            </div>
            <span style={{ color:'rgba(148,163,184,0.7)', fontSize:12 }}>Weekly (Mon 07:45)</span>
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer' }}>
            <div onClick={() => setMonthlyOn(v => !v)}
              style={{ width:36, height:20, borderRadius:10, background:monthlyOn?'#6366f1':'rgba(99,102,241,0.2)', position:'relative', transition:'background 0.2s', cursor:'pointer' }}>
              <div style={{ position:'absolute', top:2, left:monthlyOn?18:2, width:16, height:16, borderRadius:8, background:'white', transition:'left 0.2s' }} />
            </div>
            <span style={{ color:'rgba(148,163,184,0.7)', fontSize:12 }}>Monthly (1st 07:45)</span>
          </label>
          <motion.button whileHover={{ scale:1.02 }} whileTap={{ scale:0.97 }} onClick={saveSchedule} disabled={savingCfg}
            style={{ background:'rgba(99,102,241,0.15)', border:'1px solid rgba(99,102,241,0.3)', borderRadius:8, padding:'5px 14px', color:'#a5b4fc', fontSize:12, fontWeight:600, cursor:'pointer' }}>
            {savingCfg ? 'Saving…' : 'Save'}
          </motion.button>
        </div>
      </div>

      {/* No run yet */}
      {!run && !running && (
        <div style={{ background: 'rgba(15,20,35,0.7)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 14, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
          <p style={{ color: 'rgba(148,163,184,0.5)', fontSize: 14 }}>Click "Run Now" to run the first GHL Monitor check.</p>
        </div>
      )}

      {/* Rule cards */}
      {findings.map(f => {
        const isOpen = expanded.has(f.rule_id)
        const color  = statusColor(f.status)
        const bg     = statusBg(f.status)
        return (
          <div key={f.rule_id} style={{ background: 'rgba(15,20,35,0.8)', border: `1px solid ${f.status !== 'ok' && f.status !== 'skipped' ? color + '40' : 'rgba(99,102,241,0.1)'}`, borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
            <div onClick={() => f.count > 0 && toggleExpand(f.rule_id)}
              style={{ padding: '12px 16px', cursor: f.count > 0 ? 'pointer' : 'default', background: f.status !== 'ok' && f.status !== 'skipped' ? bg : 'transparent' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, color, fontWeight: 700, minWidth: 28 }}>R{f.rule_id}</span>
                  <span style={{ color: 'white', fontSize: 13, fontWeight: 600 }}>{f.title}</span>
                  {(f as any).frequency && (
                    <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', background: 'rgba(99,102,241,0.08)', borderRadius: 4, padding: '1px 6px' }}>
                      {(f as any).frequency}
                    </span>
                  )}
                  {f.note && <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.4)', fontStyle: 'italic' }}>{f.note}</span>}
                </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {f.count > 0 && (
                  <span style={{ background: color + '20', border: `1px solid ${color}40`, borderRadius: 20, padding: '2px 10px', color, fontSize: 11, fontWeight: 700 }}>
                    {f.count} {f.count === 1 ? 'item' : 'items'}
                  </span>
                )}
                <span style={{ fontSize: 11, color }}>{statusLabel(f.status)}</span>
                {f.count > 0 && <span style={{ color: 'rgba(148,163,184,0.4)', fontSize: 12 }}>{isOpen ? '▲' : '▼'}</span>}
              </div>
              </div>
              {(f as any).reason && (
                <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.5)', marginTop: 4, paddingLeft: 2 }}>
                  {(f as any).reason}
                </div>
              )}
            </div>

            {/* Expanded items */}
            {isOpen && f.items.length > 0 && (
              <div style={{ borderTop: `1px solid ${color}20`, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {f.items.map((item: any, idx: number) => (
                  <div key={idx} style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
                    {/* Rule-specific rendering */}
                    {item.name !== undefined && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span style={{ color: 'white', fontWeight: 600 }}>{item.name || 'Unknown'}</span>
                        {item.email && <span style={{ color: 'rgba(148,163,184,0.6)' }}>{item.email}</span>}
                        {item.flag && <span style={{ color: '#f59e0b' }}>{item.flag}</span>}
                        {item.age_days !== undefined && <span style={{ color: item.age_days >= 7 ? '#f43f5e' : 'rgba(148,163,184,0.5)' }}>{item.age_days}d old</span>}
                        {item.overdue_days !== undefined && <span style={{ color: '#f43f5e' }}>{item.overdue_days}d overdue</span>}
                        {item.days_in_stage !== undefined && <span style={{ color: '#f59e0b' }}>{item.days_in_stage}d in "{item.stage}"</span>}
                        {item.hours_waiting !== undefined && <span style={{ color: '#f59e0b' }}>{item.hours_waiting}h waiting</span>}
                      </div>
                    )}
                    {item.contact_name !== undefined && !item.name && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'white', fontWeight: 600 }}>{item.contact_name}</span>
                        {item.matched_phrase && <span style={{ color: '#f59e0b' }}>"{item.matched_phrase}"</span>}
                        {item.hours_waiting !== undefined && <span style={{ color: '#f59e0b' }}>{item.hours_waiting}h waiting</span>}
                        {item.message_preview && <span style={{ color: 'rgba(148,163,184,0.5)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.message_preview}</span>}
                      </div>
                    )}
                    {item.task !== undefined && (
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'white', fontWeight: 600 }}>{item.task}</span>
                        {item.designer && <span style={{ color: '#a5b4fc' }}>{item.designer}</span>}
                        {item.client_name && <span style={{ color: 'rgba(148,163,184,0.6)' }}>{item.client_name}</span>}
                        {item.age_days !== undefined && <span style={{ color: '#f59e0b' }}>{item.age_days}d old</span>}
                      </div>
                    )}
                    {item.employee_id !== undefined && (
                      <div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                          <span style={{ color: 'white', fontWeight: 600 }}>Employee: {item.employee_id}</span>
                          <span style={{ color: '#f59e0b' }}>{item.task_count} overdue task{item.task_count !== 1 ? 's' : ''}</span>
                        </div>
                        {(item.tasks || []).map((t: any, ti: number) => (
                          <div key={ti} style={{ fontSize: 11, color: 'rgba(148,163,184,0.6)', paddingLeft: 8 }}>
                            • {t.task} ({t.overdue_days}d overdue)
                          </div>
                        ))}
                      </div>
                    )}
                    {item.category !== undefined && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: '#a5b4fc', fontWeight: 600, fontSize: 11 }}>{item.category}</span>
                        <span style={{ color: 'white' }}>{item.source || 'Unknown'}</span>
                        <span style={{ color: '#f59e0b', fontWeight: 700 }}>{item.count} booked</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Error state */}
            {f.status === 'error' && f.error && (
              <div style={{ borderTop: '1px solid rgba(249,115,22,0.2)', padding: '8px 16px', fontSize: 11, color: '#f97316' }}>
                {f.error}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── MCD Context Sources Panel ──────────────────────────────────────────────

interface McdContextSource {
  id: number; label: string; url: string; doc_id: string; doc_type: string
  tab_name: string; enabled: boolean; content_cache: string | null; cached_at: string | null
  created_at: string
}

function McdContextSourcesPanel() {
  const [sources, setSources] = useState<McdContextSource[]>([])
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [tab, setTab] = useState('')
  const [adding, setAdding] = useState(false)
  const [refreshingId, setRefreshingId] = useState<number|null>(null)
  const [expandingId, setExpandingId] = useState<number|null>(null)
  const [msg, setMsg] = useState<{text:string;ok:boolean}|null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    const r = await fetch('/api/mcd/context-sources')
    if (r.ok) { const d = await r.json(); setSources(d.sources || []) }
  }

  function flash(text: string, ok: boolean) {
    setMsg({text, ok})
    setTimeout(() => setMsg(null), 3500)
  }

  async function add() {
    if (!url.trim() || !label.trim()) return
    setAdding(true)
    const r = await fetch('/api/mcd/context-sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim(), label: label.trim(), tab_name: tab.trim() })
    })
    const d = await r.json()
    if (d.ok) {
      flash(d.chars ? `✅ Added — ${d.chars.toLocaleString()} chars fetched` : `✅ Added (content pending)`, true)
      setUrl(''); setLabel(''); setTab('')
    } else {
      flash(`❌ ${d.error}`, false)
    }
    setAdding(false); load()
  }

  async function refresh(src: McdContextSource) {
    setRefreshingId(src.id)
    const r = await fetch('/api/mcd/context-sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'refresh', id: src.id })
    })
    const d = await r.json()
    d.ok ? flash(`✅ Refreshed — ${d.chars?.toLocaleString() || 0} chars`, true) : flash(`❌ ${d.error}`, false)
    setRefreshingId(null); load()
  }

  async function expand(src: McdContextSource) {
    setExpandingId(src.id)
    const r = await fetch('/api/mcd/context-sources', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'expand', id: src.id })
    })
    const d = await r.json()
    if (d.ok) {
      d.added > 0
        ? flash(`✅ Added ${d.added} linked source${d.added !== 1 ? 's' : ''}`, true)
        : flash(`ℹ️ ${d.message || 'No new links found'}`, true)
    } else {
      flash(`❌ ${d.error}`, false)
    }
    setExpandingId(null); load()
  }

  async function toggle(src: McdContextSource) {
    await fetch('/api/mcd/context-sources', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: src.id, enabled: !src.enabled })
    })
    load()
  }

  async function remove(id: number) {
    await fetch(`/api/mcd/context-sources?id=${id}`, { method: 'DELETE' })
    load()
  }

  const inputSt: React.CSSProperties = { background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:8, padding:'8px 10px', color:'white', fontSize:12, outline:'none', width:'100%', boxSizing:'border-box' }

  return (
    <div style={{ background:'rgba(15,20,35,0.8)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:20, marginBottom:16 }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
        <Layers size={14} color="#a5b4fc" />
        <span style={{ color:'white', fontWeight:600, fontSize:14 }}>MCD Context Sources</span>
      </div>
      <p style={{ fontSize:12, color:'rgba(148,163,184,0.45)', marginBottom:14, lineHeight:1.6 }}>
        Add Google Docs or Sheets that MCD should read as background context — no code changes needed.
        Content is fetched and cached; use Refresh to re-pull after edits.
      </p>

      {/* Add form */}
      <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:14 }}>
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label — e.g. 'Q3 Initiatives'" style={inputSt} />
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Google Doc or Sheet URL" style={inputSt} />
        <input value={tab} onChange={e => setTab(e.target.value)} placeholder="Sheet tab name (optional, Sheets only)" style={inputSt} />
        <motion.button whileHover={{ scale:1.01 }} whileTap={{ scale:0.98 }} onClick={add}
          disabled={adding || !url.trim() || !label.trim()}
          style={{ padding:'8px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:8, color:'white', fontSize:12, fontWeight:600, cursor:'pointer', opacity:(!url.trim()||!label.trim())?0.45:1 }}>
          {adding ? 'Adding…' : '+ Add Source'}
        </motion.button>
      </div>

      {msg && <div style={{ padding:'6px 12px', borderRadius:8, background:msg.ok?'rgba(16,185,129,0.08)':'rgba(244,63,94,0.08)', border:`1px solid ${msg.ok?'rgba(16,185,129,0.2)':'rgba(244,63,94,0.2)'}`, color:msg.ok?'#10b981':'#f43f5e', fontSize:12, marginBottom:10 }}>{msg.text}</div>}

      {sources.length === 0 && <p style={{ color:'rgba(148,163,184,0.3)', fontSize:12, textAlign:'center', margin:0 }}>No context sources yet.</p>}

      {sources.map(src => (
        <div key={src.id} style={{ padding:'10px 0', borderBottom:'1px solid rgba(99,102,241,0.07)', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ color:src.enabled?'white':'rgba(148,163,184,0.4)', fontWeight:600, fontSize:13 }}>{src.label}</span>
              <span style={{ fontSize:10, color:'rgba(148,163,184,0.3)', background:'rgba(99,102,241,0.08)', borderRadius:4, padding:'1px 6px' }}>{src.doc_type}{src.tab_name ? ` · ${src.tab_name}` : ''}</span>
            </div>
            <div style={{ fontSize:11, color:'rgba(148,163,184,0.3)', marginTop:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:320 }}>
              {src.cached_at ? `${src.content_cache?.length?.toLocaleString() || 0} chars — ${new Date(src.cached_at).toLocaleDateString()}` : 'Not fetched yet'}
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
            {/* Toggle */}
            <button onClick={() => toggle(src)} title={src.enabled?'Disable':'Enable'}
              style={{ background:src.enabled?'rgba(16,185,129,0.15)':'rgba(99,102,241,0.08)', border:`1px solid ${src.enabled?'rgba(16,185,129,0.3)':'rgba(99,102,241,0.2)'}`, borderRadius:6, padding:'4px 8px', color:src.enabled?'#10b981':'rgba(148,163,184,0.5)', fontSize:11, cursor:'pointer' }}>
              {src.enabled ? 'ON' : 'OFF'}
            </button>
            {/* Expand links — doc only */}
            {src.doc_type === 'doc' && (
              <button onClick={() => expand(src)} disabled={expandingId === src.id} title="Scan this doc for Google links and add them as sources"
                style={{ background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:6, padding:'4px 7px', color:'#a5b4fc', cursor:'pointer', opacity:expandingId===src.id?0.5:1, fontSize:11 }}>
                {expandingId === src.id ? '…' : '↗'}
              </button>
            )}
            {/* Refresh */}
            <button onClick={() => refresh(src)} disabled={refreshingId === src.id} title="Re-fetch from Google"
              style={{ background:'rgba(99,102,241,0.08)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:6, padding:'4px 7px', color:'#a5b4fc', cursor:'pointer', opacity:refreshingId===src.id?0.5:1 }}>
              <RefreshCw size={11} />
            </button>
            {/* Delete */}
            <button onClick={() => remove(src.id)} title="Remove"
              style={{ background:'none', border:'none', color:'rgba(244,63,94,0.4)', cursor:'pointer', padding:'4px' }}>
              <Trash2 size={12} />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Settings View ─────────────────────────────────────────────────────────

function SettingsView({ agents = [] }: { agents?: Agent[] }) {
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
      <UsersPanel />
      <OutputTemplatesPanel />
      <CompanyKbPanel />
      <WebhooksPanel />
      <DriveSyncPanel agents={agents} />
      <ApiKeysPanel />
      <McdContextSourcesPanel />
      <EmailHealthBaselinePanel />
      <WorkflowImportPanel />
      <WorkflowHistoryPanel />
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
  const [newTaskId, setNewTaskId]      = useState<number | null>(null)
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
    if (res.ok) {
      const json = await res.json()
      addToast('Task dispatched: ' + data.title, 'success')
      if (json.taskId) setNewTaskId(json.taskId)
      setTimeout(fetchAll, 800)
    } else {
      addToast('Failed to dispatch task', 'error')
    }
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); setShowSemanticSearch(s => !s) } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  const liveSelectedAgent = selectedAgent ? agents.find(a => a.id === selectedAgent.id) || selectedAgent : null

  function mainContent() {
    if (liveSelectedAgent) return (
      <AgentDetailView agent={liveSelectedAgent} onBack={() => setSelectedAgent(null)} onRunTask={a => setRunAgent(a)} onDelete={id => { setAgents(prev => prev.filter(a => a.id !== id)); setSelectedAgent(null) }} newTaskId={newTaskId} onNewTaskConsumed={() => setNewTaskId(null)} />
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
      case 'tasks':      return <TasksView tasks={tasks} agents={agents} />
      case 'terminal':   return <TerminalView agents={agents} metrics={metrics} />
      case 'schedules':  return <SchedulesView agents={agents} />
      case 'analytics':  return <AnalyticsView />
      case 'email-health': return <EmailHealthReportView />
      case 'mcd-reports':  return <McdReportsView />
      case 'ghl-monitor':  return <GhlMonitorView />
      case 'hermes':     return <HermesView messages={messages} onSend={handleSend} loading={chatLoading} />
      case 'projects':   return <ProjectsView agents={agents} onSelectAgent={a => { setSelectedAgent(a); setView('agents') }} />
      case 'triggers':   return <TriggersPanel agents={agents} />
      case 'skills':     return <SkillsView />
      case 'pipelines':  return <PipelinesView agents={agents} />
      case 'settings':   return <SettingsView agents={agents} />
      default: return null
    }
  }

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [showSemanticSearch, setShowSemanticSearch] = useState(false)
  const [showApprovals, setShowApprovals] = useState(false)

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#080c14', color: 'white', fontFamily: 'Inter, sans-serif', overflow: 'hidden', position: 'relative' }}>
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', backgroundImage: 'linear-gradient(rgba(99,102,241,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.03) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      <Sidebar view={view} setView={v => { setView(v); setSelectedAgent(null) }} agents={agents} onLogout={handleLogout} onSearch={() => setShowSearch(true)} />

      <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 12, right: 16, zIndex: 20 }}>
          <PendingApprovalsBadge onClick={() => setShowApprovals(true)} />
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={liveSelectedAgent?.id || view} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} style={{ minHeight: '100%' }}>
            {mainContent()}
          </motion.div>
        </AnimatePresence>
      </div>

      <MCDPanel />

      <AnimatePresence>
        {runAgent && <RunTaskModal agent={runAgent} onClose={() => setRunAgent(null)} onSubmit={handleRunTask} />}
      </AnimatePresence>
      <AnimatePresence>
        {showSearch && <GlobalSearch onClose={() => setShowSearch(false)} onNavigate={(v, id) => { setView(v); setSelectedAgent(null) }} />}
      </AnimatePresence>
      <ToastContainer toasts={toasts} remove={id => setToasts(t => t.filter(x => x.id !== id))} />
      <AnimatePresence>
        {showSemanticSearch && <SemanticSearchModal onClose={() => setShowSemanticSearch(false)} onNavigate={(agentId) => { const ag = agents.find(a => a.id === agentId); if(ag) setSelectedAgent(ag) }} />}
      </AnimatePresence>
      <AnimatePresence>
        {showApprovals && <ApprovalsModal onClose={() => setShowApprovals(false)} />}
      </AnimatePresence>
    </div>
  )
}
