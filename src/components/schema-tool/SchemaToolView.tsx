'use client'
/**
 * Schema Tool — MCD submenu for reading and changing the site's JSON-LD schema (HFCM snippets).
 * Tabs: Assistant (chat → staged changesets, one-click apply/undo), Snippets (search, view, edit),
 * History (every change, undo), Page check.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Sparkles, Search, History as HistoryIcon, Globe, FileCode2, Settings2, Plus, Send, ExternalLink, Check, X, RefreshCw, MessageSquare, Zap,
} from 'lucide-react'
import { SourcesPanel } from './SourcesPanel'
import { Btn, GlobalStyle, MiniMarkdown, Pill, Spinner, STATUS_LABEL, T, api, inputStyle, shortName, statusTone, timeAgo } from './ui'
import { ChangesetCard, CsSummary, ReviewDrawer } from './ChangesetCard'

type Tab = 'assistant' | 'snippets' | 'sources' | 'history' | 'page'

interface Status {
  site: { url: string; label: string; prodOrigin: string; configured: boolean }
  ai: { provider: 'anthropic' | 'openai' | 'none'; model: string }
  settings: { auto_apply_max: number; rules: string }
  defaultRules: string
  ping: { ok: boolean; count?: number; error?: string } | null
}

export default function SchemaToolView() {
  const [tab, setTab] = useState<Tab>('assistant')
  const [status, setStatus] = useState<Status | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [review, setReview] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [openSnippet, setOpenSnippet] = useState<number | null>(null)
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(null)
  const askAssistant = (text: string) => { setDraft({ text, n: Date.now() }); setTab('assistant') }

  const loadStatus = useCallback(async (ping = false) => {
    try { setStatus(await api<Status>(`/api/schema-tool/status${ping ? '?ping=1' : ''}`)); setStatusErr(null) }
    catch (e: any) { setStatusErr(e.message) }
  }, [])
  useEffect(() => { loadStatus(true) }, [loadStatus])

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'assistant', label: 'Assistant', icon: <Sparkles size={13} /> },
    { id: 'snippets', label: 'Snippets', icon: <FileCode2 size={13} /> },
    { id: 'sources', label: 'Sources', icon: <ExternalLink size={13} /> },
    { id: 'history', label: 'History', icon: <HistoryIcon size={13} /> },
    { id: 'page', label: 'Page check', icon: <Globe size={13} /> },
  ]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: T.bg, color: T.text, fontFamily: 'Inter, sans-serif', minHeight: 0 }}>
      <GlobalStyle />
      {/* Sub-header */}
      <div style={{ padding: '12px 22px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 12, background: T.panel, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 6 }}>
          <span style={{ fontSize: 16 }}>🧩</span>
          <span style={{ color: 'white', fontWeight: 700, fontSize: 15 }}>Schema</span>
        </div>
        <div style={{ display: 'flex', background: 'rgba(99,102,241,0.08)', border: `1px solid ${T.border}`, borderRadius: 9, padding: 2 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: 600, fontFamily: 'inherit', background: tab === t.id ? 'rgba(99,102,241,0.25)' : 'transparent', color: tab === t.id ? T.accent : 'rgba(148,163,184,0.6)' }}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        {status && <>
          <Pill tone={!status.site.configured ? 'red' : status.ping?.ok === false ? 'red' : 'green'} title={status.ping?.error || status.site.url}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
            {status.site.label}{status.ping?.ok ? ` · ${status.ping.count} snippets` : !status.site.configured ? ' · not configured' : status.ping?.ok === false ? ' · unreachable' : ''}
          </Pill>
          <Pill tone={status.ai.provider === 'none' ? 'red' : 'accent'}>{status.ai.provider === 'anthropic' ? 'Claude' : status.ai.provider === 'openai' ? 'OpenAI' : 'No AI key'}{status.ai.model ? ` · ${status.ai.model}` : ''}</Pill>
          <span title="Changes touching this many snippets or fewer are applied automatically (still undoable)">
            <Pill tone={status.settings.auto_apply_max > 0 ? 'amber' : 'neutral'}><Zap size={10} /> Auto-apply {status.settings.auto_apply_max > 0 ? `≤ ${status.settings.auto_apply_max}` : 'off'}</Pill>
          </span>
        </>}
        <Btn small onClick={() => setShowSettings(true)}><Settings2 size={12} /> Settings</Btn>
      </div>

      {statusErr && <Banner tone="red">{statusErr}</Banner>}
      {status && !status.site.configured && (
        <Banner tone="amber">Add <code>SCHEMA_TOOL_WP_USER</code> and <code>SCHEMA_TOOL_WP_APP_PASSWORD</code> to <code>.env.local</code> on the server, then restart.</Banner>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'assistant' && <AssistantPanel onReview={setReview} aiReady={status?.ai.provider !== 'none'} draft={draft} />}
        {tab === 'sources' && <SourcesPanel onAsk={askAssistant} />}
        {tab === 'snippets' && <SnippetsPanel openId={openSnippet} setOpenId={setOpenSnippet} onReview={setReview} prodOrigin={status?.site.prodOrigin || ''} siteUrl={status?.site.url || ''} />}
        {tab === 'history' && <HistoryPanel onReview={setReview} />}
        {tab === 'page' && <PageCheckPanel siteUrl={status?.site.url || ''} onOpenSnippet={id => { setOpenSnippet(id); setTab('snippets') }} />}
      </div>

      {review != null && <ReviewDrawer id={review} onClose={() => setReview(null)} />}
      {showSettings && status && <SettingsModal status={status} onClose={() => setShowSettings(false)} onSaved={() => loadStatus(false)} />}
    </div>
  )
}

function Banner({ tone, children }: { tone: 'red' | 'amber'; children: React.ReactNode }) {
  return <div style={{ margin: '10px 22px 0', padding: '8px 12px', borderRadius: 8, fontSize: 12, background: tone === 'red' ? T.redBg : T.amberBg, border: `1px solid ${tone === 'red' ? T.redBorder : T.amberBorder}`, color: tone === 'red' ? T.red : T.amber }}>{children}</div>
}

// ── Assistant ──────────────────────────────────────────────────────────────
interface Msg { role: 'user' | 'assistant'; content: string; changesets?: CsSummary[]; pending?: boolean; error?: boolean; steps?: string[] }

const SUGGESTIONS = [
  'Which snippets still mention a $15,000 minimum?',
  'Change guest bathroom timelines from 3-5 weeks to 3-4 weeks',
  'Check https://phxhomeremodeling.com/author-ben-chesley/ — does the FAQ schema match the page?',
  'Sync the Organization sameAs with our SEO sameAs sheet',
]

function AssistantPanel({ onReview, aiReady, draft }: { onReview: (id: number) => void; aiReady: boolean; draft?: { text: string; n: number } | null }) {
  const [convs, setConvs] = useState<{ conversation_id: string; title: string; updated_at: string }[]>([])
  const [cid, setCid] = useState<string | null>(null)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const loadConvs = useCallback(async () => {
    try { setConvs((await api<{ conversations: any[] }>('/api/schema-tool/chat')).conversations) } catch {}
  }, [])
  useEffect(() => { loadConvs() }, [loadConvs])
  useEffect(() => { if (draft) { setInput(draft.text); setTimeout(() => inputRef.current?.focus(), 50) } }, [draft])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  const pollRef = useRef<any>(null)
  const cidRef = useRef<string | null>(null)
  useEffect(() => () => clearTimeout(pollRef.current), [])

  /** Load a conversation; if the assistant is still working on it, keep polling until it's done. */
  const loadConv = useCallback(async (id: string) => {
    const d = await api<{ messages: any[]; changesets: CsSummary[]; job: { status: string; steps: string[]; error?: string } | null }>(`/api/schema-tool/chat?conversation_id=${encodeURIComponent(id)}`)
    if (cidRef.current !== id) return
    const byId: Record<number, CsSummary> = {}
    d.changesets.forEach(c => { byId[c.id] = c })
    const list: Msg[] = d.messages.map(m => ({ role: m.role, content: m.content, steps: m.steps, changesets: (m.changeset_ids || []).map((i: number) => byId[i]).filter(Boolean) }))
    const working = d.job?.status === 'running'
    if (working) list.push({ role: 'assistant', content: '', pending: true, steps: d.job?.steps || [] })
    setMsgs(list)
    setSending(working)
    clearTimeout(pollRef.current)
    if (working) pollRef.current = setTimeout(() => { loadConv(id).catch(() => {}) }, 1500)
    else { loadConvs(); setTimeout(() => inputRef.current?.focus(), 30) }
  }, [loadConvs])

  const openConv = async (id: string) => {
    setCid(id); cidRef.current = id
    try { localStorage.setItem('schemaTool.cid', id) } catch {}
    await loadConv(id)
  }

  // reopen the last conversation when coming back to this tab
  useEffect(() => {
    let saved: string | null = null
    try { saved = localStorage.getItem('schemaTool.cid') } catch {}
    if (saved) openConv(saved).catch(() => { try { localStorage.removeItem('schemaTool.cid') } catch {} })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const newConv = () => {
    clearTimeout(pollRef.current)
    setCid(null); cidRef.current = null; setMsgs([]); setSending(false)
    try { localStorage.removeItem('schemaTool.cid') } catch {}
    setTimeout(() => inputRef.current?.focus(), 30)
  }

  const send = async (text?: string) => {
    const message = (text ?? input).trim()
    if (!message || sending) return
    setInput('')
    setSending(true)
    setMsgs(m => [...m, { role: 'user', content: message }, { role: 'assistant', content: '', pending: true, steps: [] }])
    try {
      const d = await api<{ conversation_id: string; job_id: number }>('/api/schema-tool/chat', { conversation_id: cid, message })
      setCid(d.conversation_id); cidRef.current = d.conversation_id
      try { localStorage.setItem('schemaTool.cid', d.conversation_id) } catch {}
      if (!cid) loadConvs()
      pollRef.current = setTimeout(() => { loadConv(d.conversation_id).catch(() => {}) }, 1200)
    } catch (e: any) {
      setMsgs(m => [...m.slice(0, -1), { role: 'assistant', content: e.message, error: true }])
      setSending(false)
    }
  }

  const updateCs = useCallback((c: CsSummary) => {
    setMsgs(m => m.map(x => x.changesets && x.changesets.some(y => y.id === c.id && y.status !== c.status)
      ? { ...x, changesets: x.changesets.map(y => y.id === c.id ? c : y) } : x))
  }, [])

  // Ctrl/⌘+Enter applies the newest staged changeset (fast path for bulk work)
  const lastProposed = useMemo(() => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const cs = (msgs[i].changesets || []).filter(c => c.status === 'proposed')
      if (cs.length) return cs[cs.length - 1]
    }
    return null
  }, [msgs])
  const applyLatest = async () => {
    if (!lastProposed) return
    await api(`/api/schema-tool/changesets/${lastProposed.id}`, { action: 'apply' })
    setMsgs(m => m.map(x => ({ ...x, changesets: x.changesets?.map(c => c.id === lastProposed.id ? { ...c, status: 'applying' } : c) })))
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      {/* conversation list */}
      <div className="st-scroll" style={{ width: 220, flexShrink: 0, borderRight: `1px solid ${T.border}`, overflowY: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Btn onClick={newConv} style={{ justifyContent: 'center', marginBottom: 6 }}><Plus size={13} /> New chat</Btn>
        {convs.length === 0 && <div style={{ color: T.faint, fontSize: 11.5, padding: 8, lineHeight: 1.5 }}>Your schema conversations will show up here.</div>}
        {convs.map(c => (
          <div key={c.conversation_id} className="st-row" onClick={() => openConv(c.conversation_id)}
            style={{ padding: '7px 9px', borderRadius: 8, cursor: 'pointer', background: cid === c.conversation_id ? 'rgba(99,102,241,0.14)' : 'transparent' }}>
            <div style={{ fontSize: 12, color: cid === c.conversation_id ? 'white' : T.sub, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
              <MessageSquare size={11} style={{ flexShrink: 0, opacity: 0.6 }} />{c.title || 'Conversation'}
            </div>
            <div style={{ fontSize: 10, color: T.faint, marginTop: 2, paddingLeft: 17 }}>{timeAgo(c.updated_at)}</div>
          </div>
        ))}
      </div>

      {/* chat */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div className="st-scroll" style={{ flex: 1, overflowY: 'auto', padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {msgs.length === 0 && (
            <div style={{ margin: 'auto', maxWidth: 560, textAlign: 'center', paddingBottom: 40 }}>
              <div style={{ width: 48, height: 48, margin: '0 auto 14px', borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, rgba(99,102,241,0.35), rgba(139,92,246,0.35))', boxShadow: '0 0 30px rgba(99,102,241,0.25)' }}><Sparkles size={22} color="#c7d2fe" /></div>
              <div style={{ color: 'white', fontWeight: 700, fontSize: 17 }}>Schema assistant</div>
              <div style={{ color: T.sub, fontSize: 12.5, marginTop: 6, lineHeight: 1.6 }}>Ask in plain English. I find every snippet involved and stage the change as one card — you apply it with one click, and any change can be undone from History.</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 20 }}>
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => send(s)} disabled={!aiReady} className="st-row" style={{ textAlign: 'left', fontSize: 12, color: T.sub, background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1.45 }}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'stretch', gap: 10, animation: 'stfade .2s ease' }}>
              {m.role === 'user' ? (
                <div style={{ maxWidth: '78%', background: 'rgba(99,102,241,0.18)', border: `1px solid ${T.borderStrong}`, color: 'white', borderRadius: '14px 14px 4px 14px', padding: '9px 13px', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{m.content}</div>
              ) : (
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ width: 26, height: 26, flexShrink: 0, borderRadius: 8, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Sparkles size={13} color="white" /></div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontSize: 13, lineHeight: 1.62, color: m.error ? T.red : '#cbd5e1' }}>
                      {m.pending ? <Working steps={m.steps || []} /> : <MiniMarkdown text={m.content} />}
                      {!m.pending && m.steps && m.steps.length > 0 && <StepsDetails steps={m.steps} />}
                    </div>
                    {(m.changesets || []).map(c => <ChangesetCard key={c.id} initial={c} onOpen={onReview} onChange={updateCs} />)}
                  </div>
                </div>
              )}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <div style={{ padding: '12px 22px 16px', borderTop: `1px solid ${T.border}`, background: 'rgba(12,17,30,0.85)' }}>
          {lastProposed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 11.5, color: T.sub }}>
              <span>Ready: <b style={{ color: 'white' }}>#{lastProposed.id} {lastProposed.title}</b></span>
              <Btn small kind="primary" onClick={applyLatest}><Check size={12} /> Apply</Btn>
              <span style={{ color: T.faint }}>or press Ctrl+Enter</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <textarea ref={inputRef} className="st-input" value={input} onChange={e => setInput(e.target.value)} rows={2}
              placeholder={aiReady ? 'Describe the schema change or ask a question… (Enter to send, Shift+Enter for a new line)' : 'Add an AI key to .env.local to use the assistant'}
              disabled={!aiReady}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyLatest(); return }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
              style={{ ...inputStyle, resize: 'none', minHeight: 46, maxHeight: 160, fontSize: 13, lineHeight: 1.5 }} />
            <Btn kind="primary" onClick={() => send()} disabled={sending || !input.trim() || !aiReady} style={{ height: 46 }}>{sending ? <Spinner /> : <Send size={14} />}</Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

function Working({ steps }: { steps: string[] }) {
  const [t0] = useState(Date.now())
  const [, tick] = useState(0)
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(i) }, [])
  const secs = Math.round((Date.now() - t0) / 1000)
  return (
    <div style={{ color: T.sub, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Spinner /> Working{steps.length ? ` · step ${steps.length}` : ''}{secs > 4 ? ` · ${secs}s` : ''}</span>
      {steps.slice(-4).map((s, i, arr) => (
        <span key={i} style={{ fontSize: 12, color: i === arr.length - 1 ? '#c7d2fe' : T.faint, paddingLeft: 20 }}>{i === arr.length - 1 ? '→ ' : '✓ '}{s}</span>
      ))}
      {secs > 8 && <span style={{ fontSize: 11, color: T.faint, paddingLeft: 20 }}>You can leave this page — the answer will be here when you come back.</span>}
    </div>
  )
}

function StepsDetails({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 6 }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', color: T.faint, fontSize: 11, cursor: 'pointer', padding: 0 }}>{open ? '▾' : '▸'} {steps.length} step{steps.length === 1 ? '' : 's'}</button>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4 }}>{steps.map((s, i) => <span key={i} style={{ fontSize: 11.5, color: T.faint }}>✓ {s}</span>)}</div>}
    </div>
  )
}

// ── Snippets ───────────────────────────────────────────────────────────────
interface SnippetRow { id: number; name: string; status: string; display_on?: string; s_pages?: number[]; s_posts?: number[]; size: number; valid: boolean }

function SnippetsPanel({ openId, setOpenId, onReview, prodOrigin, siteUrl }: { openId: number | null; setOpenId: (id: number | null) => void; onReview: (id: number) => void; prodOrigin: string; siteUrl: string }) {
  const [rows, setRows] = useState<SnippetRow[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [codeSearch, setCodeSearch] = useState(false)
  const [regex, setRegex] = useState(false)
  const [inactive, setInactive] = useState(false)
  const [hits, setHits] = useState<{ total: number; snippetCount: number; results: any[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (fresh = false) => {
    setLoading(true)
    try { setRows((await api<{ snippets: SnippetRow[] }>(`/api/schema-tool/snippets?inactive=${inactive ? 1 : 0}${fresh ? '&fresh=1' : ''}`)).snippets); setErr(null) }
    catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [inactive])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!codeSearch || !q.trim()) { setHits(null); return }
    const t = setTimeout(async () => {
      try { setHits(await api(`/api/schema-tool/snippets?q=${encodeURIComponent(q)}&regex=${regex ? 1 : 0}&inactive=${inactive ? 1 : 0}`)); setErr(null) }
      catch (e: any) { setErr(e.message) }
    }, 350)
    return () => clearTimeout(t)
  }, [q, codeSearch, regex, inactive])

  const filtered = useMemo(() => {
    if (codeSearch || !q.trim()) return rows
    const s = q.toLowerCase()
    return rows.filter(r => r.name.toLowerCase().includes(s) || String(r.id) === s)
  }, [rows, q, codeSearch])

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 380, flexShrink: 0, borderRight: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, borderBottom: `1px solid ${T.border}` }}>
          <div style={{ position: 'relative' }}>
            <Search size={13} color={T.faint} style={{ position: 'absolute', left: 10, top: 10 }} />
            <input className="st-input" value={q} onChange={e => setQ(e.target.value)} placeholder={codeSearch ? 'Search inside schema code… e.g. 3-5 weeks' : 'Filter by page URL or ID…'} style={{ ...inputStyle, paddingLeft: 30 }} />
          </div>
          <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: T.sub, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={codeSearch} onChange={e => setCodeSearch(e.target.checked)} style={{ accentColor: '#8b5cf6' }} />Search code</label>
            {codeSearch && <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={regex} onChange={e => setRegex(e.target.checked)} style={{ accentColor: '#8b5cf6' }} />Regex</label>}
            <label style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}><input type="checkbox" checked={inactive} onChange={e => setInactive(e.target.checked)} style={{ accentColor: '#8b5cf6' }} />Inactive too</label>
            <div style={{ flex: 1 }} />
            <button onClick={() => load(true)} title="Reload from the site" style={{ background: 'none', border: 'none', color: T.sub, cursor: 'pointer' }}><RefreshCw size={13} /></button>
          </div>
          {hits && <div style={{ fontSize: 11.5, color: T.accent }}>{hits.total} mention{hits.total === 1 ? '' : 's'} in {hits.snippetCount} snippet{hits.snippetCount === 1 ? '' : 's'}</div>}
          {err && <div style={{ fontSize: 11.5, color: T.red }}>{err}</div>}
        </div>
        <div className="st-scroll" style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
          {loading && <div style={{ color: T.faint, fontSize: 12, padding: 16, textAlign: 'center' }}><Spinner /> Loading snippets…</div>}
          {!loading && hits && hits.results.map(r => (
            <div key={r.snippet_id} className="st-row" onClick={() => setOpenId(r.snippet_id)} style={{ padding: '8px 10px', borderRadius: 8, cursor: 'pointer', background: openId === r.snippet_id ? 'rgba(99,102,241,0.14)' : 'transparent' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint }}>#{r.snippet_id}</span>
                <span style={{ fontSize: 12, color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(r.name)}</span>
                <Pill tone="accent">{r.count}</Pill>
              </div>
              {r.occurrences.slice(0, 2).map((o: any, k: number) => (
                <div key={k} style={{ fontSize: 11, color: T.faint, marginTop: 4, lineHeight: 1.45 }}>…{o.before}<mark style={{ background: 'rgba(251,191,36,0.25)', color: '#fde68a', borderRadius: 3, padding: '0 2px' }}>{o.match}</mark>{o.after}…</div>
              ))}
            </div>
          ))}
          {!loading && !hits && filtered.map(r => (
            <div key={r.id} className="st-row" onClick={() => setOpenId(r.id)} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderRadius: 8, cursor: 'pointer', background: openId === r.id ? 'rgba(99,102,241,0.14)' : 'transparent' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: r.status === 'active' ? T.green : 'rgba(148,163,184,0.35)' }} title={r.status} />
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.faint, width: 34 }}>#{r.id}</span>
              <span style={{ fontSize: 12, color: T.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(r.name)}</span>
              {!r.valid && <Pill tone="red">invalid</Pill>}
            </div>
          ))}
          {!loading && !hits && !filtered.length && <div style={{ color: T.faint, fontSize: 12, padding: 16, textAlign: 'center' }}>No snippets match.</div>}
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {openId == null
          ? <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.faint, fontSize: 12.5 }}>Pick a snippet to view or edit it.</div>
          : <SnippetEditor key={openId} id={openId} onReview={onReview} siteUrl={siteUrl} prodOrigin={prodOrigin} onSaved={() => load(true)} />}
      </div>
    </div>
  )
}

function SnippetEditor({ id, onReview, siteUrl, prodOrigin, onSaved }: { id: number; onReview: (id: number) => void; siteUrl: string; prodOrigin: string; onSaved: () => void }) {
  const [s, setS] = useState<any>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<CsSummary | null>(null)

  const load = useCallback(async () => {
    try { const d = await api<{ snippet: any }>(`/api/schema-tool/snippets/${id}`); setS(d.snippet); setText(d.snippet.snippet); setErr(null) }
    catch (e: any) { setErr(e.message) }
  }, [id])
  useEffect(() => { load() }, [load])

  const validation = useMemo(() => {
    const re = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi
    let m: RegExpExecArray | null, n = 0
    while ((m = re.exec(text))) { n++; try { JSON.parse(m[1]) } catch (e: any) { return { ok: false, msg: `Block ${n}: ${e.message}` } } }
    return { ok: true, msg: `${n} JSON-LD block${n === 1 ? '' : 's'} · valid` }
  }, [text])
  const dirty = s && text !== s.snippet

  const save = async () => {
    setSaving(true); setErr(null)
    try {
      const d = await api<{ changeset?: CsSummary; unchanged?: boolean }>(`/api/schema-tool/snippets/${id}`, { snippet: text, base: s.snippet })
      if (d.changeset) setSaved(d.changeset)
      setTimeout(() => { load(); onSaved() }, 1500)
    } catch (e: any) { setErr(e.message) } finally { setSaving(false) }
  }

  const pageUrl = s ? (s.name || '').replace(prodOrigin, siteUrl) : ''
  if (!s) return <div style={{ padding: 30, color: T.faint, fontSize: 12 }}>{err ? <span style={{ color: T.red }}>{err}</span> : <><Spinner /> Loading…</>}</div>
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '12px 18px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: T.faint, fontFamily: T.mono }}>#{s.id} · {s.display_on === 's_pages' ? `pages ${JSON.stringify(s.s_pages)}` : s.display_on === 's_posts' ? `posts ${JSON.stringify(s.s_posts)}` : s.display_on}</div>
          <div style={{ fontSize: 14, color: 'white', fontWeight: 650, marginTop: 2, wordBreak: 'break-all' }}>{shortName(s.name)}</div>
        </div>
        <Pill tone={statusTone(s.status)}>{s.status}</Pill>
        <Pill tone={validation.ok ? 'green' : 'red'}>{validation.msg}</Pill>
        {pageUrl.startsWith('http') && <a href={pageUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Btn small><ExternalLink size={12} /> Page</Btn></a>}
        {pageUrl.startsWith('http') && <a href={`https://search.google.com/test/rich-results?url=${encodeURIComponent(pageUrl)}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Btn small>Rich Results</Btn></a>}
        {pageUrl.startsWith('http') && <a href={`https://validator.schema.org/#url=${encodeURIComponent(pageUrl)}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}><Btn small>Validator</Btn></a>}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 12 }}>
        <textarea className="st-input st-scroll" value={text} onChange={e => setText(e.target.value)} spellCheck={false}
          style={{ ...inputStyle, height: '100%', resize: 'none', fontFamily: T.mono, fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre', overflow: 'auto', tabSize: 2 }} />
      </div>
      <div style={{ padding: '10px 18px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: 10, alignItems: 'center' }}>
        {err && <span style={{ color: T.red, fontSize: 12, flex: 1 }}>{err}</span>}
        {!err && saved && <span style={{ color: T.green, fontSize: 12, flex: 1, display: 'inline-flex', gap: 6, alignItems: 'center' }}><Check size={13} /> Saved as change #{saved.id} — <a onClick={() => onReview(saved.id)} style={{ color: T.accent, cursor: 'pointer' }}>details / undo</a></span>}
        {!err && !saved && <span style={{ color: T.faint, fontSize: 12, flex: 1 }}>{dirty ? 'Unsaved edits. Saving applies to the site right away and can be undone from History.' : 'Edit the JSON-LD directly, or ask the Assistant to do it.'}</span>}
        {dirty && <Btn kind="subtle" onClick={() => setText(s.snippet)}><X size={13} /> Reset</Btn>}
        <Btn kind="primary" onClick={save} disabled={!dirty || !validation.ok || saving}>{saving ? <Spinner /> : <Check size={14} />} Save to site</Btn>
      </div>
    </div>
  )
}

// ── History ────────────────────────────────────────────────────────────────
function HistoryPanel({ onReview }: { onReview: (id: number) => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'applied' | 'proposed'>('all')
  const load = useCallback(async () => { try { setRows((await api<{ changesets: any[] }>('/api/schema-tool/changesets?limit=150')).changesets) } catch { setRows([]) } }, [])
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [load])
  const shown = (rows || []).filter(r => filter === 'all' || (filter === 'applied' ? ['applied', 'partial', 'revert_partial'].includes(r.status) : r.status === 'proposed'))
  const undo = async (id: number) => { try { await api(`/api/schema-tool/changesets/${id}`, { action: 'revert' }); load() } catch (e: any) { alert(e.message) } }
  return (
    <div className="st-scroll" style={{ height: '100%', overflowY: 'auto', padding: '16px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ color: 'white', fontWeight: 650, fontSize: 14, flex: 1 }}>Change history</div>
        {(['all', 'applied', 'proposed'] as const).map(f => <Btn key={f} small kind={filter === f ? 'ghost' : 'subtle'} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'applied' ? 'Applied' : 'Waiting'}</Btn>)}
        <Btn small kind="subtle" onClick={load}><RefreshCw size={12} /></Btn>
      </div>
      {!rows && <div style={{ color: T.faint, fontSize: 12 }}><Spinner /> Loading…</div>}
      {rows && !shown.length && <div style={{ color: T.faint, fontSize: 12.5, padding: 30, textAlign: 'center' }}>No changes yet.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {shown.map(r => (
          <div key={r.id} className="st-row" onClick={() => onReview(r.id)} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 120px 150px 120px 90px', gap: 10, alignItems: 'center', padding: '10px 12px', borderRadius: 10, border: `1px solid ${T.border}`, background: T.card, cursor: 'pointer' }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>#{r.id}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</div>
              <div style={{ fontSize: 10.5, color: T.faint, marginTop: 2 }}>{r.source === 'manual' ? 'Manual edit' : 'Assistant'}{r.created_by ? ` · ${r.created_by}` : ''}</div>
            </div>
            <span style={{ fontSize: 11.5, color: T.sub }}>{r.snippet_count} snippet{r.snippet_count === 1 ? '' : 's'}{r.kind !== 'config' ? ` · ${r.mention_count}` : ''}</span>
            <span><Pill tone={statusTone(r.status)}>{r.running && <Spinner size={9} />}{STATUS_LABEL[r.status] || r.status}</Pill></span>
            <span style={{ fontSize: 11, color: T.faint }}>{timeAgo(r.applied_at || r.created_at)}</span>
            <span onClick={e => e.stopPropagation()}>
              {['applied', 'partial', 'revert_partial'].includes(r.status) && <Btn small onClick={() => undo(r.id)}>Undo</Btn>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Page check ─────────────────────────────────────────────────────────────
function PageCheckPanel({ siteUrl, onOpenSnippet }: { siteUrl: string; onOpenSnippet: (id: number) => void }) {
  const [url, setUrl] = useState('')
  const [res, setRes] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async () => {
    if (!url.trim()) return
    setBusy(true); setErr(null)
    try { setRes((await api<{ check: any }>('/api/schema-tool/page-check', { url: url.trim() })).check) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <div className="st-scroll" style={{ height: '100%', overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 860 }}>
        <div style={{ color: 'white', fontWeight: 650, fontSize: 14 }}>Check a page</div>
        <div style={{ color: T.sub, fontSize: 12, marginTop: 4 }}>See which schema a page outputs on {siteUrl ? siteUrl.replace(/^https?:\/\//, '') : 'the site'}, whether it all parses, and whether FAQ schema matches the visible FAQ. Live URLs are mapped to the site automatically.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input className="st-input" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && run()} placeholder="https://phxhomeremodeling.com/services/shower-remodel/  or  /author-ben-chesley/" style={inputStyle} />
          <Btn kind="primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : <Search size={13} />} Check</Btn>
        </div>
        {err && <div style={{ color: T.red, fontSize: 12, marginTop: 10 }}>{err}</div>}
        {res && (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12, animation: 'stfade .2s ease' }}>
            <Card title="Page">
              <Row k="Final URL" v={<a href={res.finalUrl} target="_blank" rel="noreferrer" style={{ color: T.accent }}>{res.finalUrl}</a>} />
              <Row k="Status" v={<Pill tone={res.status < 400 ? 'green' : 'red'}>HTTP {res.status}</Pill>} />
              <Row k="WordPress ID" v={res.pageId ? `${res.pageType} ${res.pageId}` : '—'} />
              <Row k="Canonical" v={<span style={{ color: res.canonical && res.canonical.replace(/\/$/, '') !== res.finalUrl.replace(/\/$/, '') ? T.amber : T.sub }}>{res.canonical || '—'}</span>} />
            </Card>
            <Card title="HFCM snippets on this page">
              {res.hfcmSnippets.length === 0 && <div style={{ color: T.amber, fontSize: 12 }}>No HFCM schema is output on this page.</div>}
              {res.hfcmSnippets.map((s: any) => <div key={s.id} style={{ fontSize: 12, color: T.sub, display: 'flex', gap: 8 }}><a onClick={() => onOpenSnippet(s.id)} style={{ color: T.accent, cursor: 'pointer', fontFamily: T.mono }}>#{s.id}</a>{shortName(s.name)}</div>)}
              {res.expectedSnippets.filter((s: any) => !s.showing).map((s: any) => (
                <div key={s.id} style={{ fontSize: 12, color: T.amber, marginTop: 4 }}>⚠ #{s.id} is named for this page but isn't showing — ask the Assistant to re-attach it.</div>
              ))}
            </Card>
            <Card title="JSON-LD blocks">
              {res.jsonLd.map((b: any, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: T.sub, padding: '3px 0' }}>
                  <Pill tone={b.valid ? 'green' : 'red'}>{b.valid ? 'valid' : 'invalid'}</Pill><Pill>{b.source}</Pill>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.valid ? b.types.join(', ') : b.error}</span>
                </div>
              ))}
            </Card>
            <Card title={`FAQ schema vs page (${res.faq.total} questions)`}>
              {res.faq.total === 0 && <div style={{ fontSize: 12, color: T.faint }}>No FAQ schema on this page.</div>}
              {res.faq.total > 0 && res.faq.mismatched.length === 0 && <div style={{ fontSize: 12, color: T.green }}><Check size={12} /> Every FAQ answer matches the page word for word.</div>}
              {res.faq.mismatched.map((m: any, i: number) => <div key={i} style={{ fontSize: 12, color: T.sub, padding: '2px 0' }}><span style={{ color: T.amber }}>{m.reason}:</span> {m.q}</div>)}
            </Card>
          </div>
        )}
      </div>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, background: T.card, padding: 14 }}><div style={{ fontSize: 11, color: T.faint, textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 700, marginBottom: 8 }}>{title}</div>{children}</div>
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div style={{ display: 'flex', gap: 12, fontSize: 12, padding: '3px 0' }}><span style={{ width: 110, color: T.faint, flexShrink: 0 }}>{k}</span><span style={{ color: T.sub, wordBreak: 'break-all' }}>{v}</span></div>
}

// ── Settings ───────────────────────────────────────────────────────────────
function SettingsModal({ status, onClose, onSaved }: { status: Status; onClose: () => void; onSaved: () => void }) {
  const [auto, setAuto] = useState(status.settings.auto_apply_max)
  const [rules, setRules] = useState(status.settings.rules)
  const [busy, setBusy] = useState(false)
  const save = async () => { setBusy(true); try { await api('/api/schema-tool/status', { auto_apply_max: auto, rules }); onSaved(); onClose() } finally { setBusy(false) } }
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(2,6,15,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(640px,100%)', background: '#0b1020', border: `1px solid ${T.borderStrong}`, borderRadius: 14, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, animation: 'stfade .18s ease' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}><div style={{ color: 'white', fontWeight: 700, fontSize: 15, flex: 1 }}>Schema tool settings</div><button onClick={onClose} style={{ background: 'none', border: 'none', color: T.sub, cursor: 'pointer' }}><X size={18} /></button></div>
        <div>
          <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>Auto-apply</div>
          <div style={{ fontSize: 11.5, color: T.sub, margin: '3px 0 8px' }}>Changes the assistant stages are applied immediately when they touch this many snippets or fewer. Everything stays undoable in History. Larger changes always wait for one click.</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[0, 1, 3, 10, 25].map(n => <Btn key={n} small kind={auto === n ? 'primary' : 'ghost'} onClick={() => setAuto(n)}>{n === 0 ? 'Off' : `≤ ${n}`}</Btn>)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>House rules for the assistant</div>
          <div style={{ fontSize: 11.5, color: T.sub, margin: '3px 0 8px' }}>The assistant follows these on every request.</div>
          <textarea className="st-input st-scroll" value={rules} onChange={e => setRules(e.target.value)} rows={12} style={{ ...inputStyle, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }} />
          <button onClick={() => setRules(status.defaultRules)} style={{ background: 'none', border: 'none', color: T.accent, fontSize: 11.5, cursor: 'pointer', padding: '4px 0' }}>Reset to defaults</button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Btn kind="subtle" onClick={onClose}>Cancel</Btn>
          <Btn kind="primary" onClick={save} disabled={busy}>{busy ? <Spinner /> : <Check size={14} />} Save</Btn>
        </div>
      </div>
    </div>
  )
}
