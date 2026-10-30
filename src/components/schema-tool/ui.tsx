'use client'
/** Schema Tool — small shared UI primitives that match the AgenticOS dark theme. */
import React from 'react'

export const T = {
  bg: '#080c14',
  panel: 'rgba(15,20,35,0.97)',
  card: 'rgba(17,24,39,0.72)',
  border: 'rgba(99,102,241,0.12)',
  borderStrong: 'rgba(99,102,241,0.25)',
  text: '#e2e8f0',
  sub: 'rgba(148,163,184,0.75)',
  faint: 'rgba(148,163,184,0.45)',
  accent: '#a5b4fc',
  accentBg: 'rgba(99,102,241,0.18)',
  green: '#34d399', greenBg: 'rgba(16,185,129,0.12)', greenBorder: 'rgba(16,185,129,0.28)',
  red: '#f87171', redBg: 'rgba(239,68,68,0.1)', redBorder: 'rgba(239,68,68,0.28)',
  amber: '#fbbf24', amberBg: 'rgba(245,158,11,0.1)', amberBorder: 'rgba(245,158,11,0.28)',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}

export function Btn({ children, onClick, kind = 'ghost', disabled, title, small, style }: {
  children: React.ReactNode; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger' | 'success' | 'subtle'
  disabled?: boolean; title?: string; small?: boolean; style?: React.CSSProperties
}) {
  const palette: Record<string, React.CSSProperties> = {
    primary: { background: 'linear-gradient(135deg, rgba(99,102,241,0.9), rgba(139,92,246,0.9))', color: 'white', border: '1px solid rgba(139,92,246,0.6)', boxShadow: '0 4px 14px rgba(99,102,241,0.25)' },
    success: { background: T.greenBg, color: T.green, border: `1px solid ${T.greenBorder}` },
    danger: { background: T.redBg, color: T.red, border: `1px solid ${T.redBorder}` },
    ghost: { background: 'rgba(99,102,241,0.08)', color: T.accent, border: `1px solid ${T.border}` },
    subtle: { background: 'transparent', color: T.sub, border: '1px solid transparent' },
  }
  return (
    <button onClick={disabled ? undefined : onClick} title={title} disabled={disabled}
      style={{
        ...palette[kind], padding: small ? '4px 10px' : '7px 14px', borderRadius: 8, fontSize: small ? 11 : 12, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, display: 'inline-flex', alignItems: 'center', gap: 6,
        whiteSpace: 'nowrap', transition: 'all .12s', fontFamily: 'inherit', ...style,
      }}>
      {children}
    </button>
  )
}

export function Pill({ children, tone = 'neutral', title }: { children: React.ReactNode; tone?: 'neutral' | 'green' | 'red' | 'amber' | 'accent'; title?: string }) {
  const c = {
    neutral: { bg: 'rgba(148,163,184,0.1)', fg: T.sub, bd: 'rgba(148,163,184,0.18)' },
    green: { bg: T.greenBg, fg: T.green, bd: T.greenBorder },
    red: { bg: T.redBg, fg: T.red, bd: T.redBorder },
    amber: { bg: T.amberBg, fg: T.amber, bd: T.amberBorder },
    accent: { bg: T.accentBg, fg: T.accent, bd: T.borderStrong },
  }[tone]
  return <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: c.bg, color: c.fg, border: `1px solid ${c.bd}`, whiteSpace: 'nowrap' }}>{children}</span>
}

export function statusTone(s: string): 'neutral' | 'green' | 'red' | 'amber' | 'accent' {
  if (s === 'applied' || s === 'active') return 'green'
  if (s === 'failed' || s === 'conflict') return 'red'
  if (s === 'partial' || s === 'revert_partial' || s === 'applying' || s === 'reverting') return 'amber'
  if (s === 'proposed') return 'accent'
  return 'neutral'
}

export const STATUS_LABEL: Record<string, string> = {
  proposed: 'Ready to apply', applying: 'Applying…', applied: 'Applied', partial: 'Partly applied', failed: 'Failed',
  discarded: 'Discarded', reverting: 'Undoing…', reverted: 'Undone', revert_partial: 'Partly undone',
  pending: 'Pending', skipped: 'Skipped', conflict: 'Conflict',
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span style={{ width: size, height: size, border: '2px solid rgba(165,180,252,0.25)', borderTopColor: T.accent, borderRadius: '50%', display: 'inline-block', animation: 'stspin .7s linear infinite' }} />
}

export function GlobalStyle() {
  return <style>{`
    @keyframes stspin { to { transform: rotate(360deg) } }
    @keyframes stfade { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
    .st-scroll::-webkit-scrollbar { width: 8px; height: 8px }
    .st-scroll::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.18); border-radius: 8px }
    .st-row:hover { background: rgba(99,102,241,0.07) !important }
    .st-input:focus { outline: none; border-color: rgba(139,92,246,0.55) !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.15) }
  `}</style>
}

export const inputStyle: React.CSSProperties = {
  background: 'rgba(8,12,20,0.8)', border: `1px solid ${T.border}`, borderRadius: 8, color: T.text,
  padding: '8px 11px', fontSize: 12.5, fontFamily: 'inherit', width: '100%',
}

/** Word-level diff of two short strings → React nodes for "before" and "after". */
export function WordDiff({ a, b }: { a: string; b: string }) {
  const A = tokenize(a), B = tokenize(b)
  if (A.length * B.length > 250000) {
    return <div><Del>{a}</Del><Add>{b}</Add></div>
  }
  const n = A.length, m = B.length
  const dp: number[][] = []
  for (let i = 0; i <= n; i++) { dp.push(new Array(m + 1).fill(0)) }
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: React.ReactNode[] = []
  let i = 0, j = 0, k = 0
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { out.push(<span key={k++}>{A[i]}</span>); i++; j++ }
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { out.push(<Add key={k++}>{B[j]}</Add>); j++ }
    else { out.push(<Del key={k++}>{A[i]}</Del>); i++ }
  }
  return <span>{out}</span>
}
function tokenize(s: string) { return s.match(/\s+|[A-Za-z0-9$,.%&'’+-]+|[^\sA-Za-z0-9]/g) || [] }
export function Del({ children }: { children: React.ReactNode }) {
  return <span style={{ background: 'rgba(239,68,68,0.18)', color: '#fca5a5', textDecoration: 'line-through', textDecorationColor: 'rgba(252,165,165,0.6)', borderRadius: 3, padding: '0 1px' }}>{children}</span>
}
export function Add({ children }: { children: React.ReactNode }) {
  return <span style={{ background: 'rgba(16,185,129,0.2)', color: '#6ee7b7', borderRadius: 3, padding: '0 1px' }}>{children}</span>
}

/** Minimal markdown: **bold**, `code`, bullets, line breaks. */
export function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {lines.map((ln, i) => {
        const bullet = /^\s*[-*•]\s+/.test(ln)
        const num = ln.match(/^\s*(\d+)[.)]\s+/)
        const body = ln.replace(/^\s*[-*•]\s+/, '').replace(/^\s*\d+[.)]\s+/, '')
        if (!ln.trim()) return <div key={i} style={{ height: 4 }} />
        const content = inline(body.replace(/^#+\s*/, ''))
        if (/^#+\s/.test(ln)) return <div key={i} style={{ fontWeight: 700, color: 'white', marginTop: 4 }}>{content}</div>
        if (bullet || num) return (
          <div key={i} style={{ display: 'flex', gap: 8, paddingLeft: 2 }}>
            <span style={{ color: T.accent, flexShrink: 0, minWidth: 10 }}>{num ? `${num[1]}.` : '•'}</span><span>{content}</span>
          </div>
        )
        return <div key={i}>{content}</div>
      })}
    </div>
  )
}
function inline(s: string): React.ReactNode[] {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i} style={{ color: 'white', fontWeight: 650 }}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} style={{ fontFamily: T.mono, fontSize: '0.92em', background: 'rgba(99,102,241,0.12)', padding: '1px 5px', borderRadius: 4, color: '#c7d2fe' }}>{p.slice(1, -1)}</code>
    return <React.Fragment key={i}>{p}</React.Fragment>
  })
}

export function timeAgo(iso: string): string {
  const t = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime()
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export async function api<T = any>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data as T
}

export function shortName(name: string) { return (name || '').replace(/^https?:\/\/[^/]+/, '') || '/' }
