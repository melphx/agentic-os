'use client'
/** Schema Tool — connected Google Sheets / Docs the assistant reads (formatting preserved). */
import React, { useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Trash2, Eye, EyeOff, Sparkles, Copy, Check, FileSpreadsheet, FileText, Pencil, X } from 'lucide-react'
import { Btn, Pill, Spinner, T, api, inputStyle, timeAgo } from './ui'

interface Source {
  id: number; label: string; url: string; doc_type: 'sheet' | 'doc'; tab: string | null; legend: string | null; enabled: number
  title: string | null; fetched_at: string | null; error: string | null; row_count: number
  changes: { added: string[]; changed: string[]; removed: string[] } | null
  content?: string
  writeback?: { status_col: string; note_col: string; values: string[] } | null
}

export function SourcesPanel({ onAsk }: { onAsk: (text: string, opts?: { send?: boolean }) => void }) {
  const [list, setList] = useState<Source[] | null>(null)
  const [sa, setSa] = useState<string | null>(null)
  const [defLegend, setDefLegend] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await api<{ sources: Source[]; service_account: string | null; default_legend: string }>('/api/schema-tool/sources')
      setList(d.sources); setSa(d.service_account); setDefLegend(d.default_legend); setErr(null)
    } catch (e: any) { setErr(e.message); setList([]) }
  }, [])
  useEffect(() => { load() }, [load])

  const copySa = () => { if (sa) { navigator.clipboard?.writeText(sa); setCopied(true); setTimeout(() => setCopied(false), 1500) } }

  return (
    <div className="st-scroll" style={{ height: '100%', overflowY: 'auto', padding: '18px 22px' }}>
      <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ color: 'white', fontWeight: 650, fontSize: 14 }}>Connected sheets & docs</div>
            <div style={{ color: T.sub, fontSize: 12, marginTop: 4, lineHeight: 1.55 }}>
              The assistant reads these alongside the schema, including <span style={{ color: '#f87171' }}>red text</span>, <span style={{ background: 'rgba(250,204,21,0.25)', color: '#fde68a', padding: '0 3px', borderRadius: 3 }}>highlights</span>, <s>strikethrough</s> and cell notes. Ask things like "sync the Organization sameAs with the SEO sheet" or "what changed in the sheet since last week?".
            </div>
          </div>
          <Btn kind="primary" onClick={() => setAdding(a => !a)}>{adding ? <X size={13} /> : <Plus size={13} />} {adding ? 'Cancel' : 'Connect a sheet or doc'}</Btn>
        </div>

        <div style={{ fontSize: 12, color: T.sub, background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: '9px 12px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Share each sheet or doc (Viewer — or Editor if the assistant should update a status column) with</span>
          {sa ? <code style={{ fontFamily: T.mono, color: '#c7d2fe', background: 'rgba(99,102,241,0.12)', padding: '2px 6px', borderRadius: 5 }}>{sa}</code> : <span style={{ color: T.amber }}>the MCD Google service account (not found — set SCHEMA_TOOL_SA_JSON or INITIATIVES_SA_JSON)</span>}
          {sa && <button onClick={copySa} style={{ background: 'none', border: 'none', color: T.accent, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5 }}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? 'Copied' : 'Copy'}</button>}
        </div>

        {adding && <AddForm defLegend={defLegend} onDone={() => { setAdding(false); load() }} />}
        {err && <div style={{ color: T.red, fontSize: 12 }}>{err}</div>}
        {!list && <div style={{ color: T.faint, fontSize: 12 }}><Spinner /> Loading…</div>}
        {list && !list.length && !adding && <div style={{ color: T.faint, fontSize: 12.5, padding: 30, textAlign: 'center', border: `1px dashed ${T.border}`, borderRadius: 12 }}>No sources yet. Connect your sameAs sheet to let the assistant keep schema in sync with it.</div>}
        {list?.map(s => <SourceCard key={s.id} s={s} onChanged={load} onAsk={onAsk} defLegend={defLegend} />)}
      </div>
    </div>
  )
}

function AddForm({ defLegend, onDone }: { defLegend: string; onDone: () => void }) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [tabs, setTabs] = useState<string[] | null>(null)
  const [tab, setTab] = useState('')
  const [docType, setDocType] = useState<'sheet' | 'doc' | null>(null)
  const [legend, setLegend] = useState(defLegend)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const lookup = async () => {
    if (!url.trim()) return
    setErr(null); setTabs(null)
    try {
      const d = await api<{ doc_type: 'sheet' | 'doc'; tabs: string[]; title?: string }>('/api/schema-tool/sources', { action: 'tabs', url })
      setDocType(d.doc_type); setTabs(d.tabs)
      if (d.title && !label) setLabel(d.title)
      if (d.doc_type === 'doc') setLegend('')
      const sameAs = d.tabs.find(t => /same\s*as/i.test(t))
      setTab(sameAs || d.tabs[0] || '')
    } catch (e: any) { setErr(e.message) }
  }

  const add = async () => {
    setBusy(true); setErr(null)
    try { await api('/api/schema-tool/sources', { url, label: label || undefined, tab: tab || undefined, legend }); onDone() }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <div style={{ border: `1px solid ${T.borderStrong}`, background: T.card, borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, animation: 'stfade .2s ease' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="st-input" value={url} onChange={e => setUrl(e.target.value)} onBlur={lookup} onKeyDown={e => e.key === 'Enter' && lookup()} placeholder="Google Sheets or Docs link" style={inputStyle} />
        <Btn onClick={lookup}>Look up</Btn>
      </div>
      {docType && <>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="st-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Name, e.g. SEO sameAs sheet" style={inputStyle} />
          {docType === 'sheet' && tabs && (
            <select className="st-input" value={tab} onChange={e => setTab(e.target.value)} style={{ ...inputStyle, width: 260 }}>
              {tabs.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: T.sub, marginBottom: 4 }}>How should the assistant read this? (what columns, colours and notes mean)</div>
          <textarea className="st-input st-scroll" value={legend} onChange={e => setLegend(e.target.value)} rows={6} style={{ ...inputStyle, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Btn kind="primary" onClick={add} disabled={busy}>{busy ? <Spinner /> : <Check size={13} />} Connect & read</Btn>
        </div>
      </>}
      {err && <div style={{ color: T.red, fontSize: 12 }}>{err}</div>}
    </div>
  )
}

function SourceCard({ s, onChanged, onAsk, defLegend }: { s: Source; onChanged: () => void; onAsk: (t: string, opts?: { send?: boolean }) => void; defLegend: string }) {
  const [rowFrom, setRowFrom] = useState('')
  const [rowTo, setRowTo] = useState('')
  const rowRange = () => !rowTo || rowTo === rowFrom ? `do row ${rowFrom} only` : `do rows ${Math.min(+rowFrom, +rowTo)}–${Math.max(+rowFrom, +rowTo)} only`
  const syncRows = (what: string) => onAsk(`Sheet "${s.label}" (source #${s.id}): ${what}. Use sheet_row_plan and follow its targets exactly: stage the schema edits each row needs (one change per row, or per city when a row covers many pages), then stage the sheet status for every row — Added with "Added {date}", or Not Added with a short reason. Finish every row; list anything you couldn't do and why.`, { send: true })
  const [wbOpen, setWbOpen] = useState(false)
  const [statusCol, setStatusCol] = useState(s.writeback?.status_col || 'I')
  const [noteCol, setNoteCol] = useState(s.writeback?.note_col || 'E')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [showPrev, setShowPrev] = useState(false)
  const [editing, setEditing] = useState(false)
  const [legend, setLegend] = useState(s.legend || '')
  const [err, setErr] = useState<string | null>(null)
  const ch = s.changes
  const nChanges = ch ? ch.added.length + ch.changed.length + ch.removed.length : 0

  const act = async (body: any) => {
    setBusy(true); setErr(null)
    try { await api(`/api/schema-tool/sources/${s.id}`, body); onChanged(); if (showPrev) await loadPreview() } catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const loadPreview = async () => { const d = await api<{ source: Source }>(`/api/schema-tool/sources/${s.id}`); setPreview(d.source.content || '') }
  const togglePreview = async () => { if (!showPrev && preview == null) await loadPreview(); setShowPrev(v => !v) }
  const remove = async () => { if (!confirm(`Disconnect "${s.label}"? The sheet itself is not touched.`)) return; await fetch(`/api/schema-tool/sources/${s.id}`, { method: 'DELETE' }); onChanged() }

  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.card, borderRadius: 12, padding: 14, opacity: s.enabled ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {s.doc_type === 'sheet' ? <FileSpreadsheet size={16} color="#34d399" /> : <FileText size={16} color="#60a5fa" />}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ color: 'white', fontWeight: 650, fontSize: 13 }}>{s.label}</div>
          <div style={{ fontSize: 11, color: T.faint, marginTop: 2 }}>
            <a href={s.url} target="_blank" rel="noreferrer" style={{ color: T.faint }}>{s.title || 'Open'}</a>{s.tab ? ` · ${s.tab}` : ''} · {s.row_count} rows · {s.fetched_at ? `read ${timeAgo(s.fetched_at)}` : 'not read yet'}
          </div>
        </div>
        {s.error ? <Pill tone="red" title={s.error}>Can't read</Pill> : <Pill tone="green">Connected</Pill>}
        {ch && <Pill tone={nChanges ? 'amber' : 'neutral'} title={nChanges ? [...ch.added.map(x => '+ ' + x), ...ch.changed.map(x => '~ ' + x), ...ch.removed.map(x => '− ' + x)].join('\n').slice(0, 2000) : ''}>{nChanges ? `${ch.added.length} new · ${ch.changed.length} changed · ${ch.removed.length} removed` : 'No changes at last read'}</Pill>}
      </div>
      {s.error && <div style={{ fontSize: 12, color: T.red, marginTop: 8 }}>{s.error}</div>}
      {err && <div style={{ fontSize: 12, color: T.red, marginTop: 8 }}>{err}</div>}

      {editing ? (
        <div style={{ marginTop: 10 }}>
          <textarea className="st-input st-scroll" value={legend} onChange={e => setLegend(e.target.value)} rows={6} style={{ ...inputStyle, fontSize: 12, lineHeight: 1.5, resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 6 }}>
            {s.doc_type === 'sheet' && <button onClick={() => setLegend(defLegend)} style={{ background: 'none', border: 'none', color: T.accent, fontSize: 11.5, cursor: 'pointer', marginRight: 'auto' }}>Use the default sameAs-sheet guide</button>}
            <Btn kind="subtle" small onClick={() => { setEditing(false); setLegend(s.legend || '') }}>Cancel</Btn>
            <Btn kind="primary" small onClick={async () => { await act({ legend }); setEditing(false) }}>Save</Btn>
          </div>
        </div>
      ) : s.legend ? (
        <div style={{ marginTop: 10, fontSize: 11.5, color: T.sub, whiteSpace: 'pre-wrap', lineHeight: 1.5, background: 'rgba(8,12,20,0.5)', border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 10px' }}>{s.legend}</div>
      ) : null}

      {s.doc_type === 'sheet' && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.sub, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {s.writeback && !wbOpen ? <>
            <Pill tone="green">Write-back on</Pill>
            <span>Status dropdown in column <b style={{ color: 'white' }}>{s.writeback.status_col}</b> ({s.writeback.values.join(' / ')}) · dates written to notes (black) in column <b style={{ color: 'white' }}>{s.writeback.note_col}</b> — written only when you apply a change.</span>
            <button onClick={() => setWbOpen(true)} style={{ background: 'none', border: 'none', color: T.accent, fontSize: 11.5, cursor: 'pointer' }}>Change</button>
          </> : wbOpen ? <>
            <span>Status column</span>
            <input className="st-input" value={statusCol} onChange={e => setStatusCol(e.target.value.toUpperCase())} style={{ ...inputStyle, width: 52, textAlign: 'center' }} />
            <span>Notes column</span>
            <input className="st-input" value={noteCol} onChange={e => setNoteCol(e.target.value.toUpperCase())} style={{ ...inputStyle, width: 52, textAlign: 'center' }} />
            <Btn small kind="primary" disabled={busy} onClick={async () => { await act({ action: 'setup_writeback', status_col: statusCol, note_col: noteCol }); setWbOpen(false) }}>{busy ? <Spinner size={10} /> : <Check size={12} />} Add dropdown to the sheet</Btn>
            <Btn small kind="subtle" onClick={() => setWbOpen(false)}>Cancel</Btn>
            <span style={{ color: T.faint, width: '100%' }}>Adds a "Schema status" header and an Added / Not Added dropdown to that column (rows 3 and down). Existing columns don't move. The sheet must be shared with the service account as Editor.</span>
          </> : <>
            <span style={{ color: T.faint }}>Let the assistant mark rows Added / Not Added in this sheet?</span>
            <Btn small onClick={() => setWbOpen(true)}><FileSpreadsheet size={12} /> Set up status column</Btn>
          </>}
        </div>
      )}

      {s.writeback && !s.error && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px', borderRadius: 10, background: 'rgba(99,102,241,0.08)', border: `1px solid ${T.border}` }}>
          <Btn kind="primary" small onClick={() => syncRows('do every row whose status (column ' + s.writeback!.status_col + ') is still blank, section by section')}><Sparkles size={12} /> Sync pending rows</Btn>
          <span style={{ color: T.faint, fontSize: 11.5 }}>or rows</span>
          <input className="st-input" value={rowFrom} onChange={e => setRowFrom(e.target.value.replace(/\D/g, ''))} placeholder="160" style={{ ...inputStyle, width: 62, textAlign: 'center', padding: '5px 6px' }} />
          <span style={{ color: T.faint, fontSize: 11.5 }}>to</span>
          <input className="st-input" value={rowTo} onChange={e => setRowTo(e.target.value.replace(/\D/g, ''))} onKeyDown={e => { if (e.key === 'Enter' && rowFrom) syncRows(rowRange()) }} placeholder="170" style={{ ...inputStyle, width: 62, textAlign: 'center', padding: '5px 6px' }} />
          <Btn small disabled={!rowFrom} onClick={() => syncRows(rowRange())}>Sync these rows</Btn>
          <span style={{ color: T.faint, fontSize: 11.5, flexBasis: '100%' }}>Opens a new chat and starts right away. You get change cards to review — nothing is saved or written to the sheet until you click Apply.</span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Btn kind="primary" small onClick={() => onAsk(`Compare the schema with the "${s.label}" source (#${s.id}). Stage whatever needs to change to match it (sameAs links, mentions/subjectOf, replaced/old URLs, rows marked red, NO rows that are still in schema) and list anything you're leaving out and why.${s.writeback ? ' Then stage the sheet status for every row you checked (Added / Not Added with a note).' : ''}`)} disabled={!!s.error}><Sparkles size={12} /> Sync schema with this</Btn>
        <Btn small onClick={() => act({ action: 'refresh' })} disabled={busy}>{busy ? <Spinner size={10} /> : <RefreshCw size={12} />} Re-read</Btn>
        <Btn small onClick={togglePreview}>{showPrev ? <EyeOff size={12} /> : <Eye size={12} />} {showPrev ? 'Hide' : 'Preview'}</Btn>
        <Btn small kind="subtle" onClick={() => setEditing(true)}><Pencil size={12} /> How to read it</Btn>
        <div style={{ flex: 1 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: T.sub, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!s.enabled} onChange={e => act({ enabled: e.target.checked })} style={{ accentColor: '#8b5cf6' }} /> Assistant uses it
        </label>
        <Btn small kind="subtle" onClick={remove}><Trash2 size={12} /></Btn>
      </div>

      {showPrev && (
        <div className="st-scroll" style={{ marginTop: 10, maxHeight: 420, overflow: 'auto', border: `1px solid ${T.border}`, borderRadius: 8, background: 'rgba(8,12,20,0.6)' }}>
          {preview == null ? <div style={{ padding: 12, color: T.faint, fontSize: 12 }}><Spinner /> Loading…</div> :
            preview.split('\n').map((line, i) => <PreviewRow key={i} line={line} />)}
        </div>
      )}
    </div>
  )
}

const TAG_COLORS: Record<string, string> = { red: '#f87171', orange: '#fb923c', yellow: '#facc15', green: '#4ade80', teal: '#2dd4bf', blue: '#60a5fa', purple: '#c084fc', pink: '#f472b6', gray: '#94a3b8', white: '#e2e8f0' }

function PreviewRow({ line }: { line: string }) {
  const m = line.match(/^([RP]\d+):\s?(.*)$/)
  if (!m) return null
  const cells = m[2].split(' | ')
  return (
    <div style={{ display: 'flex', gap: 10, padding: '5px 10px', borderBottom: `1px solid rgba(99,102,241,0.06)`, fontSize: 11.5, lineHeight: 1.45 }}>
      <span style={{ fontFamily: T.mono, color: T.faint, width: 40, flexShrink: 0 }}>{m[1]}</span>
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', color: T.sub, minWidth: 0 }}>
        {cells.map((c, j) => {
          const tag = c.match(/\s\{([a-z:,]+)\}/)
          const tags = tag ? tag[1].split(',') : []
          const fg = tags.find(t => !t.startsWith('hl:'))
          const hl = tags.find(t => t.startsWith('hl:'))
          let text = c.replace(/\s\{[a-z:,]+\}/, '')
          const strike = /~~.+~~/.test(text)
          text = text.replace(/~~/g, '')
          return (
            <span key={j} style={{ wordBreak: 'break-all', color: fg ? TAG_COLORS[fg] : undefined, textDecoration: strike ? 'line-through' : undefined, background: hl ? `${TAG_COLORS[hl.slice(3)] || '#facc15'}22` : undefined, borderRadius: 3, padding: hl ? '0 3px' : undefined }}>{text}</span>
          )
        })}
      </span>
    </div>
  )
}
