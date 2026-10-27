'use client'
/** Schema Tool — changeset card (one-click apply / undo) and review drawer. */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Eye, RotateCcw, X, AlertTriangle } from 'lucide-react'
import { Btn, Pill, Spinner, STATUS_LABEL, T, WordDiff, api, shortName, statusTone, timeAgo } from './ui'

export interface CsSummary {
  id: number; title: string; summary?: string | null; kind: string; status: string; source: string
  created_at: string; applied_at?: string | null; created_by?: string | null; running?: boolean
  snippet_count: number; mention_count: number
  counts: { total: number; applied: number; pending: number; failed: number; conflict: number; reverted: number; skipped: number }
  samples: { snippet_id: number; snippet_name: string | null; preview: any }[]
  meta?: any
}

const ACTIVE = ['applying', 'reverting']

export function useChangeset(initial: CsSummary, onChange?: (c: CsSummary) => void) {
  const [cs, setCs] = useState<CsSummary>(initial)
  const timer = useRef<any>(null)
  useEffect(() => { setCs(initial) }, [initial.id, initial.status]) // eslint-disable-line
  const refresh = useCallback(async () => {
    const d = await api<{ changeset: CsSummary }>(`/api/schema-tool/changesets/${initial.id}`)
    setCs(d.changeset); onChange?.(d.changeset)
    return d.changeset
  }, [initial.id, onChange])
  useEffect(() => {
    if (ACTIVE.indexOf(cs.status) >= 0 || cs.running) {
      timer.current = setTimeout(() => { refresh().catch(() => {}) }, 1100)
    }
    return () => clearTimeout(timer.current)
  }, [cs, refresh])
  const act = useCallback(async (action: 'apply' | 'revert' | 'discard', extra?: any) => {
    const d = await api<{ changeset: CsSummary }>(`/api/schema-tool/changesets/${initial.id}`, { action, ...extra })
    setCs(d.changeset); onChange?.(d.changeset)
  }, [initial.id, onChange])
  return { cs, act, refresh }
}

export function SamplePreview({ p }: { p: any }) {
  if (!p) return null
  if (p.match !== undefined && p.replacement !== undefined) {
    // replace-style sample: …context [old → new] context…
    return (
      <div style={{ fontSize: 12, lineHeight: 1.55, color: T.sub }}>
        {p.question && <div style={{ fontSize: 10.5, color: T.faint, marginBottom: 2 }}>FAQ · {p.question}</div>}
        …<WordDiff a={String(p.before)} b={String(p.after)} />…
      </div>
    )
  }
  return (
    <div style={{ fontSize: 12, lineHeight: 1.55, color: T.sub }}>
      {p.context && <div style={{ fontSize: 10.5, color: T.faint, marginBottom: 2, fontFamily: T.mono }}>{p.context}</div>}
      <WordDiff a={String(p.before || '')} b={String(p.after || '')} />
    </div>
  )
}

export function ChangesetCard({ initial, onOpen, compact, onChange }: { initial: CsSummary; onOpen?: (id: number) => void; compact?: boolean; onChange?: (c: CsSummary) => void }) {
  const { cs, act } = useChangeset(initial, onChange)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const skipped = cs.meta?.skipped_count || 0
  const invalid: any[] = cs.meta?.invalid || []
  const progress = cs.counts.total ? (cs.status === 'reverting' ? cs.counts.reverted : cs.counts.applied + cs.counts.failed + cs.counts.conflict) / cs.counts.total : 0

  const run = async (a: 'apply' | 'revert' | 'discard', extra?: any) => {
    setBusy(true); setErr(null)
    try { await act(a, extra) } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const working = ACTIVE.indexOf(cs.status) >= 0
  return (
    <div style={{ border: `1px solid ${cs.status === 'proposed' ? T.borderStrong : T.border}`, background: T.card, borderRadius: 12, padding: 14, animation: 'stfade .2s ease', boxShadow: cs.status === 'proposed' ? '0 0 0 1px rgba(99,102,241,0.06), 0 8px 24px rgba(0,0,0,0.25)' : 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>#{cs.id}</span>
        <span style={{ color: 'white', fontWeight: 650, fontSize: 13, flex: 1, minWidth: 160 }}>{cs.title}</span>
        <Pill tone={statusTone(cs.status)}>{working && <Spinner size={9} />}{STATUS_LABEL[cs.status] || cs.status}</Pill>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Pill>{cs.snippet_count} snippet{cs.snippet_count === 1 ? '' : 's'}</Pill>
        {cs.kind !== 'config' && <Pill>{cs.mention_count} change{cs.mention_count === 1 ? '' : 's'}</Pill>}
        {cs.kind === 'config' && <Pill>placement / settings</Pill>}
        {cs.kind === 'revert' && <Pill tone="amber">undo</Pill>}
        {skipped > 0 && <span onClick={() => setShowSkipped(s => !s)} style={{ cursor: 'pointer' }}><Pill tone="amber" title="Matches the assistant left alone">{skipped} left as-is {showSkipped ? '▾' : '▸'}</Pill></span>}
        {invalid.length > 0 && <Pill tone="red" title={invalid.map(i => `#${i.snippet_id}: ${i.error}`).join('\n')}>{invalid.length} blocked (invalid JSON)</Pill>}
        {cs.counts.conflict > 0 && <Pill tone="red">{cs.counts.conflict} changed since staged</Pill>}
        {cs.counts.failed > 0 && <Pill tone="red">{cs.counts.failed} failed</Pill>}
      </div>

      {!compact && cs.samples.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cs.samples.slice(0, 3).map((s, i) => (
            <div key={i} style={{ background: 'rgba(8,12,20,0.55)', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ fontSize: 10.5, color: T.faint, marginBottom: 4, fontFamily: T.mono }}>#{s.snippet_id} {shortName(s.snippet_name || '')}</div>
              <SamplePreview p={s.preview} />
            </div>
          ))}
        </div>
      )}

      {showSkipped && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 220, overflowY: 'auto' }} className="st-scroll">
          {(cs.meta?.skipped || []).map((s: any, i: number) => (
            <div key={i} style={{ fontSize: 11.5, color: T.sub, background: T.amberBg, border: `1px solid ${T.amberBorder}`, borderRadius: 6, padding: '5px 8px' }}>
              <span style={{ color: T.amber, fontWeight: 600 }}>#{s.snippet_id} · {s.reason}</span> — …{s.before}<b style={{ color: 'white' }}>{s.match}</b>{s.after}…
            </div>
          ))}
        </div>
      )}

      {working && (
        <div style={{ marginTop: 10, height: 4, background: 'rgba(99,102,241,0.12)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(progress * 100)}%`, height: '100%', background: 'linear-gradient(90deg,#6366f1,#8b5cf6)', transition: 'width .4s' }} />
        </div>
      )}

      {err && <div style={{ marginTop: 8, fontSize: 12, color: T.red }}>{err}</div>}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {cs.status === 'proposed' && <>
          <Btn kind="primary" onClick={() => run('apply')} disabled={busy}>{busy ? <Spinner /> : <Check size={14} />} Apply{cs.snippet_count > 1 ? ` to ${cs.snippet_count} snippets` : ''}</Btn>
          {onOpen && <Btn onClick={() => onOpen(cs.id)}><Eye size={13} /> Review</Btn>}
          <Btn kind="subtle" onClick={() => run('discard')} disabled={busy}><X size={13} /> Discard</Btn>
        </>}
        {(cs.status === 'applied' || cs.status === 'partial' || cs.status === 'revert_partial') && <>
          <span style={{ color: T.green, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Check size={13} /> {cs.counts.applied} saved{cs.applied_at ? ` · ${timeAgo(cs.applied_at)}` : ''}</span>
          <div style={{ flex: 1 }} />
          {onOpen && <Btn kind="subtle" small onClick={() => onOpen(cs.id)}><Eye size={12} /> Details</Btn>}
          <Btn small onClick={() => run('revert')} disabled={busy}><RotateCcw size={12} /> Undo</Btn>
        </>}
        {(cs.status === 'partial' || cs.status === 'failed') && cs.counts.failed + cs.counts.conflict > 0 && (
          <Btn small kind="danger" onClick={() => run('apply')} disabled={busy} title="Retry failed items (conflicts need a fresh request)"><AlertTriangle size={12} /> Retry failed</Btn>
        )}
        {(cs.status === 'reverted' || cs.status === 'discarded') && onOpen && <Btn kind="subtle" small onClick={() => onOpen(cs.id)}><Eye size={12} /> Details</Btn>}
      </div>
    </div>
  )
}

// ── Review drawer: every snippet in a changeset, select/deselect, full diff ──
export function ReviewDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<{ changeset: CsSummary; items: any[] } | null>(null)
  const [sel, setSel] = useState<Record<number, boolean>>({})
  const [open, setOpen] = useState<number | null>(null)
  const [hunks, setHunks] = useState<Record<number, any[]>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const d = await api<{ changeset: CsSummary; items: any[] }>(`/api/schema-tool/changesets/${id}`)
    setData(d)
    setSel(s => Object.keys(s).length ? s : Object.fromEntries(d.items.map((i: any) => [i.id, !!i.selected])))
    return d
  }, [id])
  useEffect(() => { load().catch(e => setErr(e.message)) }, [load])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (!data) return
    if (ACTIVE.indexOf(data.changeset.status) < 0) return
    const t = setTimeout(() => load().catch(() => {}), 1100)
    return () => clearTimeout(t)
  }, [data, load])

  const toggleOpen = async (itemId: number) => {
    if (open === itemId) { setOpen(null); return }
    setOpen(itemId)
    if (!hunks[itemId]) {
      const d = await api<{ hunks: any[] }>(`/api/schema-tool/changesets/${id}?item=${itemId}`)
      setHunks(h => ({ ...h, [itemId]: d.hunks }))
    }
  }

  const act = async (action: string, extra?: any) => {
    setBusy(true); setErr(null)
    try { await api(`/api/schema-tool/changesets/${id}`, { action, ...extra }); await load() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  const cs = data?.changeset
  const selectedIds = data ? data.items.filter(i => sel[i.id]).map(i => i.id) : []
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,15,0.55)', backdropFilter: 'blur(2px)', zIndex: 300, display: 'flex', justifyContent: 'flex-end' }}>
      <div onClick={e => e.stopPropagation()} className="st-scroll" style={{ width: 'min(760px, 100%)', height: '100%', background: '#0b1020', borderLeft: `1px solid ${T.borderStrong}`, display: 'flex', flexDirection: 'column', animation: 'stfade .18s ease' }}>
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.faint, fontSize: 11, fontFamily: T.mono }}>Changeset #{id}{cs ? ` · ${cs.source} · ${timeAgo(cs.created_at)}${cs.created_by ? ` · ${cs.created_by}` : ''}` : ''}</div>
            <div style={{ color: 'white', fontWeight: 700, fontSize: 15, marginTop: 2 }}>{cs?.title || 'Loading…'}</div>
          </div>
          {cs && <Pill tone={statusTone(cs.status)}>{STATUS_LABEL[cs.status] || cs.status}</Pill>}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.sub, cursor: 'pointer' }}><X size={18} /></button>
        </div>
        {err && <div style={{ padding: '8px 20px', color: T.red, fontSize: 12 }}>{err}</div>}
        <div className="st-scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {!data && <div style={{ color: T.faint, fontSize: 12, padding: 20, textAlign: 'center' }}><Spinner /> Loading…</div>}
          {data?.items.map(it => (
            <div key={it.id} style={{ border: `1px solid ${T.border}`, borderRadius: 10, background: T.card }}>
              <div className="st-row" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', cursor: 'pointer', borderRadius: 10 }} onClick={() => toggleOpen(it.id)}>
                {cs?.status === 'proposed' && (
                  <input type="checkbox" checked={!!sel[it.id]} onClick={e => e.stopPropagation()} onChange={e => setSel(s => ({ ...s, [it.id]: e.target.checked }))} style={{ accentColor: '#8b5cf6' }} />
                )}
                {open === it.id ? <ChevronDown size={14} color={T.sub} /> : <ChevronRight size={14} color={T.sub} />}
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.faint }}>#{it.snippet_id}</span>
                <span style={{ color: T.text, fontSize: 12.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName(it.snippet_name)}</span>
                {it.mentions > 1 && <Pill>{it.mentions}×</Pill>}
                <Pill tone={statusTone(it.status)} title={it.error || ''}>{STATUS_LABEL[it.status] || it.status}</Pill>
              </div>
              {it.error && <div style={{ padding: '0 12px 8px 40px', fontSize: 11.5, color: it.status === 'applied' ? T.amber : T.red }}>{it.error}</div>}
              {open === it.id && (
                <div style={{ padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {!hunks[it.id] && <div style={{ color: T.faint, fontSize: 12 }}><Spinner /> Loading diff…</div>}
                  {(hunks[it.id] || []).map((h: any, k: number) => (
                    <div key={k} style={{ fontFamily: T.mono, fontSize: 11.5, lineHeight: 1.5, background: 'rgba(8,12,20,0.7)', border: `1px solid ${T.border}`, borderRadius: 7, padding: '6px 9px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {h.context && <div style={{ color: T.faint }}>{h.context}</div>}
                      {h.before.length === h.after.length
                        ? h.before.map((b: string, x: number) => <div key={x}><WordDiff a={b.trim()} b={h.after[x].trim()} /></div>)
                        : <>{h.before.map((b: string, x: number) => <div key={'b' + x} style={{ color: '#fca5a5' }}>- {b}</div>)}{h.after.map((b: string, x: number) => <div key={'a' + x} style={{ color: '#6ee7b7' }}>+ {b}</div>)}</>}
                    </div>
                  ))}
                  {hunks[it.id] && !hunks[it.id].length && <div style={{ color: T.faint, fontSize: 12 }}>No differences.</div>}
                </div>
              )}
            </div>
          ))}
        </div>
        {cs && (
          <div style={{ padding: '12px 20px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: 8, alignItems: 'center' }}>
            {cs.status === 'proposed' && <>
              <span style={{ color: T.sub, fontSize: 12, flex: 1 }}>{selectedIds.length} of {data!.items.length} selected</span>
              <Btn kind="subtle" onClick={() => act('discard')} disabled={busy}>Discard</Btn>
              <Btn kind="primary" onClick={() => act('apply', { item_ids: selectedIds })} disabled={busy || !selectedIds.length}><Check size={14} /> Apply selected</Btn>
            </>}
            {(cs.status === 'applied' || cs.status === 'partial' || cs.status === 'revert_partial') && <>
              <span style={{ color: T.sub, fontSize: 12, flex: 1 }}>Undo restores each snippet to how it was before this change (skips any edited again since).</span>
              <Btn onClick={() => act('revert')} disabled={busy}><RotateCcw size={13} /> Undo this change</Btn>
            </>}
            {ACTIVE.indexOf(cs.status) >= 0 && <span style={{ color: T.sub, fontSize: 12 }}><Spinner /> Working… {cs.counts.applied}/{cs.counts.total}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
