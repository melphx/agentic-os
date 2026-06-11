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


// ── Email Health Report View ───────────────────────────────────────────────

function EmailHealthReportView() {
  const todayStr = new Date().toISOString().slice(0,10)
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10)
  const [startDate, setStartDate] = useState(firstOfMonth)
  const [endDate, setEndDate] = useState(todayStr)
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<any | null>(null)
  const [error, setError] = useState('')
  const [postmasterData, setPostmasterData] = useState<any | null>(null)
  const [postmasterConnected, setPostmasterConnected] = useState(false)
  const [backend, setBackend] = useState<{configured:boolean;domain:string}|null>(null)
  const [snapshotInfo, setSnapshotInfo] = useState<{snapshot_dates:string[];total_records:number}|null>(null)
  const [takingSnapshot, setTakingSnapshot] = useState(false)
  const [showSnapshots, setShowSnapshots] = useState(false)

  useEffect(() => {
    fetch('/api/reports/email-health').then(r=>r.json()).then(d=>setBackend(d)).catch(()=>{})
    fetch('/api/postmaster/oauth?action=status').then(r=>r.json()).then(d=>setPostmasterConnected(d.connected)).catch(()=>{})
    fetch('/api/reports/email-snapshot').then(r=>r.json()).then(d=>setSnapshotInfo(d)).catch(()=>{})
  }, [])

  async function takeSnapshot() {
    setTakingSnapshot(true)
    try {
      const r = await fetch('/api/reports/email-snapshot', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) })
      const d = await r.json()
      if (d.ok) {
        setSnapshotInfo(prev => ({ snapshot_dates: [...(prev?.snapshot_dates||[]), d.snapshot_date].filter((v,i,a)=>a.indexOf(v)===i).sort(), total_records: (prev?.total_records||0)+d.saved }))
        alert(`Snapshot saved for ${d.snapshot_date}: ${d.saved} campaigns captured. Select a date range starting from this date to see delta stats.`)
      } else { alert('Snapshot failed: '+(d.error||'unknown')) }
    } catch(e:any) { alert('Error: '+e.message) }
    finally { setTakingSnapshot(false) }
  }

  async function generate() {
    setLoading(true); setError(''); setReport(null); setPostmasterData(null)
    try {
      const r = await fetch('/api/reports/email-health', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate, endDate }),
      })
      const d = await r.json()
      if (!r.ok) { setError(d.error || 'Failed'); return }
      setReport(d)
      if (postmasterConnected) {
        fetch('/api/postmaster/data?domain=l.phxhomeremodeling.com')
          .then(r2=>r2.json()).then(pd=>{ if(!pd.error) setPostmasterData(pd) }).catch(()=>{})
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const sc = !report ? '#6366f1' : report.health_score >= 800 ? '#10b981' : report.health_score >= 650 ? '#06b6d4' : report.health_score >= 500 ? '#f59e0b' : report.health_score >= 300 ? '#f43f5e' : '#dc2626'
  const pct = (n: number, d: number) => d > 0 ? (n/d*100).toFixed(1)+'%' : '0%'

  const badge = (level: string) => {
    const colors: Record<string,string> = { high:'#f43f5e', medium:'#f59e0b', low:'#06b6d4' }
    return <span style={{ padding:'1px 6px', borderRadius:4, background:`${colors[level]}20`, border:`1px solid ${colors[level]}40`, color:colors[level], fontSize:9, fontWeight:700, textTransform:'uppercase' as const, marginRight:6 }}>{level}</span>
  }

  return (
    <div style={{ height:'100%', overflowY:'auto', background:'#080c14' }}>
      {/* Sticky top bar */}
      <div style={{ padding:'12px 22px', borderBottom:'1px solid rgba(99,102,241,0.1)', display:'flex', alignItems:'center', justifyContent:'space-between', background:'rgba(15,20,35,0.97)', position:'sticky', top:0, zIndex:10, gap:8, flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ color:'white', fontWeight:700, fontSize:15 }}>📧 Email Health Report</span>
          {backend?.configured && <span style={{ fontSize:10, color:'#10b981', background:'rgba(16,185,129,0.1)', border:'1px solid rgba(16,185,129,0.2)', padding:'1px 7px', borderRadius:10 }}>Connected</span>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <span style={{ color:'rgba(148,163,184,0.4)', fontSize:11 }}>From</span>
            <input type="date" value={startDate} max={todayStr} onChange={e=>setStartDate(e.target.value)}
              style={{ background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, padding:'5px 8px', color:'white', fontSize:12, outline:'none', fontFamily:'inherit', colorScheme:'dark' }} />
            <span style={{ color:'rgba(148,163,184,0.4)', fontSize:11 }}>To</span>
            <input type="date" value={endDate} max={todayStr} onChange={e=>{ const v=e.target.value; setEndDate(v>todayStr?todayStr:v) }}
              style={{ background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, padding:'5px 8px', color:'white', fontSize:12, outline:'none', fontFamily:'inherit', colorScheme:'dark' }} />
          </div>
          <div style={{ display:'flex', gap:4 }}>
            <button onClick={()=>{ const t=new Date(); setStartDate(new Date(t.getFullYear(),t.getMonth(),1).toISOString().slice(0,10)); setEndDate(t.toISOString().slice(0,10)) }} style={{ padding:'4px 8px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:6, color:'#a5b4fc', fontSize:10, cursor:'pointer' }}>This Month</button>
            <button onClick={()=>{ const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-7); setStartDate(s.toISOString().slice(0,10)); setEndDate(t.toISOString().slice(0,10)) }} style={{ padding:'4px 8px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:6, color:'#a5b4fc', fontSize:10, cursor:'pointer' }}>Last 7d</button>
            <button onClick={()=>{ const t=new Date(); const s=new Date(t); s.setDate(t.getDate()-30); setStartDate(s.toISOString().slice(0,10)); setEndDate(t.toISOString().slice(0,10)) }} style={{ padding:'4px 8px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:6, color:'#a5b4fc', fontSize:10, cursor:'pointer' }}>Last 30d</button>
          </div>
          {!postmasterConnected && <button onClick={()=>{window.location.href='/api/postmaster/oauth?action=start'}} style={{ padding:'5px 10px', background:'rgba(16,185,129,0.1)', border:'1px solid rgba(16,185,129,0.2)', borderRadius:7, color:'#10b981', fontSize:11, cursor:'pointer' }}>+ Postmaster</button>}
          <motion.button whileHover={{scale:1.02}} whileTap={{scale:0.98}} onClick={generate} disabled={loading}
            style={{ padding:'7px 16px', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:8, color:'white', fontWeight:700, fontSize:12, cursor:'pointer', opacity:loading?0.6:1 }}>
            {loading?'⏳ Generating…':'⚡ Generate'}
          </motion.button>
          <div style={{ position:'relative' }}>
            <button onClick={()=>setShowSnapshots(s=>!s)}
              style={{ padding:'5px 10px', background: snapshotInfo?.snapshot_dates?.length ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', border:`1px solid ${snapshotInfo?.snapshot_dates?.length ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'}`, borderRadius:7, color: snapshotInfo?.snapshot_dates?.length ? '#10b981' : '#f59e0b', fontSize:11, cursor:'pointer', flexShrink:0 }}>
              {snapshotInfo?.snapshot_dates?.length ? `📸 ${snapshotInfo.snapshot_dates.length} snapshot${snapshotInfo.snapshot_dates.length>1?'s':''}` : '📸 Snapshots'} ▾
            </button>
            {showSnapshots && (
              <div style={{ position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:50, background:'rgba(12,16,28,0.98)', border:'1px solid rgba(99,102,241,0.25)', borderRadius:12, padding:14, minWidth:240, boxShadow:'0 16px 40px rgba(0,0,0,0.5)' }}>
                <div style={{ color:'white', fontWeight:600, fontSize:12, marginBottom:10 }}>Snapshots</div>
                <button onClick={async()=>{ await takeSnapshot(); setShowSnapshots(false) }} disabled={takingSnapshot}
                  style={{ width:'100%', padding:'7px 0', background:'linear-gradient(135deg,#4338ca,#6366f1)', border:'none', borderRadius:7, color:'white', fontSize:11, fontWeight:600, cursor:'pointer', marginBottom:10 }}>
                  {takingSnapshot ? '⏳ Taking…' : '📸 Take Snapshot Today'}
                </button>
                {snapshotInfo?.snapshot_dates?.length ? (
                  <div style={{ maxHeight:200, overflowY:'auto' }}>
                    {[...snapshotInfo.snapshot_dates].sort((a,b)=>b.localeCompare(a)).map(date=>(
                      <div key={date} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid rgba(99,102,241,0.07)' }}>
                        <span style={{ color:'rgba(148,163,184,0.8)', fontSize:12 }}>{date}</span>
                        <button onClick={async()=>{
                          if(!confirm(`Delete snapshot for ${date}?`)) return
                          await fetch(`/api/reports/email-snapshot?date=${date}`, { method:'DELETE' })
                          setSnapshotInfo(prev => prev ? { ...prev, snapshot_dates: prev.snapshot_dates.filter(d=>d!==date) } : prev)
                        }} style={{ background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.2)', borderRadius:5, color:'#f87171', fontSize:10, padding:'2px 7px', cursor:'pointer' }}>
                          Delete
                        </button>
                      </div>
                    ))}
                  </div>
                ) : <p style={{ color:'rgba(148,163,184,0.4)', fontSize:11, margin:0 }}>No snapshots yet</p>}
              </div>
            )}
          </div>
          {report && <button onClick={()=>{
            const html = buildEmailReportHTML(report, postmasterData)
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([html],{type:'text/html'}))
            a.download = `email-health-${startDate}-to-${endDate}.html`; a.click()
          }} style={{ padding:'5px 10px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.2)', borderRadius:7, color:'#a5b4fc', fontSize:11, cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
            <Download size={11}/> Export
          </button>}
        </div>
      </div>

      {error && <div style={{ margin:16, padding:'10px 14px', background:'rgba(244,63,94,0.08)', border:'1px solid rgba(244,63,94,0.2)', borderRadius:9, color:'#f43f5e', fontSize:13 }}>{error}</div>}

      {!report && !loading && (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', minHeight:'60vh', gap:14, padding:40, textAlign:'center' }}>
          <div style={{ fontSize:44 }}>📧</div>
          <h2 style={{ color:'white', fontWeight:700, fontSize:20, margin:0 }}>Email Health Report</h2>
          <p style={{ color:'rgba(148,163,184,0.5)', fontSize:13, maxWidth:400 }}>Select a month and generate your full email deliverability report — powered by HitTheInbox data from GHL and Google Postmaster.</p>
        </div>
      )}

      {report && (
        <div style={{ maxWidth:900, margin:'0 auto', padding:'20px 24px 60px' }}>

          {/* ── 1. SCORE HERO ── */}
          <div style={{ background:`linear-gradient(135deg,${sc}18,rgba(15,20,35,0.95))`, border:`1px solid ${sc}30`, borderRadius:16, padding:'24px 28px', marginBottom:14, display:'flex', alignItems:'center', gap:24 }}>
            <div style={{ flexShrink:0, textAlign:'center' }}>
              <div style={{ fontSize:58, fontWeight:900, color:sc, lineHeight:1 }}>{report.health_score}</div>
              <div style={{ color:'rgba(148,163,184,0.35)', fontSize:9, marginTop:3 }}>out of 999</div>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                <span style={{ color:sc, fontWeight:800, fontSize:22 }}>{report.score_label}</span>
                <span style={{ padding:'1px 8px', background:'rgba(99,102,241,0.1)', border:'1px solid rgba(99,102,241,0.15)', borderRadius:20, color:'rgba(148,163,184,0.4)', fontSize:9 }}>Strict Email Health Score</span>
              </div>
              <p style={{ color:'rgba(148,163,184,0.6)', fontSize:12, margin:'0 0 6px', lineHeight:1.5 }}>{report.analysis?.score_explanation_strict || 'Your Strict Email Health Score reflects how well subscribers who were emailed in the last month engaged.'}</p>
              <div style={{ display:'flex', gap:16 }}>
                <div><span style={{ color:'rgba(148,163,184,0.4)', fontSize:10 }}>STRICT </span><span style={{ color:sc, fontWeight:700, fontSize:13 }}>{report.strict_score}</span></div>
                <div><span style={{ color:'rgba(148,163,184,0.4)', fontSize:10 }}>RELAXED </span><span style={{ color:'#06b6d4', fontWeight:700, fontSize:13 }}>{report.relaxed_score}</span></div>
                <div><span style={{ color:'rgba(148,163,184,0.35)', fontSize:10 }}>{report.month_label} via HighLevel</span></div>
              </div>
            </div>
          </div>

          {/* ── 2. ANALYST NOTES ── */}
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:8 }}>Analyst Notes</div>
            <p style={{ color:'rgba(148,163,184,0.8)', fontSize:13.5, margin:0, lineHeight:1.7 }}>{report.analysis?.analyst_notes || 'Generating analysis…'}</p>
          </div>

          {/* ── 3. EXECUTIVE SUMMARY ── */}
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>Executive Summary</div>
            {Array.isArray(report.analysis?.executive_summary_bullets) && report.analysis.executive_summary_bullets.map((b:string,i:number)=>(
              <div key={i} style={{ display:'flex', gap:10, padding:'7px 0', borderBottom:'1px solid rgba(99,102,241,0.06)' }}>
                <span style={{ color:'#6366f1', flexShrink:0, fontSize:14 }}>•</span>
                <span style={{ color:'rgba(148,163,184,0.75)', fontSize:13 }}>{b}</span>
              </div>
            ))}
          </div>

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

          {/* ── 5. ACTIONS TO TAKE ── */}
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>Actions to Take</div>
            {[
              { key:'actions_high', level:'high', items: report.analysis?.actions_high },
              { key:'actions_medium', level:'medium', items: report.analysis?.actions_medium },
              { key:'actions_low', level:'low', items: report.analysis?.actions_low },
            ].map(({key, level, items})=> Array.isArray(items) && items.map((a:string,i:number)=>(
              <div key={key+i} style={{ display:'flex', gap:8, padding:'8px 0', borderBottom:'1px solid rgba(99,102,241,0.06)', alignItems:'flex-start' }}>
                <span style={{ flexShrink:0, marginTop:1 }}>{badge(level)}</span>
                <span style={{ color:'rgba(148,163,184,0.75)', fontSize:13, lineHeight:1.55 }}>{a}</span>
              </div>
            )))}
          </div>

          {/* ── 6. EMAIL PERFORMANCE ── */}
          {report.stats.campaigns_analyzed > 0 && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>📊 Email Performance — {report.stats.campaigns_analyzed} Workflow Campaigns</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:14 }}>
                {[['Engagement Rate',report.stats.open_rate+'%',true],['Open Rate',report.stats.open_rate+'%',report.stats.open_rate>=25],['Click Rate',report.stats.click_rate+'%',report.stats.click_rate>=3],['Bounce Rate',report.stats.bounce_rate+'%',report.stats.bounce_rate<2],['Spam Rate',report.stats.spam_rate+'%',report.stats.spam_rate<0.1],['Total Sent',report.stats.total_sent.toLocaleString(),true]].map(([l,v,g])=>(
                  <div key={l as string} style={{ background:'rgba(99,102,241,0.06)', borderRadius:9, padding:'10px 12px' }}>
                    <div style={{ fontSize:10, color:'rgba(148,163,184,0.4)', marginBottom:2, textTransform:'uppercase' as const }}>{l}</div>
                    <div style={{ fontSize:18, fontWeight:700, color:(g as boolean)?'#10b981':'#f43f5e' }}>{v}</div>
                  </div>
                ))}
              </div>
              {/* Engagement table */}
              {report.engagement_table && (
                <>
                  <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, textTransform:'uppercase' as const, marginBottom:8, letterSpacing:'0.05em' }}>Engagement This Period</div>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                    <thead>
                      <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.15)' }}>
                        {['','# Mailed','% Opened','% Clicked'].map(h=>(
                          <th key={h} style={{ padding:'5px 10px', textAlign:'left', color:'rgba(148,163,184,0.4)', fontWeight:600, fontSize:10, textTransform:'uppercase' as const }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                        <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.8)', fontSize:12 }}>Existing Subscribers</td>
                        <td style={{ padding:'7px 10px', color:'white', fontWeight:600, fontSize:12 }}>{report.engagement_table.existing.mailed.toLocaleString()}</td>
                        <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.engagement_table.existing.open_pct}%</td>
                        <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.engagement_table.existing.click_pct}%</td>
                      </tr>
                      <tr>
                        <td style={{ padding:'7px 10px', color:'rgba(148,163,184,0.8)', fontSize:12 }}>New Subscribers</td>
                        <td style={{ padding:'7px 10px', color:'white', fontWeight:600, fontSize:12 }}>{report.engagement_table.new_subs.mailed.toLocaleString()}</td>
                        <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.engagement_table.new_subs.open_pct}%</td>
                        <td style={{ padding:'7px 10px', color:'#10b981', fontWeight:600, fontSize:12 }}>{report.engagement_table.new_subs.click_pct}%</td>
                      </tr>
                    </tbody>
                  </table>
                  <p style={{ color:'rgba(148,163,184,0.3)', fontSize:10, margin:'8px 0 0' }}>* Campaign stats are all-time totals. Monthly filtering requires GHL email campaign API scope.</p>
                </>
              )}
            </div>
          )}

          {/* ── 7. AUDIENCE BREAKDOWN ── */}
          <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
            <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:4 }}>Audience Breakdown</div>
            <p style={{ color:'rgba(148,163,184,0.35)', fontSize:11, margin:'0 0 14px' }}>Engagement quality of your existing contact list</p>
            <div style={{ display:'flex', height:10, borderRadius:8, overflow:'hidden', marginBottom:14 }}>
              {([
                [report.segments.active,'#10b981'],[report.segments.warmingUp,'#06b6d4'],
                [report.segments.cold,'#f59e0b'],[report.segments.dead,'#f43f5e'],
              ] as [number,string][]).map(([n,c],i)=>(
                <div key={i} style={{ width:`${report.segments.total>0?n/report.segments.total*100:0}%`, background:c, minWidth:n>0?3:0 }}/>
              ))}
            </div>
            {[
              { label:'Best Assets', sub:'Have opened something in the last 30 days', count:report.segments.active, color:'#10b981' },
              { label:'Assets', sub:'Have opened something in the last 30-90 days', count:report.segments.warmingUp, color:'#06b6d4' },
              { label:'Liabilities', sub:'Have only opened in the last 90-365 days', count:report.segments.cold, color:'#f59e0b' },
              { label:'Worst Liabilities', sub:"Haven't opened in over a year, or have never opened", count:report.segments.dead, color:'#f43f5e' },
            ].map(s=>(
              <div key={s.label} style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0', borderBottom:'1px solid rgba(99,102,241,0.06)' }}>
                <div style={{ width:9, height:9, borderRadius:'50%', background:s.color, flexShrink:0 }}/>
                <div style={{ flex:1 }}><span style={{ color:'white', fontSize:13, fontWeight:600 }}>{s.label} </span><span style={{ color:'rgba(148,163,184,0.4)', fontSize:11 }}>{s.sub}</span></div>
                <span style={{ color:'white', fontWeight:700, fontSize:13 }}>{s.count.toLocaleString()}</span>
                <span style={{ color:'rgba(148,163,184,0.3)', fontSize:11, width:44, textAlign:'right' as const }}>{pct(s.count, report.segments.total)}</span>
              </div>
            ))}
            <div style={{ display:'flex', gap:16, marginTop:12, padding:'10px 14px', background:'rgba(99,102,241,0.05)', borderRadius:9 }}>
              {[['Contacts',report.segments.total,'#a5b4fc'],['Opted Out',report.segments.optedOut,'rgba(148,163,184,0.5)'],['Marketable',report.segments.marketable,'#10b981'],['New',report.segments.new,'#6366f1']].map(([l,v,c])=>(
                <div key={l as string} style={{ flex:1, textAlign:'center' as const }}>
                  <div style={{ fontSize:18, fontWeight:700, color:c as string }}>{(v as number).toLocaleString()}</div>
                  <div style={{ fontSize:9, color:'rgba(148,163,184,0.4)', marginTop:2, textTransform:'uppercase' as const }}>{l}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ── 8. EMAIL QUALITY + PROVIDERS ── */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px' }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:10 }}>Email Quality</div>
              {[['✅ Safe to send',report.quality.green,'#10b981'],['🚫 Do not send',report.quality.red,'#f43f5e'],['⚠️ Bounced',report.quality.bounced,'#f59e0b'],['🚨 Spam risk',report.quality.spam,'#dc2626'],['❓ Invalid',report.quality.notFound,'rgba(148,163,184,0.4)'],['🔀 Catchall',report.quality.catchall,'rgba(148,163,184,0.4)']].map(([l,c,col])=>(
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

          {/* ── 9. DMARC + GOOGLE SIGNALS ── */}
          {postmasterData && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
                <div>
                  <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:10 }}>DMARC Compliance</div>
                  <div style={{ fontSize:28, fontWeight:800, color:'#10b981', marginBottom:4 }}>{postmasterData.dmarc_success_ratio!=null?(postmasterData.dmarc_success_ratio*100).toFixed(1)+'%':'N/A'}</div>
                  <div style={{ color:'rgba(148,163,184,0.4)', fontSize:10, marginBottom:10 }}>Excellent DMARC Compliance Score</div>
                  {[['SPF', postmasterData.spf_success_ratio],['DKIM', postmasterData.dkim_success_ratio]].map(([l,v])=>(
                    <div key={l as string} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0' }}>
                      <span style={{ color:'rgba(148,163,184,0.5)', fontSize:12 }}>{l as string}</span>
                      <span style={{ color:'#10b981', fontWeight:700, fontSize:12 }}>{(v as number)!=null?((v as number)*100).toFixed(1)+'%':'N/A'}</span>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:10 }}>Google Signals</div>
                  {[['l.phxhomeremodeling.com', postmasterData.domain_reputation],['phxhomeremodeling.com', postmasterData.domain_reputation]].map(([d,rep])=>(
                    <div key={d as string} style={{ marginBottom:8 }}>
                      <div style={{ color:'rgba(148,163,184,0.5)', fontSize:10, marginBottom:2 }}>{d}</div>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        <div style={{ width:8, height:8, borderRadius:'50%', background: rep==='HIGH'?'#10b981':'#f59e0b' }}/>
                        <span style={{ color: rep==='HIGH'?'#10b981':'#f59e0b', fontWeight:700, fontSize:13 }}>Domain Reputation: {rep}</span>
                      </div>
                    </div>
                  ))}
                  {postmasterData.spam_rate != null && (
                    <div style={{ marginTop:6, padding:'6px 10px', background:'rgba(16,185,129,0.06)', borderRadius:7 }}>
                      <span style={{ color:'rgba(148,163,184,0.5)', fontSize:10 }}>GMAIL SPAM RATE </span>
                      <span style={{ color:'#10b981', fontWeight:700, fontSize:13 }}>{(postmasterData.spam_rate*100).toFixed(3)}%</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── 10. WORKFLOW TABLE ── */}
          {report.workflows && report.workflows.length > 0 && (
            <div style={{ background:'rgba(15,20,35,0.9)', border:'1px solid rgba(99,102,241,0.12)', borderRadius:14, padding:'16px 20px', marginBottom:12 }}>
              <div style={{ color:'#a5b4fc', fontWeight:700, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase' as const, marginBottom:12 }}>Workflow Campaign Details</div>
              <div style={{ overflowX:'auto' as const }}>
                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                  <thead>
                    <tr style={{ borderBottom:'1px solid rgba(99,102,241,0.15)' }}>
                      {['Workflow','Sent','Open %','Click %','Bounce %','Spam %'].map(h=>(
                        <th key={h} style={{ padding:'5px 8px', textAlign:'left' as const, color:'rgba(148,163,184,0.4)', fontWeight:600, fontSize:9, textTransform:'uppercase' as const }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(report.workflows as any[]).map((w:any)=>(
                      <tr key={w.name} style={{ borderBottom:'1px solid rgba(99,102,241,0.05)' }}>
                        <td style={{ padding:'6px 8px', color:'rgba(148,163,184,0.8)', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' as const }} title={w.name}>{w.name.length>35?w.name.slice(0,35)+'…':w.name}</td>
                        <td style={{ padding:'6px 8px', color:'white', fontWeight:600 }}>{w.sent.toLocaleString()}</td>
                        <td style={{ padding:'6px 8px', color:w.openRate>=25?'#10b981':'#f59e0b', fontWeight:600 }}>{w.openRate.toFixed(1)}%</td>
                        <td style={{ padding:'6px 8px', color:w.clickRate>=3?'#10b981':'#f59e0b', fontWeight:600 }}>{w.clickRate.toFixed(1)}%</td>
                        <td style={{ padding:'6px 8px', color:w.bounced/w.sent*100<2?'#10b981':'#f43f5e', fontWeight:600 }}>{w.sent>0?(w.bounced/w.sent*100).toFixed(2):0}%</td>
                        <td style={{ padding:'6px 8px', color:w.complaintRate<0.1?'#10b981':'#f43f5e', fontWeight:600 }}>{w.complaintRate.toFixed(3)}%</td>
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
  const sc = report.health_score >= 800 ? '#10b981' : report.health_score >= 650 ? '#06b6d4' : report.health_score >= 500 ? '#f59e0b' : report.health_score >= 300 ? '#f43f5e' : '#dc2626'
  const pct = (n: number, d: number) => d > 0 ? (n/d*100).toFixed(1)+'%' : '0%'
  const seg = report.segments || {}
  const et = report.engagement_table

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Email Health Report - ${report.month_label}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#080c14;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;padding:32px;max-width:900px;margin:0 auto}
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
    <div style="font-size:64px;font-weight:900;color:${sc};line-height:1">${report.health_score}</div>
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
<div class="card"><div class="title">Analyst Notes</div><p>${report.analysis?.analyst_notes||''}</p></div>

<!-- EXECUTIVE SUMMARY -->
<div class="card"><div class="title">Executive Summary</div>
  ${Array.isArray(report.analysis?.executive_summary_bullets)?report.analysis.executive_summary_bullets.map((b:string)=>`<p>• ${b}</p>`).join(''):''}
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
<div class="card"><div class="title">Actions to Take</div>
  ${['high','medium','low'].map((level:string)=>{
    const items:string[] = report.analysis?.[`actions_${level}`]||[]
    return items.map((a:string)=>`
      <div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid rgba(99,102,241,.06)">
        <span class="badge-${level}" style="flex-shrink:0;margin-top:2px">${level}</span>
        <span style="color:rgba(148,163,184,.8);font-size:13px">${a}</span>
      </div>`).join('')
  }).join('')}
</div>

<!-- EMAIL PERFORMANCE STATS -->
${report.stats.campaigns_analyzed>0?`
<div class="card">
  <div class="title">Email Performance — ${report.stats.campaigns_analyzed} Workflows</div>
  <div style="display:flex;margin-bottom:8px">
    ${[['Engagement',report.stats.open_rate+'%'],['Open Rate',report.stats.open_rate+'%'],['Click Rate',report.stats.click_rate+'%'],['Bounce Rate',report.stats.bounce_rate+'%'],['Spam Rate',report.stats.spam_rate+'%'],['Total Sent',report.stats.total_sent.toLocaleString()]].map(([l,v])=>`
    <div class="kpi"><div class="kpi-val">${v}</div><div class="kpi-lbl">${l}</div></div>`).join('')}
  </div>
</div>`:''}

<!-- ENGAGEMENT TABLE -->
${et?`
<div class="card">
  <div class="title">Engagement This Period</div>
  <table>
    <tr><th>Segment</th><th>Mailed</th><th>Open %</th><th>Click %</th></tr>
    <tr>
      <td style="color:white;font-weight:600">Existing Subscribers</td>
      <td style="color:white;font-weight:600">${et.existing?.mailed?.toLocaleString()||'—'}</td>
      <td style="color:#10b981;font-weight:600">${et.existing?.open_pct||'—'}%</td>
      <td style="color:#10b981;font-weight:600">${et.existing?.click_pct||'—'}%</td>
    </tr>
    <tr>
      <td style="color:white;font-weight:600">New Subscribers</td>
      <td style="color:white;font-weight:600">${et.new_subs?.mailed?.toLocaleString()||'—'}</td>
      <td style="color:#10b981;font-weight:600">${et.new_subs?.open_pct||'—'}%</td>
      <td style="color:#10b981;font-weight:600">${et.new_subs?.click_pct||'—'}%</td>
    </tr>
  </table>
</div>`:''}

<!-- SEGMENTS -->
${seg.total?`
<div class="card">
  <div class="title">List Health — Engagement Segments</div>
  <p style="color:rgba(148,163,184,.35);font-size:11px;margin-bottom:12px">Engagement quality of your existing contact list</p>
  <!-- Segment bar -->
  <div style="display:flex;height:10px;border-radius:5px;overflow:hidden;margin-bottom:16px;background:rgba(99,102,241,.08)">
    ${[[seg.active,'#10b981'],[seg.warmingUp,'#06b6d4'],[seg.cold,'#f59e0b'],[seg.dead,'#f43f5e']].map(([n,c])=>`<div style="width:${seg.total>0?(n as number)/seg.total*100:0}%;background:${c};min-width:${(n as number)>0?3:0}px"></div>`).join('')}
  </div>
  ${[
    {label:'Best Assets',sub:'Opened in last 30 days',count:seg.active,color:'#10b981'},
    {label:'Assets',sub:'Opened in last 30-90 days',count:seg.warmingUp,color:'#06b6d4'},
    {label:'Liabilities',sub:'Opened in last 90-365 days',count:seg.cold,color:'#f59e0b'},
    {label:'Worst Liabilities',sub:'Never opened or over 1 year',count:seg.dead,color:'#f43f5e'},
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
        <span style="color:${s.color};font-weight:700;font-size:15px">${(s.count as number).toLocaleString()}</span>
        <span style="color:rgba(148,163,184,.3);font-size:11px;margin-left:6px">${pct(s.count as number,seg.total)}</span>
      </div>
    </div>`).join('')}
  <!-- Summary stats -->
  <div style="display:flex;gap:0;margin-top:14px;border-top:1px solid rgba(99,102,241,.08);padding-top:12px">
    ${[['Contacts',seg.total,'#a5b4fc'],['Opted Out',seg.optedOut,'rgba(148,163,184,.5)'],['Marketable',seg.marketable,'#10b981'],['New',seg.new,'#6366f1']].map(([l,v,c])=>`
    <div style="flex:1;text-align:center">
      <div style="font-size:18px;font-weight:700;color:${c}">${(v as number).toLocaleString()}</div>
      <div style="font-size:9px;color:rgba(148,163,184,.4);text-transform:uppercase;margin-top:2px">${l}</div>
    </div>`).join('')}
  </div>
</div>`:''}

<!-- EMAIL QUALITY + PROVIDERS -->
<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
  <div class="card">
    <div class="title">Email Quality</div>
    ${[['✅ Safe to send',report.quality?.green,'#10b981'],['🚫 Do not send',report.quality?.red,'#f43f5e'],['⚠️ Bounced',report.quality?.bounced,'#f59e0b'],['🚨 Spam risk',report.quality?.spam,'#dc2626']].map(([l,c,col])=>`
    <div class="row"><span>${l}</span><span style="color:${col};font-weight:700">${((c||0) as number).toLocaleString()}</span></div>`).join('')}
  </div>
  <div class="card">
    <div class="title">Marketable by Provider</div>
    ${report.providers?[['Gmail',report.providers.google],['Yahoo',report.providers.yahoo],['Outlook',report.providers.microsoft],['Other',report.providers.other]].map(([l,c])=>`
    <div class="row"><span>${l}</span><span style="color:white;font-weight:700">${((c||0) as number).toLocaleString()} (${pct((c||0) as number,report.providers.scanned)})</span></div>`).join(''):'<p>No provider data</p>'}
  </div>
</div>

<!-- DMARC + GOOGLE SIGNALS -->
${pm?`
<div class="card" style="border-color:rgba(16,185,129,.15)">
  <div class="title">DMARC &amp; Google Postmaster Signals</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
    <div>
      <div style="color:rgba(148,163,184,.4);font-size:10px;margin-bottom:8px">DMARC Compliance</div>
      <div style="font-size:28px;font-weight:700;color:#10b981">${pm.dmarc_success_ratio!=null?(pm.dmarc_success_ratio*100).toFixed(1)+'%':'N/A'}</div>
      <div style="color:rgba(148,163,184,.4);font-size:11px;margin-top:4px">Excellent DMARC Compliance Score</div>
      <div style="margin-top:12px">
        <div class="row"><span>SPF Pass Rate</span><span style="color:#10b981;font-weight:700">${pm.spf_success_ratio!=null?(pm.spf_success_ratio*100).toFixed(0)+'%':'N/A'}</span></div>
        <div class="row"><span>DKIM Pass Rate</span><span style="color:#10b981;font-weight:700">${pm.dkim_success_ratio!=null?(pm.dkim_success_ratio*100).toFixed(0)+'%':'N/A'}</span></div>
      </div>
    </div>
    <div>
      <div style="color:rgba(148,163,184,.4);font-size:10px;margin-bottom:8px">Domain Reputation</div>
      <div style="font-size:22px;font-weight:700;color:#10b981">${pm.domain_reputation||'UNKNOWN'}</div>
      <div style="margin-top:12px">
        <div class="row"><span>Spam Rate</span><span style="color:white;font-weight:700">${pm.spam_rate!=null?(pm.spam_rate*100).toFixed(3)+'%':'N/A'}</span></div>
        <div class="row"><span>Inbox Rate</span><span style="color:#10b981;font-weight:700">${pm.inbox_placement_rate!=null?(pm.inbox_placement_rate*100).toFixed(1)+'%':'N/A'}</span></div>
      </div>
    </div>
  </div>
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
    if (res.ok) {
      const json = await res.json()
      addToast('Task dispatched: ' + data.title, 'success')
      // Auto-select the new task so SSE connects immediately (before task completes)
      if (json.taskId) setNewTaskId(json.taskId)
      setTimeout(fetchAll, 800)
    } else {
      addToast('Failed to dispatch task', 'error')
    }
  }

  // Ctrl+Shift+F for semantic search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.ctrlKey && e.shiftKey && e.key === 'F') { e.preventDefault(); setShowSemanticSearch(s => !s) } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.href = '/login'
  }

  // Inject updated sparklines into selectedAgent
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
      case 'tasks':    return <TasksView tasks={tasks} agents={agents} />
      case 'terminal': return <TerminalView agents={agents} metrics={metrics} />
      case 'schedules': return <SchedulesView agents={agents} />
      case 'analytics':  return <AnalyticsView />
      case 'email-health': return <EmailHealthReportView />
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
      {/* Grid bg */}
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

      <ChatPanel messages={messages} onSend={handleSend} loading={chatLoading} />

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
