'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutGrid, Cpu, CheckSquare, Terminal, Settings,
  Activity, Zap, MessageCircle, Send, RefreshCw,
  Code2, FileText, Mail, Search, BarChart3, Shield,
  Bot, Loader2, Bell, Plus, TrendingUp, Sparkles,
  ChevronRight, ArrowLeft, MoreHorizontal,
  Clock, Hash,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type AgentStatus = 'active' | 'idle' | 'processing' | 'error'
type ViewType = 'dashboard' | 'agents' | 'tasks' | 'terminal' | 'settings'

interface Agent {
  id: string
  name: string
  short: string
  description: string
  icon: React.ElementType
  status: AgentStatus
  task: string
  tokens: number
  tasks: number
  accent: string
  accentDark: string
  progress: number
  uptime: string
  avgResponse: string
  sparkline: number[]
}

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: Date
}

interface MsgGroup {
  role: 'user' | 'assistant'
  msgs: Message[]
}

interface ActivityItem {
  id: string
  agent: string
  action: string
  detail: string
  time: string
  accent: string
}

interface Metric {
  id: string
  label: string
  value: number | string
  change: string
  icon: React.ElementType
  accent: string
  up: boolean
}

// ─────────────────────────────────────────────────────────────
// AGENT DATA
// ─────────────────────────────────────────────────────────────

const AGENTS: Agent[] = [
  {
    id: 'research', name: 'Research Agent', short: 'RES',
    description: 'Web intelligence & data synthesis',
    icon: Search, status: 'active',
    task: 'Analyzing market trends Q2 2026',
    tokens: 42500, tasks: 127,
    accent: '#06b6d4', accentDark: '#0e7490',
    progress: 67, uptime: '99.8%', avgResponse: '1.1s',
    sparkline: [30, 45, 38, 60, 55, 70, 65, 80, 75, 85, 78, 90],
  },
  {
    id: 'code', name: 'Code Engineer', short: 'ENG',
    description: 'Architecture & development',
    icon: Code2, status: 'processing',
    task: 'Refactoring authentication module',
    tokens: 78300, tasks: 89,
    accent: '#6366f1', accentDark: '#4338ca',
    progress: 43, uptime: '99.2%', avgResponse: '2.3s',
    sparkline: [50, 55, 70, 65, 80, 75, 85, 90, 82, 88, 95, 92],
  },
  {
    id: 'data', name: 'Data Analyst', short: 'DAT',
    description: 'Insights, metrics & reporting',
    icon: BarChart3, status: 'active',
    task: 'Processing sales pipeline data',
    tokens: 31200, tasks: 204,
    accent: '#10b981', accentDark: '#047857',
    progress: 31, uptime: '100%', avgResponse: '0.9s',
    sparkline: [40, 35, 50, 45, 55, 60, 52, 65, 70, 68, 72, 75],
  },
  {
    id: 'writer', name: 'Content Writer', short: 'WRT',
    description: 'Copy, content & communications',
    icon: FileText, status: 'idle',
    task: 'Awaiting next assignment',
    tokens: 12800, tasks: 156,
    accent: '#f59e0b', accentDark: '#b45309',
    progress: 0, uptime: '98.7%', avgResponse: '1.8s',
    sparkline: [60, 55, 45, 50, 40, 35, 42, 38, 30, 28, 25, 20],
  },
  {
    id: 'email', name: 'Email Manager', short: 'EML',
    description: 'Inbox management & outreach',
    icon: Mail, status: 'active',
    task: 'Drafting outreach campaign #7',
    tokens: 55600, tasks: 412,
    accent: '#f43f5e', accentDark: '#be123c',
    progress: 78, uptime: '99.5%', avgResponse: '1.4s',
    sparkline: [45, 55, 50, 65, 60, 75, 70, 80, 78, 85, 82, 88],
  },
  {
    id: 'security', name: 'Security Analyst', short: 'SEC',
    description: 'Threat detection & compliance',
    icon: Shield, status: 'active',
    task: 'Monitoring for anomalies — all clear',
    tokens: 23400, tasks: 67,
    accent: '#a855f7', accentDark: '#7c3aed',
    progress: 90, uptime: '99.9%', avgResponse: '0.7s',
    sparkline: [85, 88, 82, 90, 87, 92, 89, 94, 91, 95, 93, 96],
  },
]

const AGENT_TASKS: Record<string, Array<{ text: string; done: boolean; active?: boolean }>> = {
  research: [
    { text: 'Scraped 34 sources on AI investment trends', done: true },
    { text: 'Summarized competitor product launches', done: true },
    { text: 'Analyzed Q1 2026 market reports', done: true },
    { text: 'Analyzing market trends Q2 2026', done: false, active: true },
    { text: 'Draft comprehensive industry report', done: false },
  ],
  code: [
    { text: 'Built REST API endpoints for /users', done: true },
    { text: 'Fixed memory leak in cache module', done: true },
    { text: 'Wrote unit tests for auth service', done: true },
    { text: 'Refactoring authentication module', done: false, active: true },
    { text: 'Code review: payment gateway PR', done: false },
  ],
  data: [
    { text: 'Generated Q1 revenue dashboard', done: true },
    { text: 'Analyzed user retention cohorts', done: true },
    { text: 'Built predictive churn model', done: true },
    { text: 'Processing sales pipeline data', done: false, active: true },
    { text: 'Forecast model for Q3 2026', done: false },
  ],
  writer: [
    { text: 'Blog post: 10 AI trends in 2026', done: true },
    { text: 'Product launch email sequence', done: true },
    { text: 'Case study: enterprise customer win', done: true },
    { text: 'Awaiting next assignment', done: false, active: false },
    { text: 'SEO article: AI automation guide', done: false },
  ],
  email: [
    { text: 'Handled 47 support inquiries', done: true },
    { text: 'Outreach campaign #5 — 312 sent', done: true },
    { text: 'Replied to 8 investor emails', done: true },
    { text: 'Drafting outreach campaign #7', done: false, active: true },
    { text: 'Partnership proposal follow-ups', done: false },
  ],
  security: [
    { text: 'Audit: AWS IAM permissions', done: true },
    { text: 'Scanned codebase for vulnerabilities', done: true },
    { text: 'Reviewed 3rd-party dependencies', done: true },
    { text: 'Monitoring for anomalies', done: false, active: true },
    { text: 'Quarterly compliance report', done: false },
  ],
}

const SEED_ACTIVITIES: ActivityItem[] = [
  { id: '1', agent: 'Code Engineer',    action: 'Task Completed', detail: 'Generated 847 lines of TypeScript',       time: '2s ago',  accent: '#6366f1' },
  { id: '2', agent: 'Research Agent',   action: 'Data Retrieved', detail: 'Scraped 34 sources · 2.1 MB processed',  time: '18s ago', accent: '#06b6d4' },
  { id: '3', agent: 'Data Analyst',     action: 'Processing',     detail: 'Running statistical analysis on Q2 data', time: '1m ago',  accent: '#10b981' },
  { id: '4', agent: 'Email Manager',    action: 'Emails Sent',    detail: 'Campaign sent to 247 contacts',           time: '3m ago',  accent: '#f43f5e' },
  { id: '5', agent: 'Security Analyst', action: 'Alert Resolved', detail: 'Suspicious login attempt blocked',        time: '7m ago',  accent: '#a855f7' },
]

const LIVE_POOL: ActivityItem[] = [
  { id: '', agent: 'Research Agent',   action: 'Search Complete', detail: 'Found 12 relevant articles on AI trends', time: 'just now', accent: '#06b6d4' },
  { id: '', agent: 'Code Engineer',    action: 'PR Created',      detail: 'Opened pull request #142 for review',     time: 'just now', accent: '#6366f1' },
  { id: '', agent: 'Data Analyst',     action: 'Report Ready',    detail: 'Weekly analytics report generated',        time: 'just now', accent: '#10b981' },
  { id: '', agent: 'Email Manager',    action: 'Reply Drafted',   detail: 'Responded to 8 high-priority emails',      time: 'just now', accent: '#f43f5e' },
  { id: '', agent: 'Security Analyst', action: 'Scan Complete',   detail: 'Zero vulnerabilities in latest deploy',    time: 'just now', accent: '#a855f7' },
  { id: '', agent: 'Content Writer',   action: 'Draft Complete',  detail: 'Blog post outline reviewed — 1,200 words', time: 'just now', accent: '#f59e0b' },
]

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────

function groupMessages(msgs: Message[]): MsgGroup[] {
  const groups: MsgGroup[] = []
  msgs.forEach(m => {
    const last = groups[groups.length - 1]
    const prev = last?.msgs[last.msgs.length - 1]
    const diff = prev ? (m.ts.getTime() - prev.ts.getTime()) / 60000 : Infinity
    if (last && last.role === m.role && diff < 3) {
      last.msgs.push(m)
    } else {
      groups.push({ role: m.role, msgs: [m] })
    }
  })
  return groups
}

function formatTime(d: Date) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

// ─────────────────────────────────────────────────────────────
// SPARKLINE
// ─────────────────────────────────────────────────────────────

function Sparkline({ data, color, w = 72, h = 22 }: {
  data: number[]; color: string; w?: number; h?: number
}) {
  const max = Math.max(...data)
  const min = Math.min(...data)
  const rng = max - min || 1
  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - ((v - min) / rng) * (h - 3) - 1.5,
  }))
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const gid = `sg${color.replace(/[^a-z0-9]/gi, '')}`

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} fill="none">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r={2.5} fill={color} />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────
// AGENT AVATAR
// ─────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<AgentStatus, string> = {
  active:     '#10b981',
  processing: '#818cf8',
  idle:       '#475569',
  error:      '#f43f5e',
}

const AVATAR_SIZES = {
  xs: { box: 24, icon: 10, dot: 6,  dotBorder: 2 },
  sm: { box: 32, icon: 13, dot: 8,  dotBorder: 2 },
  md: { box: 42, icon: 17, dot: 11, dotBorder: 2.5 },
  lg: { box: 56, icon: 22, dot: 13, dotBorder: 3 },
  xl: { box: 76, icon: 30, dot: 16, dotBorder: 3 },
}

function AgentAvatar({
  agent,
  size = 'md',
  showStatus = false,
  pulse = false,
}: {
  agent: Agent
  size?: keyof typeof AVATAR_SIZES
  showStatus?: boolean
  pulse?: boolean
}) {
  const Icon = agent.icon
  const s = AVATAR_SIZES[size]
  const radius = Math.round(s.box * 0.32)

  return (
    <div className="relative flex-shrink-0" style={{ width: s.box, height: s.box }}>
      <motion.div
        className="flex items-center justify-center"
        style={{
          width: s.box, height: s.box,
          borderRadius: radius,
          background: `linear-gradient(145deg, ${agent.accent}ee, ${agent.accentDark})`,
          boxShadow: `0 4px 18px ${agent.accent}40, inset 0 1px 0 rgba(255,255,255,0.18)`,
        }}
        animate={pulse ? {
          boxShadow: [
            `0 4px 18px ${agent.accent}30`,
            `0 4px 30px ${agent.accent}70`,
            `0 4px 18px ${agent.accent}30`,
          ]
        } : {}}
        transition={{ duration: 2, repeat: Infinity }}
      >
        <Icon
          size={s.icon}
          className="text-white"
          style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.4))' }}
        />
      </motion.div>

      {showStatus && (
        <div
          className="absolute bottom-0 right-0 rounded-full"
          style={{
            width: s.dot, height: s.dot,
            background: STATUS_COLORS[agent.status],
            border: `${s.dotBorder}px solid #030712`,
            boxShadow: `0 0 8px ${STATUS_COLORS[agent.status]}70`,
          }}
        />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CHAT AVATARS
// ─────────────────────────────────────────────────────────────

function ClaudeAvatar({ size = 30 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 rounded-full"
      style={{
        width: size, height: size,
        background: 'linear-gradient(145deg, #4338ca, #6366f1)',
        boxShadow: '0 0 14px rgba(99,102,241,0.45)',
      }}
    >
      <Sparkles size={Math.round(size * 0.44)} className="text-white" />
    </div>
  )
}

function UserAvatar({ size = 30, initial = 'M' }: { size?: number; initial?: string }) {
  return (
    <div
      className="flex items-center justify-center flex-shrink-0 rounded-full font-bold text-white"
      style={{
        width: size, height: size,
        background: 'linear-gradient(145deg, #6366f1, #a855f7)',
        fontSize: Math.round(size * 0.38),
        boxShadow: '0 0 12px rgba(168,85,247,0.35)',
      }}
    >
      {initial}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// PARTICLE BACKGROUND
// ─────────────────────────────────────────────────────────────

function ParticleBackground() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    let raf: number
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight }
    resize()
    window.addEventListener('resize', resize)

    const COLORS = ['#6366f1', '#06b6d4', '#a855f7', '#10b981']
    const pts = Array.from({ length: 85 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * 0.22,
      vy: (Math.random() - 0.5) * 0.22,
      r: Math.random() * 1.4 + 0.4,
      op: Math.random() * 0.45 + 0.1,
      c: COLORS[Math.floor(Math.random() * COLORS.length)],
    }))

    let t = 0
    const draw = () => {
      const W = canvas.width, H = canvas.height
      ctx.clearRect(0, 0, W, H)
      ctx.strokeStyle = 'rgba(99,102,241,0.035)'
      ctx.lineWidth = 1
      const G = 58
      for (let x = 0; x < W; x += G) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
      for (let y = 0; y < H; y += G) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }

      const sy = (t * 0.22) % H
      const sg = ctx.createLinearGradient(0, sy - 130, 0, sy + 130)
      sg.addColorStop(0, 'rgba(99,102,241,0)')
      sg.addColorStop(0.5, 'rgba(99,102,241,0.03)')
      sg.addColorStop(1, 'rgba(99,102,241,0)')
      ctx.fillStyle = sg; ctx.fillRect(0, sy - 130, W, 260)

      pts.forEach(p => {
        p.x = (p.x + p.vx + W) % W
        p.y = (p.y + p.vy + H) % H
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = p.c + Math.round(p.op * 255).toString(16).padStart(2, '0')
        ctx.fill()
      })
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x, dy = pts[i].y - pts[j].y
          const d = Math.sqrt(dx * dx + dy * dy)
          if (d < 105) {
            ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y)
            ctx.strokeStyle = `rgba(99,102,241,${0.055 * (1 - d / 105)})`
            ctx.lineWidth = 0.5; ctx.stroke()
          }
        }
      }
      t++; raf = requestAnimationFrame(draw)
    }
    draw()
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize) }
  }, [])

  return <canvas ref={ref} className="fixed inset-0 pointer-events-none z-0" />
}

// ─────────────────────────────────────────────────────────────
// STATUS BADGE
// ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: AgentStatus }) {
  const MAP = {
    active:     { color: '#10b981', label: 'Active',     pulse: true  },
    processing: { color: '#818cf8', label: 'Processing', pulse: true  },
    idle:       { color: '#475569', label: 'Idle',       pulse: false },
    error:      { color: '#f43f5e', label: 'Error',      pulse: true  },
  }
  const c = MAP[status]
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative">
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: c.color }} />
        {c.pulse && (
          <motion.div className="absolute inset-0 rounded-full" style={{ background: c.color }}
            animate={{ scale: [1, 2.8], opacity: [0.8, 0] }}
            transition={{ duration: 2, repeat: Infinity }} />
        )}
      </div>
      <span className="text-[11px] font-semibold" style={{ color: c.color }}>{c.label}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// AGENT CARD  (clickable)
// ─────────────────────────────────────────────────────────────

function AgentCard({ agent, index, onClick }: {
  agent: Agent; index: number; onClick: () => void
}) {
  const [hov, setHov] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0, y: 30, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ delay: index * 0.055, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      whileHover={{ y: -5, scale: 1.02 }}
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      onHoverStart={() => setHov(true)}
      onHoverEnd={() => setHov(false)}
      className="relative overflow-hidden rounded-2xl cursor-pointer"
      style={{
        background: 'rgba(13,20,38,0.85)',
        backdropFilter: 'blur(28px)',
        border: `1px solid ${hov ? agent.accent + '45' : 'rgba(148,163,184,0.07)'}`,
        boxShadow: hov
          ? `0 0 50px ${agent.accent}14, 0 24px 60px rgba(0,0,0,0.5)`
          : '0 4px 24px rgba(0,0,0,0.25)',
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
    >
      {/* top line */}
      <motion.div className="absolute top-0 inset-x-0 h-px"
        style={{ background: `linear-gradient(90deg,transparent,${agent.accent}90,transparent)` }}
        animate={{ opacity: hov ? 1 : 0.35 }} />

      {/* subtle bg tint */}
      <div className="absolute inset-0 rounded-2xl opacity-[0.07]"
        style={{ background: `radial-gradient(circle at 20% 20%, ${agent.accent}, transparent 60%)` }} />

      <div className="relative p-4">
        {/* avatar + status */}
        <div className="flex items-start justify-between mb-3.5">
          <AgentAvatar agent={agent} size="md" showStatus pulse={agent.status === 'processing'} />
          <StatusBadge status={agent.status} />
        </div>

        {/* name */}
        <div className="mb-3">
          <h3 className="text-[15px] font-bold text-slate-100 leading-tight mb-0.5">{agent.name}</h3>
          <p className="text-[11px] text-slate-500 leading-tight">{agent.description}</p>
        </div>

        {/* task pill */}
        <div className="mb-3 px-2.5 py-2 rounded-xl text-[11px] text-slate-400 leading-relaxed"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <span className="font-mono mr-1.5 opacity-60" style={{ color: agent.accent }}>›</span>
          {agent.task}
        </div>

        {/* progress */}
        {agent.progress > 0 && (
          <div className="mb-3">
            <div className="flex justify-between text-[10px] mb-1.5">
              <span className="text-slate-600">Progress</span>
              <span style={{ color: agent.accent }}>{agent.progress}%</span>
            </div>
            <div className="h-[3px] bg-slate-800/80 rounded-full overflow-hidden">
              <motion.div className="h-full rounded-full"
                style={{ background: `linear-gradient(90deg,${agent.accentDark},${agent.accent})` }}
                initial={{ width: 0 }}
                animate={{ width: `${agent.progress}%` }}
                transition={{ duration: 1.3, delay: index * 0.055 + 0.3, ease: [0.16, 1, 0.3, 1] }}
              />
            </div>
          </div>
        )}

        {/* footer: stats + sparkline */}
        <div className="flex items-end justify-between">
          <div className="text-[10px] text-slate-600 space-y-0.5">
            <div><span className="text-slate-400 font-semibold">{agent.tasks}</span> tasks</div>
            <div><span className="text-slate-400 font-semibold">{(agent.tokens / 1000).toFixed(1)}k</span> tokens</div>
          </div>
          <Sparkline data={agent.sparkline} color={agent.accent} w={68} h={22} />
        </div>
      </div>

      {/* hover reveal cta */}
      <AnimatePresence>
        {hov && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="absolute inset-x-0 bottom-0 flex justify-center pb-3.5 pt-10"
            style={{ background: `linear-gradient(0deg,${agent.accent}22 0%,transparent 100%)` }}
          >
            <div className="flex items-center gap-1.5 text-[11px] font-bold px-3.5 py-1.5 rounded-full"
              style={{
                background: `${agent.accent}20`,
                border: `1px solid ${agent.accent}50`,
                color: agent.accent,
              }}>
              Open Agent <ChevronRight size={10} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────
// AGENT DETAIL VIEW
// ─────────────────────────────────────────────────────────────

function AgentDetailView({
  agent,
  activities,
  onBack,
  onAskClaude,
}: {
  agent: Agent
  activities: ActivityItem[]
  onBack: () => void
  onAskClaude: (msg: string) => void
}) {
  const agentActivities = activities.filter(a => a.agent === agent.name).slice(0, 5)
  const tasks = AGENT_TASKS[agent.id] || []

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      {/* back */}
      <motion.button
        initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
        onClick={onBack}
        whileHover={{ x: -2 }} whileTap={{ scale: 0.95 }}
        className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 mb-5 transition-colors group"
      >
        <ArrowLeft size={13} className="group-hover:-translate-x-0.5 transition-transform" />
        Back
      </motion.button>

      {/* hero card */}
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative overflow-hidden rounded-2xl p-5 mb-5"
        style={{
          background: 'rgba(13,20,38,0.9)',
          backdropFilter: 'blur(28px)',
          border: `1px solid ${agent.accent}30`,
          boxShadow: `0 0 60px ${agent.accent}10`,
        }}
      >
        {/* bg glow */}
        <div className="absolute inset-0 opacity-[0.06] rounded-2xl"
          style={{ background: `radial-gradient(circle at 0% 50%, ${agent.accent}, transparent 65%)` }} />
        <div className="absolute top-0 inset-x-0 h-px"
          style={{ background: `linear-gradient(90deg,transparent,${agent.accent}80,transparent)` }} />

        <div className="relative flex items-center gap-5">
          <AgentAvatar agent={agent} size="xl" showStatus />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-black text-slate-100 mb-0.5">{agent.name}</h1>
            <p className="text-sm text-slate-400 mb-2">{agent.description}</p>
            <StatusBadge status={agent.status} />
          </div>
          <div className="hidden md:flex flex-col items-end gap-1">
            <Sparkline data={agent.sparkline} color={agent.accent} w={100} h={36} />
            <span className="text-[10px] text-slate-600">Token activity</span>
          </div>
        </div>
      </motion.div>

      {/* stats row */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Tasks Complete', value: agent.tasks, icon: CheckSquare, color: agent.accent },
          { label: 'Tokens Used',    value: `${(agent.tokens/1000).toFixed(1)}k`, icon: Zap, color: '#f59e0b' },
          { label: 'Uptime',         value: agent.uptime,       icon: Activity,  color: '#10b981' },
          { label: 'Avg Response',   value: agent.avgResponse,  icon: Clock,     color: '#a855f7' },
        ].map((s, i) => (
          <motion.div key={s.label}
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.06 }}
            className="rounded-2xl px-4 py-3 relative overflow-hidden"
            style={{
              background: 'rgba(13,20,38,0.85)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(148,163,184,0.07)',
            }}>
            <div className="absolute -top-4 -right-4 w-16 h-16 rounded-full opacity-[0.08]"
              style={{ background: s.color }} />
            <div className="relative">
              <s.icon size={13} className="mb-2" style={{ color: s.color }} />
              <div className="text-xl font-bold text-slate-100">{s.value}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{s.label}</div>
            </div>
          </motion.div>
        ))}
      </div>

      {/* two-col layout */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-5">
        {/* current task + task history */}
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="rounded-2xl overflow-hidden"
          style={{
            background: 'rgba(13,20,38,0.85)',
            backdropFilter: 'blur(24px)',
            border: '1px solid rgba(148,163,184,0.07)',
          }}>
          <div className="px-4 py-3 border-b border-slate-800/80">
            <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Task Queue</span>
          </div>
          <div className="p-3 space-y-1.5">
            {tasks.map((t, i) => (
              <motion.div key={i}
                initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + i * 0.04 }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
                style={{
                  background: t.active ? `${agent.accent}10` : 'rgba(255,255,255,0.02)',
                  border: t.active ? `1px solid ${agent.accent}25` : '1px solid transparent',
                }}>
                <div className={`w-4 h-4 rounded-lg flex items-center justify-center flex-shrink-0`}
                  style={{
                    background: t.done
                      ? 'rgba(16,185,129,0.15)'
                      : t.active
                        ? `${agent.accent}20`
                        : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${t.done ? '#10b98130' : t.active ? agent.accent + '40' : 'rgba(255,255,255,0.08)'}`,
                  }}>
                  {t.done
                    ? <span className="text-[9px] text-emerald-400">✓</span>
                    : t.active
                      ? <motion.div className="w-1.5 h-1.5 rounded-full" style={{ background: agent.accent }}
                          animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} />
                      : <span className="text-[9px] text-slate-700">○</span>
                  }
                </div>
                <span className={`text-xs leading-snug ${t.done ? 'text-slate-600 line-through' : t.active ? 'text-slate-200 font-medium' : 'text-slate-400'}`}>
                  {t.text}
                </span>
                {t.active && (
                  <span className="ml-auto text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: `${agent.accent}20`, color: agent.accent }}>
                    LIVE
                  </span>
                )}
              </motion.div>
            ))}
          </div>

          {/* progress if active */}
          {agent.progress > 0 && (
            <div className="px-4 pb-4">
              <div className="flex justify-between text-[10px] mb-1.5">
                <span className="text-slate-600">Current task progress</span>
                <span style={{ color: agent.accent }}>{agent.progress}%</span>
              </div>
              <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                <motion.div className="h-full rounded-full"
                  style={{ background: `linear-gradient(90deg,${agent.accentDark},${agent.accent})` }}
                  initial={{ width: 0 }} animate={{ width: `${agent.progress}%` }}
                  transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }} />
              </div>
            </div>
          )}
        </motion.div>

        {/* activity + chat cta */}
        <div className="flex flex-col gap-4">
          {/* activity */}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="flex-1 rounded-2xl overflow-hidden"
            style={{
              background: 'rgba(13,20,38,0.85)',
              backdropFilter: 'blur(24px)',
              border: '1px solid rgba(148,163,184,0.07)',
            }}>
            <div className="px-4 py-3 border-b border-slate-800/80 flex items-center justify-between">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Recent Activity</span>
              <div className="flex items-center gap-1.5">
                <motion.div className="w-1.5 h-1.5 rounded-full bg-emerald-400"
                  animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }} />
                <span className="text-[10px] text-emerald-400/80">Live</span>
              </div>
            </div>
            <div className="p-3 space-y-1.5">
              {agentActivities.length > 0 ? agentActivities.map((a, i) => (
                <motion.div key={a.id || i}
                  initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.35 + i * 0.04 }}
                  className="flex items-start gap-2.5 px-3 py-2 rounded-xl"
                  style={{ background: 'rgba(255,255,255,0.02)' }}>
                  <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: a.accent }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-semibold text-slate-300">{a.action}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">{a.detail}</p>
                  </div>
                  <span className="text-[10px] text-slate-700 flex-shrink-0">{a.time}</span>
                </motion.div>
              )) : (
                // fallback if no filtered activity yet
                SEED_ACTIVITIES.slice(0, 3).map((a, i) => (
                  <motion.div key={a.id}
                    initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.35 + i * 0.04 }}
                    className="flex items-start gap-2.5 px-3 py-2 rounded-xl"
                    style={{ background: 'rgba(255,255,255,0.02)' }}>
                    <div className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: agent.accent }} />
                    <div className="flex-1 min-w-0">
                      <span className="text-[11px] font-semibold text-slate-300">{a.action}</span>
                      <p className="text-[10px] text-slate-500 truncate">{a.detail}</p>
                    </div>
                    <span className="text-[10px] text-slate-700 flex-shrink-0">{a.time}</span>
                  </motion.div>
                ))
              )}
            </div>
          </motion.div>

          {/* chat cta */}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.38 }}
            className="rounded-2xl p-4"
            style={{
              background: `linear-gradient(135deg, ${agent.accent}12, ${agent.accentDark}10)`,
              backdropFilter: 'blur(24px)',
              border: `1px solid ${agent.accent}25`,
            }}>
            <div className="flex items-center gap-2 mb-2">
              <MessageCircle size={13} style={{ color: agent.accent }} />
              <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: agent.accent }}>
                Ask Claude
              </span>
            </div>
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
              Chat with Claude about {agent.name.toLowerCase()}'s performance, tasks, or get a status report.
            </p>
            <div className="grid grid-cols-1 gap-1.5">
              {[
                `Summarize ${agent.name}'s current status`,
                `What has ${agent.name} completed today?`,
                `How is ${agent.name} performing?`,
              ].map(prompt => (
                <motion.button key={prompt}
                  whileHover={{ x: 3 }} whileTap={{ scale: 0.97 }}
                  onClick={() => onAskClaude(prompt)}
                  className="w-full text-left text-xs text-slate-400 px-3 py-2 rounded-xl flex items-center gap-2 hover:text-slate-200 transition-colors"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <ChevronRight size={9} style={{ color: agent.accent }} className="flex-shrink-0" />
                  {prompt}
                </motion.button>
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      <div className="h-6" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// METRIC CARD
// ─────────────────────────────────────────────────────────────

function MetricCard({ metric, index }: { metric: Metric; index: number }) {
  const Icon = metric.icon
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (typeof metric.value !== 'number') return
    const target = metric.value
    const steps = 55
    let n = 0
    const t = setInterval(() => {
      n += target / steps
      if (n >= target) { setCount(target); clearInterval(t) }
      else setCount(Math.floor(n))
    }, 1400 / steps)
    return () => clearInterval(t)
  }, [metric.value])

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.07, duration: 0.4 }}
      className="relative overflow-hidden rounded-2xl p-4"
      style={{
        background: 'rgba(13,20,38,0.85)',
        backdropFilter: 'blur(28px)',
        border: '1px solid rgba(148,163,184,0.07)',
      }}>
      <div className="absolute -top-6 -right-6 w-20 h-20 rounded-full opacity-[0.09]"
        style={{ background: metric.accent }} />
      <div className="relative">
        <div className="flex items-center justify-between mb-3">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background: `${metric.accent}18` }}>
            <Icon size={14} style={{ color: metric.accent }} />
          </div>
          <div className={`flex items-center gap-1 text-[10px] font-semibold ${metric.up ? 'text-emerald-400' : 'text-slate-500'}`}>
            <TrendingUp size={8} />{metric.change}
          </div>
        </div>
        <div className="text-2xl font-black text-slate-100 mb-0.5 tabular-nums">
          {typeof metric.value === 'number' ? count.toLocaleString() : metric.value}
        </div>
        <div className="text-[11px] text-slate-500">{metric.label}</div>
      </div>
    </motion.div>
  )
}

// ─────────────────────────────────────────────────────────────
// ACTIVITY FEED
// ─────────────────────────────────────────────────────────────

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(13,20,38,0.85)',
        backdropFilter: 'blur(28px)',
        border: '1px solid rgba(148,163,184,0.07)',
      }}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/70">
        <div className="flex items-center gap-2">
          <Activity size={12} className="text-indigo-400" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Activity Stream</span>
        </div>
        <div className="flex items-center gap-1.5">
          <motion.div className="w-1.5 h-1.5 rounded-full bg-emerald-400"
            animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }} />
          <span className="text-[10px] text-emerald-400/80">Live</span>
        </div>
      </div>
      <div className="p-2.5 space-y-1">
        <AnimatePresence mode="popLayout">
          {items.slice(0, 7).map((item, i) => (
            <motion.div key={item.id}
              initial={{ opacity: 0, height: 0, y: -6 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ delay: i * 0.035 }}
              className="flex items-center gap-3 px-3 py-2 rounded-xl"
              style={{ background: 'rgba(255,255,255,0.02)' }}>
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: item.accent }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-300">{item.agent}</span>
                  <span className="text-[10px] text-slate-600">{item.action}</span>
                </div>
                <p className="text-[10px] text-slate-500 truncate">{item.detail}</p>
              </div>
              <span className="text-[10px] text-slate-700 flex-shrink-0 whitespace-nowrap">{item.time}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CHAT PANEL  (real chat app redesign)
// ─────────────────────────────────────────────────────────────

function ChatPanel({ messages, onSend, loading }: {
  messages: Message[]; onSend: (m: string) => void; loading: boolean
}) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const groups = groupMessages(messages)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const send = () => {
    const v = input.trim()
    if (!v || loading) return
    onSend(v)
    setInput('')
    setTimeout(() => taRef.current?.focus(), 10)
  }

  const SUGGESTED = [
    'What are my agents working on?',
    'Show me today\'s performance summary',
    'Are there any issues I should know about?',
  ]

  return (
    <div className="flex flex-col h-full"
      style={{
        background: 'rgba(7,11,22,0.98)',
        backdropFilter: 'blur(28px)',
        borderLeft: '1px solid rgba(99,102,241,0.1)',
      }}>

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-3">
          <div className="relative">
            <ClaudeAvatar size={34} />
            <motion.div
              className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#07090e] bg-emerald-400"
              animate={{ scale: [1, 1.2, 1] }} transition={{ duration: 2, repeat: Infinity }} />
          </div>
          <div>
            <div className="text-sm font-bold text-slate-100">Claude</div>
            <div className="text-[10px] text-slate-500 leading-none mt-0.5">
              {loading ? 'Typing…' : 'Online · Sonnet 4.6'}
            </div>
          </div>
        </div>
        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
          className="w-7 h-7 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.05)' }}>
          <MoreHorizontal size={13} className="text-slate-500" />
        </motion.button>
      </div>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-4 min-h-0">

        {/* Empty state */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-5">
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="flex flex-col items-center gap-3">
              <ClaudeAvatar size={48} />
              <div className="text-center">
                <p className="text-sm font-semibold text-slate-300">Hey Mel 👋</p>
                <p className="text-xs text-slate-600 mt-1">What can I help you with?</p>
              </div>
            </motion.div>

            <div className="w-full space-y-1.5">
              {SUGGESTED.map((s, i) => (
                <motion.button key={s}
                  initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + i * 0.07 }}
                  whileHover={{ x: 3, scale: 1.01 }} whileTap={{ scale: 0.98 }}
                  onClick={() => onSend(s)}
                  className="w-full text-left text-xs text-slate-400 hover:text-slate-200 px-3 py-2.5 rounded-xl flex items-center gap-2 transition-colors"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <ChevronRight size={9} className="text-indigo-500 flex-shrink-0" />
                  {s}
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* Message groups */}
        <AnimatePresence initial={false}>
          {groups.map((group, gi) => {
            const isUser = group.role === 'user'
            return (
              <motion.div key={group.msgs[0].id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>

                {/* Avatar — shown beside last message in group */}
                <div className="flex-shrink-0 self-end mb-5">
                  {isUser ? <UserAvatar size={28} /> : <ClaudeAvatar size={28} />}
                </div>

                {/* Bubbles */}
                <div className={`flex flex-col gap-1 max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
                  {group.msgs.map((m, mi) => {
                    const isFirst = mi === 0
                    const isLast = mi === group.msgs.length - 1
                    return (
                      <motion.div key={m.id}
                        initial={{ opacity: 0, scale: 0.95, y: 4 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: mi * 0.04 }}>
                        <div
                          className="px-3.5 py-2.5 text-[13px] leading-relaxed"
                          style={{
                            borderRadius: isUser
                              ? `${isFirst ? 18 : 6}px 6px ${isLast ? 18 : 6}px ${isLast ? 18 : 6}px`
                              : `6px ${isFirst ? 18 : 6}px ${isLast ? 18 : 6}px ${isLast ? 18 : 6}px`,
                            ...(isUser ? {
                              background: 'linear-gradient(145deg, rgba(99,102,241,0.6), rgba(79,70,229,0.5))',
                              border: '1px solid rgba(99,102,241,0.35)',
                              color: '#e2e8f0',
                              boxShadow: '0 2px 12px rgba(99,102,241,0.2)',
                            } : {
                              background: 'rgba(255,255,255,0.05)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              color: '#cbd5e1',
                            }),
                          }}>
                          {m.content}
                        </div>
                      </motion.div>
                    )
                  })}

                  {/* Timestamp under last bubble */}
                  <span className={`text-[10px] text-slate-700 px-1 ${isUser ? 'text-right' : 'text-left'}`}>
                    {formatTime(group.msgs[group.msgs.length - 1].ts)}
                  </span>
                </div>
              </motion.div>
            )
          })}
        </AnimatePresence>

        {/* Typing indicator */}
        {loading && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
            className="flex gap-2.5 items-end">
            <ClaudeAvatar size={28} />
            <div className="px-4 py-3 rounded-2xl rounded-bl-sm"
              style={{
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}>
              <div className="flex gap-1.5 items-center h-3.5">
                {[0, 1, 2].map(i => (
                  <motion.div key={i}
                    className="w-1.5 h-1.5 rounded-full bg-slate-400"
                    animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.18 }} />
                ))}
              </div>
            </div>
          </motion.div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── Input ── */}
      <div className="px-3 pb-3 pt-2 flex-shrink-0"
        style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div className="flex items-end gap-2 px-3 py-2.5 rounded-2xl"
          style={{
            background: 'rgba(255,255,255,0.05)',
            border: `1px solid ${input.trim() ? 'rgba(99,102,241,0.35)' : 'rgba(255,255,255,0.08)'}`,
            transition: 'border-color 0.2s',
          }}>
          <textarea
            ref={taRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Message Claude…"
            rows={1}
            className="flex-1 bg-transparent text-[13px] text-slate-200 placeholder-slate-600 resize-none outline-none leading-relaxed min-h-[22px] max-h-[120px]"
          />
          <motion.button
            onClick={send}
            disabled={loading || !input.trim()}
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.88 }}
            animate={{
              background: input.trim() && !loading
                ? ['linear-gradient(145deg,#6366f1,#818cf8)', 'linear-gradient(145deg,#818cf8,#6366f1)']
                : 'rgba(255,255,255,0.06)',
            }}
            transition={{ duration: 2, repeat: Infinity, repeatType: 'reverse' }}
            className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 disabled:opacity-25"
          >
            {loading
              ? <Loader2 size={14} className="text-white animate-spin" />
              : <Send size={13} className={input.trim() ? 'text-white' : 'text-slate-600'} />
            }
          </motion.button>
        </div>
        <p className="text-center text-[10px] text-slate-800 mt-1.5">↵ send · ⇧↵ newline</p>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// SIDEBAR
// ─────────────────────────────────────────────────────────────

function Sidebar({ view, setView }: { view: ViewType; setView: (v: ViewType) => void }) {
  const nav = [
    { id: 'dashboard' as ViewType, icon: LayoutGrid, label: 'Dashboard' },
    { id: 'agents'    as ViewType, icon: Cpu,         label: 'Agents'    },
    { id: 'tasks'     as ViewType, icon: CheckSquare, label: 'Tasks'     },
    { id: 'terminal'  as ViewType, icon: Terminal,    label: 'Terminal'  },
    { id: 'settings'  as ViewType, icon: Settings,    label: 'Settings'  },
  ]
  return (
    <div className="w-14 flex flex-col items-center py-3 gap-1 flex-shrink-0"
      style={{
        background: 'rgba(6,10,20,0.95)',
        backdropFilter: 'blur(28px)',
        borderRight: '1px solid rgba(255,255,255,0.04)',
      }}>
      {nav.map(item => {
        const Icon = item.icon
        const active = view === item.id
        return (
          <motion.button key={item.id}
            onClick={() => setView(item.id)}
            whileHover={{ scale: 1.15 }} whileTap={{ scale: 0.88 }}
            title={item.label}
            className="relative w-9 h-9 rounded-xl flex items-center justify-center"
            style={{
              background: active ? 'rgba(99,102,241,0.2)' : 'transparent',
              border: `1px solid ${active ? 'rgba(99,102,241,0.4)' : 'transparent'}`,
              boxShadow: active ? '0 0 20px rgba(99,102,241,0.2)' : 'none',
            }}>
            <Icon size={15} style={{ color: active ? '#818cf8' : '#374151' }} />
            {active && (
              <motion.div layoutId="nav-pip"
                className="absolute -left-px top-2.5 bottom-2.5 w-0.5 rounded-full bg-indigo-400"
                transition={{ type: 'spring', stiffness: 450, damping: 38 }} />
            )}
          </motion.button>
        )
      })}

      {/* agent mini-avatars */}
      <div className="mt-auto mb-1 flex flex-col items-center gap-2">
        {AGENTS.slice(0, 4).map((a, i) => (
          <motion.div key={a.id}
            title={a.name}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}
            transition={{ delay: 0.5 + i * 0.06 }}
            className="relative cursor-pointer"
            whileHover={{ scale: 1.15 }}>
            <div
              className="w-6 h-6 rounded-lg flex items-center justify-center"
              style={{ background: `linear-gradient(145deg,${a.accent}dd,${a.accentDark})` }}>
              <a.icon size={11} className="text-white" />
            </div>
            {a.status === 'active' && (
              <div className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 border border-[#06090e]" />
            )}
          </motion.div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────────────────────────

function TopBar({ activeCount, totalTokens }: { activeCount: number; totalTokens: number }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])

  return (
    <div className="h-[52px] flex items-center justify-between px-4 flex-shrink-0"
      style={{
        background: 'rgba(6,10,20,0.98)',
        backdropFilter: 'blur(28px)',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}>
      {/* logo */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          <motion.div
            className="w-7 h-7 rounded-xl flex items-center justify-center"
            style={{ background: 'linear-gradient(145deg,#4338ca,#6366f1)', boxShadow: '0 0 18px rgba(99,102,241,0.5)' }}
            animate={{ boxShadow: ['0 0 14px rgba(99,102,241,0.4)','0 0 28px rgba(99,102,241,0.7)','0 0 14px rgba(99,102,241,0.4)'] }}
            transition={{ duration: 3.5, repeat: Infinity }}>
            <Bot size={14} className="text-white" />
          </motion.div>
          <span className="text-[13px] font-black tracking-[0.18em] text-slate-200 uppercase">
            Claude<span className="text-indigo-400">OS</span>
          </span>
        </div>

        <div className="hidden md:flex items-center gap-2 ml-2">
          {[
            { label: 'Systems Online', dot: '#10b981', bg: 'rgba(16,185,129,0.08)', bd: 'rgba(16,185,129,0.18)' },
            { label: `${activeCount} Active`, dot: '#818cf8', bg: 'rgba(99,102,241,0.08)', bd: 'rgba(99,102,241,0.18)' },
          ].map(p => (
            <div key={p.label}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
              style={{ background: p.bg, border: `1px solid ${p.bd}`, color: p.dot }}>
              <motion.div className="w-1.5 h-1.5 rounded-full" style={{ background: p.dot }}
                animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }} />
              {p.label}
            </div>
          ))}
        </div>
      </div>

      {/* center */}
      <div className="hidden lg:flex items-center gap-4 text-[11px] text-slate-600 font-mono">
        <span>{now.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' })}</span>
        <span className="w-px h-3 bg-slate-800" />
        <span className="tabular-nums">{now.toLocaleTimeString('en-US', { hour12: false })}</span>
        <span className="w-px h-3 bg-slate-800" />
        <span className="font-sans">{(totalTokens / 1000).toFixed(1)}k tokens today</span>
      </div>

      {/* right */}
      <div className="flex items-center gap-2">
        <motion.button whileHover={{ scale: 1.08 }}
          className="w-7 h-7 rounded-xl flex items-center justify-center"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Bell size={12} className="text-slate-500" />
        </motion.button>
        <UserAvatar size={28} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// SECTION HEADER
// ─────────────────────────────────────────────────────────────

function SectionHeader({ label, sub, action }: {
  label: string; sub?: string; action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-600">{label}</span>
        {sub && (<>
          <span className="w-px h-3 bg-slate-800" />
          <div className="flex items-center gap-1 text-[10px] text-slate-700">
            <RefreshCw size={8} /><span>{sub}</span>
          </div>
        </>)}
      </div>
      {action && (
        <motion.button whileHover={{ scale: 1.05, x: 1 }} onClick={action.onClick}
          className="flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-400 transition-colors font-medium">
          {action.label}
        </motion.button>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD VIEW
// ─────────────────────────────────────────────────────────────

function DashboardView({ agents, activities, metrics, onSelectAgent }: {
  agents: Agent[]; activities: ActivityItem[]; metrics: Metric[]; onSelectAgent: (a: Agent) => void
}) {
  return (
    <div className="h-full overflow-y-auto px-5 py-4 space-y-5">
      <section>
        <SectionHeader label="System Metrics" sub="Real-time" />
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {metrics.map((m, i) => <MetricCard key={m.id} metric={m} index={i} />)}
        </div>
      </section>

      <section>
        <SectionHeader label="Agent Fleet" action={{ label: '+ Deploy', onClick: () => {} }} />
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
          {agents.map((a, i) => (
            <AgentCard key={a.id} agent={a} index={i} onClick={() => onSelectAgent(a)} />
          ))}
        </div>
      </section>

      <section>
        <SectionHeader label="Activity Stream" />
        <ActivityFeed items={activities} />
      </section>
      <div className="h-6" />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// AGENTS VIEW
// ─────────────────────────────────────────────────────────────

function AgentsView({ agents, onSelect }: { agents: Agent[]; onSelect: (a: Agent) => void }) {
  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
        <h1 className="text-xl font-black text-slate-100">Agent Fleet</h1>
        <p className="text-sm text-slate-500 mt-1">
          <span className="text-emerald-400 font-semibold">{agents.filter(a => a.status === 'active').length} active</span>
          <span className="mx-2 text-slate-700">·</span>
          <span>{agents.filter(a => a.status === 'idle').length} idle</span>
          <span className="mx-2 text-slate-700">·</span>
          <span>{agents.length} total</span>
        </p>
      </motion.div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {agents.map((agent, i) => (
          <motion.div key={agent.id}
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.055 }}
            onClick={() => onSelect(agent)}
            className="rounded-2xl p-4 cursor-pointer group transition-all duration-200 hover:scale-[1.01]"
            style={{
              background: 'rgba(13,20,38,0.85)',
              backdropFilter: 'blur(28px)',
              border: `1px solid rgba(148,163,184,0.07)`,
            }}
            whileHover={{
              borderColor: agent.accent + '35',
              boxShadow: `0 0 40px ${agent.accent}10`,
            }}>
            <div className="flex items-center gap-4">
              <AgentAvatar agent={agent} size="lg" showStatus pulse={agent.status === 'processing'} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-0.5">
                  <h3 className="font-bold text-slate-100">{agent.name}</h3>
                  <StatusBadge status={agent.status} />
                </div>
                <p className="text-xs text-slate-500 mb-2">{agent.description}</p>
                <div className="flex items-center gap-3 text-[11px] text-slate-500">
                  <span><span className="text-slate-300 font-semibold">{agent.tasks}</span> tasks</span>
                  <span className="w-px h-3 bg-slate-800" />
                  <span><span className="text-slate-300 font-semibold">{(agent.tokens/1000).toFixed(1)}k</span> tokens</span>
                  <span className="w-px h-3 bg-slate-800" />
                  <span><span className="text-slate-300 font-semibold">{agent.uptime}</span> uptime</span>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                <Sparkline data={agent.sparkline} color={agent.accent} w={70} h={24} />
                <motion.div
                  className="flex items-center gap-1 text-[10px] font-bold opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ color: agent.accent }}>
                  View <ChevronRight size={9} />
                </motion.div>
              </div>
            </div>

            {agent.progress > 0 && (
              <div className="mt-3 pt-3 border-t border-slate-800/60">
                <div className="flex justify-between text-[10px] mb-1.5">
                  <span className="text-slate-600 truncate max-w-[70%]">{agent.task}</span>
                  <span style={{ color: agent.accent }}>{agent.progress}%</span>
                </div>
                <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                  <motion.div className="h-full rounded-full"
                    style={{ background: `linear-gradient(90deg,${agent.accentDark},${agent.accent})` }}
                    initial={{ width: 0 }} animate={{ width: `${agent.progress}%` }}
                    transition={{ duration: 1.2, delay: i * 0.055 }} />
                </div>
              </div>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// TERMINAL VIEW
// ─────────────────────────────────────────────────────────────

function TerminalView() {
  const [lines, setLines] = useState([
    { t: '  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗     ██████╗ ███████╗', c: 'dim' },
    { t: ' ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝    ██╔═══██╗██╔════╝', c: 'dim' },
    { t: ' ██║     ██║     ███████║██║   ██║██║  ██║█████╗      ██║   ██║███████╗', c: 'dim' },
    { t: ' ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝      ██║   ██║╚════██║', c: 'dim' },
    { t: ' ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗    ╚██████╔╝███████║', c: 'dim' },
    { t: '  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝     ╚═════╝ ╚══════╝', c: 'dim' },
    { t: '', c: 'dim' },
    { t: '  Mission Control Terminal  v1.0.0', c: 'accent' },
    { t: '  Type "help" for available commands', c: 'muted' },
    { t: '', c: 'dim' },
  ])
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [lines])

  const run = (raw: string) => {
    const cmd = raw.trim().toLowerCase()
    const out: typeof lines = [{ t: `  $ ${raw}`, c: 'cmd' }]
    if (cmd === 'help') {
      out.push(
        { t: '', c: 'dim' }, { t: '  Available commands:', c: 'accent' },
        { t: '  ─────────────────────────────────────', c: 'dim' },
        { t: '  status   — System health overview',     c: 'muted' },
        { t: '  agents   — List all agents',            c: 'muted' },
        { t: '  metrics  — Token & task statistics',    c: 'muted' },
        { t: '  deploy   — Deploy a new agent (demo)',  c: 'muted' },
        { t: '  clear    — Clear terminal',             c: 'muted' },
        { t: '  version  — Build information',          c: 'muted' },
        { t: '', c: 'dim' },
      )
    } else if (cmd === 'status') {
      out.push(
        { t: '', c: 'dim' }, { t: '  System Status', c: 'accent' },
        { t: '  ─────────────────────────────────────', c: 'dim' },
        { t: '  ✓ Core Systems ............... ONLINE',       c: 'ok' },
        { t: '  ✓ Claude API ................. CONNECTED',    c: 'ok' },
        { t: '  ✓ Agent Fleet (4/6) .......... ACTIVE',      c: 'ok' },
        { t: '  ✓ Database ................... OPERATIONAL', c: 'ok' },
        { t: '  ✓ Security Monitor ........... ACTIVE',      c: 'ok' },
        { t: '  ─────────────────────────────────────', c: 'dim' },
        { t: '  All systems nominal.', c: 'muted' }, { t: '', c: 'dim' },
      )
    } else if (cmd === 'agents') {
      out.push({ t: '', c: 'dim' }, { t: '  ID            STATUS       TASKS    UPTIME', c: 'accent' },
        { t: '  ─────────────────────────────────────', c: 'dim' },
        ...AGENTS.map(a => ({
          t: `  ${a.name.padEnd(16)}${a.status.toUpperCase().padEnd(13)}${String(a.tasks).padEnd(9)}${a.uptime}`,
          c: a.status === 'active' ? 'ok' : a.status === 'processing' ? 'primary' : 'muted',
        })),
        { t: '', c: 'dim' },
      )
    } else if (cmd === 'metrics') {
      const total = AGENTS.reduce((s, a) => s + a.tokens, 0)
      const tasks = AGENTS.reduce((s, a) => s + a.tasks, 0)
      out.push(
        { t: '', c: 'dim' }, { t: '  Performance Metrics', c: 'accent' },
        { t: '  ─────────────────────────────────────', c: 'dim' },
        { t: `  Total Tokens ........... ${total.toLocaleString()}`, c: 'muted' },
        { t: `  Total Tasks ............ ${tasks}`,                  c: 'muted' },
        { t: `  Active Agents .......... ${AGENTS.filter(a => a.status === 'active').length} / ${AGENTS.length}`, c: 'muted' },
        { t: '  Avg Response Time ...... 1.2s',                      c: 'muted' },
        { t: '', c: 'dim' },
      )
    } else if (cmd === 'deploy') {
      out.push(
        { t: '', c: 'dim' }, { t: '  Deploying new agent…', c: 'primary' },
        { t: '  ◉ Allocating compute resources',    c: 'ok' },
        { t: '  ◉ Loading model weights',           c: 'ok' },
        { t: '  ◉ Initializing context window',     c: 'ok' },
        { t: '  ◉ Registering with fleet',          c: 'ok' },
        { t: '', c: 'dim' }, { t: '  ✓ Agent "Custom-7" is online.', c: 'ok' },
        { t: '', c: 'dim' },
      )
    } else if (cmd === 'clear') {
      setLines([]); setInput(''); return
    } else if (cmd === 'version') {
      out.push(
        { t: '', c: 'dim' }, { t: '  Claude OS  v1.0.0', c: 'primary' },
        { t: '  Next.js 14 · Tailwind CSS · Framer Motion', c: 'muted' },
        { t: '  Anthropic Claude SDK', c: 'muted' }, { t: '', c: 'dim' },
      )
    } else if (cmd === '') {
      out.push({ t: '', c: 'dim' })
    } else {
      out.push({ t: `  Error: unknown command "${raw}"`, c: 'err' }, { t: '', c: 'dim' })
    }
    setLines(prev => [...prev, ...out]); setInput('')
  }

  const CM: Record<string, string> = {
    dim: '#1e293b', muted: '#64748b', primary: '#818cf8',
    accent: '#06b6d4', ok: '#34d399', err: '#f87171', cmd: '#e2e8f0',
  }

  return (
    <div className="h-full flex flex-col p-4">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-3">
        <h1 className="text-xl font-black text-slate-100">Terminal</h1>
        <p className="text-sm text-slate-500 mt-0.5">Direct system interface</p>
      </motion.div>
      <div className="flex-1 rounded-2xl overflow-hidden flex flex-col font-mono text-sm min-h-0"
        style={{ background: 'rgba(3,7,18,0.97)', border: '1px solid rgba(99,102,241,0.12)' }}>
        <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-slate-900">
          {['#f43f5e','#f59e0b','#10b981'].map(c => (
            <div key={c} className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />
          ))}
          <span className="ml-2 text-[11px] text-slate-700">claude-os — bash</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-px">
          {lines.map((l, i) => (
            <div key={i} className="leading-6 whitespace-pre" style={{ color: CM[l.c] || CM.muted }}>
              {l.t || ' '}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-900">
          <span className="text-indigo-400">$</span>
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && run(input)}
            className="flex-1 bg-transparent text-slate-200 outline-none placeholder-slate-800 caret-indigo-400"
            placeholder="Enter command…" autoFocus spellCheck={false} />
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// TASKS VIEW
// ─────────────────────────────────────────────────────────────

function TasksView({ onSelectAgent }: { onSelectAgent: (a: Agent) => void }) {
  const tasks = [
    { id: 1, title: 'Finalize Q2 market research report',    agentId: 'research', priority: 'high',   done: false },
    { id: 2, title: 'Code review: authentication refactor',  agentId: 'code',     priority: 'high',   done: false },
    { id: 3, title: 'Generate weekly analytics dashboard',   agentId: 'data',     priority: 'medium', done: true  },
    { id: 4, title: 'Draft blog post: AI trends 2026',       agentId: 'writer',   priority: 'medium', done: false },
    { id: 5, title: 'Outreach campaign: Series B investors', agentId: 'email',    priority: 'high',   done: false },
    { id: 6, title: 'Security audit: new API endpoints',     agentId: 'security', priority: 'low',    done: true  },
    { id: 7, title: 'Summarize competitor product updates',  agentId: 'research', priority: 'low',    done: false },
    { id: 8, title: 'Optimise database query performance',   agentId: 'code',     priority: 'medium', done: false },
  ]
  const pColor: Record<string, string> = { high: '#f43f5e', medium: '#f59e0b', low: '#475569' }

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-5">
        <h1 className="text-xl font-black text-slate-100">Task Queue</h1>
        <p className="text-sm text-slate-500 mt-1">
          {tasks.filter(t => !t.done).length} pending · {tasks.filter(t => t.done).length} completed
        </p>
      </motion.div>
      <div className="space-y-2">
        {tasks.map((task, i) => {
          const agent = AGENTS.find(a => a.id === task.agentId)!
          return (
            <motion.div key={task.id}
              initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className="flex items-center gap-4 px-4 py-3 rounded-2xl group cursor-pointer transition-all"
              style={{
                background: 'rgba(13,20,38,0.85)',
                backdropFilter: 'blur(24px)',
                border: '1px solid rgba(148,163,184,0.06)',
                opacity: task.done ? 0.45 : 1,
              }}
              whileHover={{ borderColor: agent.accent + '30', x: 2 }}
              onClick={() => !task.done && onSelectAgent(agent)}
            >
              <div className="w-4 h-4 rounded-lg flex items-center justify-center flex-shrink-0"
                style={{
                  background: task.done ? 'rgba(16,185,129,0.12)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${task.done ? '#10b98135' : 'rgba(255,255,255,0.1)'}`,
                }}>
                {task.done && <span className="text-[9px] text-emerald-400">✓</span>}
              </div>

              <AgentAvatar agent={agent} size="xs" />

              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-200"
                  style={{ textDecoration: task.done ? 'line-through' : 'none' }}>
                  {task.title}
                </div>
                <div className="text-[10px] text-slate-600 mt-0.5">{agent.name}</div>
              </div>

              <div className="flex items-center gap-2">
                <div className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase"
                  style={{ background: `${pColor[task.priority]}12`, color: pColor[task.priority] }}>
                  {task.priority}
                </div>
              </div>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────

function SettingsView() {
  const [apiKey, setApiKey] = useState('')
  const [model, setModel]   = useState('claude-sonnet-4-6')
  const [saved, setSaved]   = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setApiKey(localStorage.getItem('claude_api_key') || '')
      setModel(localStorage.getItem('claude_model') || 'claude-sonnet-4-6')
    }
  }, [])

  const save = () => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('claude_api_key', apiKey)
      localStorage.setItem('claude_model', model)
    }
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div className="h-full overflow-y-auto px-5 py-5">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
        <h1 className="text-xl font-black text-slate-100">Settings</h1>
        <p className="text-sm text-slate-500 mt-1">Configure your Claude OS instance</p>
      </motion.div>
      <div className="max-w-lg space-y-4">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="rounded-2xl p-5"
          style={{ background: 'rgba(13,20,38,0.85)', backdropFilter: 'blur(28px)', border: '1px solid rgba(148,163,184,0.07)' }}>
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-600 mb-4">API Configuration</div>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-400 mb-1.5 block">Anthropic API Key</label>
              <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                placeholder="sk-ant-api03-…"
                className="w-full px-3 py-2.5 rounded-xl text-sm text-slate-200 placeholder-slate-700 outline-none font-mono"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(99,102,241,0.18)' }} />
              <p className="text-[11px] text-slate-600 mt-1.5">
                Get your key at{' '}
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 transition-colors">
                  console.anthropic.com
                </a>
              </p>
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-400 mb-1.5 block">Model</label>
              <select value={model} onChange={e => setModel(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl text-sm outline-none"
                style={{ background: 'rgba(13,20,38,0.95)', border: '1px solid rgba(99,102,241,0.18)', color: '#cbd5e1' }}>
                <option value="claude-opus-4-6" style={{ background: '#0f172a' }}>Claude Opus 4.6 — Most capable</option>
                <option value="claude-sonnet-4-6" style={{ background: '#0f172a' }}>Claude Sonnet 4.6 — Balanced (recommended)</option>
                <option value="claude-haiku-4-5-20251001" style={{ background: '#0f172a' }}>Claude Haiku 4.5 — Fastest</option>
              </select>
            </div>
          </div>
          <motion.button onClick={save} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            className="mt-5 px-5 py-2.5 rounded-xl text-sm font-bold text-white"
            style={{ background: saved ? 'linear-gradient(135deg,#10b981,#059669)' : 'linear-gradient(135deg,#4338ca,#6366f1)' }}>
            {saved ? '✓ Saved!' : 'Save Configuration'}
          </motion.button>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          className="rounded-2xl p-5"
          style={{ background: 'rgba(13,20,38,0.85)', backdropFilter: 'blur(28px)', border: '1px solid rgba(148,163,184,0.07)' }}>
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-600 mb-4">About</div>
          <div className="space-y-2.5 text-sm">
            {[['Version','1.0.0'],['Framework','Next.js 14'],['Styling','Tailwind CSS'],['Animation','Framer Motion'],['AI Provider','Anthropic Claude']].map(([k,v]) => (
              <div key={k} className="flex justify-between">
                <span className="text-slate-500">{k}</span>
                <span className="text-slate-300 font-mono text-xs">{v}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ROOT PAGE
// ─────────────────────────────────────────────────────────────

export default function Page() {
  const [view,           setView]           = useState<ViewType>('dashboard')
  const [selectedAgent,  setSelectedAgent]  = useState<Agent | null>(null)
  const [messages,       setMessages]       = useState<Message[]>([])
  const [loading,        setLoading]        = useState(false)
  const [activities,     setActivities]     = useState<ActivityItem[]>(SEED_ACTIVITIES)

  // Live activity feed
  useEffect(() => {
    const id = setInterval(() => {
      const src = LIVE_POOL[Math.floor(Math.random() * LIVE_POOL.length)]
      setActivities(prev => [
        { ...src, id: Math.random().toString(36).slice(2) },
        ...prev,
      ].slice(0, 10))
    }, 4800)
    return () => clearInterval(id)
  }, [])

  const metrics: Metric[] = [
    { id: 'agents', label: 'Active Agents',  value: AGENTS.filter(a => a.status === 'active').length,   change: '+1 today', icon: Cpu,         accent: '#6366f1', up: true  },
    { id: 'tokens', label: 'Tokens Used',     value: AGENTS.reduce((s, a) => s + a.tokens, 0),           change: '+12k/hr',  icon: Zap,         accent: '#06b6d4', up: true  },
    { id: 'tasks',  label: 'Tasks Complete',  value: AGENTS.reduce((s, a) => s + a.tasks, 0),            change: '+47 today',icon: CheckSquare, accent: '#10b981', up: true  },
    { id: 'uptime', label: 'System Uptime',   value: '99.9%',                                           change: '↑ stable', icon: Activity,    accent: '#a855f7', up: false },
  ]

  const handleSend = useCallback(async (content: string) => {
    const userMsg: Message = { id: Date.now().toString(), role: 'user', content, ts: new Date() }
    setMessages(prev => [...prev, userMsg])
    setLoading(true)

    try {
      const apiKey = typeof window !== 'undefined' ? localStorage.getItem('claude_api_key') : null
      const model  = typeof window !== 'undefined' ? localStorage.getItem('claude_model')   : null

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [...messages, userMsg].map(m => ({ role: m.role, content: m.content })),
          apiKey: apiKey ?? undefined,
          model:  model  ?? undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'API error')

      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.content,
        ts: new Date(),
      }])
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: `⚠️ ${err.message || 'Unable to reach Claude. Add your API key in Settings.'}`,
        ts: new Date(),
      }])
    } finally {
      setLoading(false)
    }
  }, [messages])

  const handleSelectAgent = (a: Agent) => {
    setSelectedAgent(a)
    setView('agents')
  }

  // When user clicks "Ask Claude" from the agent detail view,
  // send the message and clear the selected agent so chat is visible
  const handleAskClaude = (msg: string) => {
    setSelectedAgent(null)
    handleSend(msg)
  }

  const mainContent = () => {
    if (selectedAgent) {
      return (
        <AgentDetailView
          agent={selectedAgent}
          activities={activities}
          onBack={() => setSelectedAgent(null)}
          onAskClaude={handleAskClaude}
        />
      )
    }
    switch (view) {
      case 'dashboard': return <DashboardView agents={AGENTS} activities={activities} metrics={metrics} onSelectAgent={handleSelectAgent} />
      case 'agents':    return <AgentsView agents={AGENTS} onSelect={handleSelectAgent} />
      case 'tasks':     return <TasksView onSelectAgent={handleSelectAgent} />
      case 'terminal':  return <TerminalView />
      case 'settings':  return <SettingsView />
    }
  }

  return (
    <div className="h-screen overflow-hidden bg-[#030712] font-sans text-slate-100 select-none">
      <ParticleBackground />

      <div className="relative z-10 h-full flex flex-col">
        <TopBar
          activeCount={AGENTS.filter(a => a.status === 'active').length}
          totalTokens={AGENTS.reduce((s, a) => s + a.tokens, 0)}
        />

        <div className="flex flex-1 overflow-hidden">
          <Sidebar view={view} setView={v => { setView(v); setSelectedAgent(null) }} />

          <main className="flex-1 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={selectedAgent ? `agent-${selectedAgent.id}` : view}
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                className="h-full">
                {mainContent()}
              </motion.div>
            </AnimatePresence>
          </main>

          {/* chat */}
          <div className="w-72 xl:w-80 2xl:w-96 flex-shrink-0">
            <ChatPanel messages={messages} onSend={handleSend} loading={loading} />
          </div>
        </div>
      </div>
    </div>
  )
}
