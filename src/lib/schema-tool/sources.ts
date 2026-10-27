/**
 * Schema Tool — external sources (Google Sheets / Docs) the assistant can read alongside the schema.
 * Formatting that carries meaning is kept: text colour, highlight, strikethrough, cell notes, links.
 */
import { spawn } from 'child_process'
import path from 'path'
import { getDb } from '@/lib/db'
import { ensureSchemaToolTables } from './store'

const SCRIPTS_DIR = process.env.MCD_SCRIPTS_DIR || '/root/agentic-os/mcd/scripts'
const VENV_PYTHON = process.env.MCD_VENV_PYTHON || '/root/agentic-os/mcd/venv/bin/python3'

export const DEFAULT_LEGEND = `How to read this sheet:
- Column A says where a URL belongs ("SAMEAS - All Pages", "SAMEAS - Homepage Only", "MENTIONS - …", "NO" = do not use).
- {red} text marks something that still needs to be changed on the schema.
- Notes like "Added 10-2026" / "Replaced 09-2026" tell when a row changed; "old link" cells hold the URL being replaced.
- Blue text is just link styling. Highlights are for the team's own tracking.
- The house rules always win: if the sheet lists a banned site (e.g. Patch, RocketReach, ZoomInfo), don't add it and say so.`

let ensured = false
function ensure() {
  if (ensured) return
  ensureSchemaToolTables()
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS schema_tool_sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      label       TEXT NOT NULL,
      url         TEXT NOT NULL,
      doc_id      TEXT NOT NULL,
      doc_type    TEXT NOT NULL,            -- sheet | doc
      tab         TEXT,
      legend      TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      title       TEXT,
      content     TEXT,                     -- rendered text the assistant reads
      rows_json   TEXT,                     -- { "R4": "rendered row", ... } for change tracking
      changes     TEXT,                     -- JSON: rows added/changed/removed at the last refresh
      fetched_at  TEXT,
      error       TEXT,
      created_by  TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  ensured = true
}

export interface SourceRow {
  id: number; label: string; url: string; doc_id: string; doc_type: 'sheet' | 'doc'; tab: string | null; legend: string | null
  enabled: number; title: string | null; content: string | null; rows_json: string | null; changes: string | null
  fetched_at: string | null; error: string | null; created_by: string | null; created_at: string
}

/** Google links in free text (chat messages). */
export function findGoogleLinks(text: string): string[] {
  const re = /https?:\/\/(?:docs|drive)\.google\.com\/[^\s<>()"']+/g
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) { const u = m[0].replace(/[.,;:!?]+$/, ''); if (parseAnyGoogleUrl(u) && out.indexOf(u) < 0) out.push(u) }
  return out
}

/** Sheets, Docs, and plain Drive files (PDF, Word, Excel… stored in Drive). */
export function parseAnyGoogleUrl(url: string): { id: string; type: 'sheet' | 'doc' | 'file'; gid?: string } | null {
  const g = parseGoogleUrl(url)
  if (g) return { id: g.doc_id, type: g.doc_type, gid: g.gid }
  const f = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([a-zA-Z0-9_-]+)/) || url.match(/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/)
  return f ? { id: f[1], type: 'file' } : null
}

export type GoogleRead =
  | { kind: 'sheet' | 'doc'; title: string; tab?: string; tabs?: string[]; text: string }
  | { kind: 'text'; title: string; text: string }
  | { kind: 'binary'; title: string; mime: string; data: Buffer }

/** Read any Google link once (for chat attachments). Sheets read up to 2,000 rows of the linked tab. */
export async function readGoogleLink(url: string, tab?: string): Promise<GoogleRead> {
  const p = parseAnyGoogleUrl(url)
  if (!p) throw new Error('Not a Google Docs / Sheets / Drive link.')
  let type = p.type
  if (type === 'file') {
    const f = await runReader(['file', '--id', p.id])
    if (f.kind === 'native') type = f.doc_type
    else if (f.kind === 'text') return { kind: 'text', title: f.name || 'Google file', text: String(f.text || '') }
    else return { kind: 'binary', title: f.name || 'Drive file', mime: f.mimeType || 'application/octet-stream', data: Buffer.from(f.b64 || '', 'base64') }
  }
  if (type === 'sheet') {
    const raw = await runReader(['sheet', '--id', p.id, '--range', 'A1:Z2000', ...(tab ? ['--tab', tab] : p.gid ? ['--gid', p.gid] : [])])
    return { kind: 'sheet', title: raw.title || 'Google Sheet', tab: raw.tab, tabs: raw.tabs, text: renderSheet(raw).text }
  }
  const raw = await runReader(['doc', '--id', p.id])
  return { kind: 'doc', title: raw.title || 'Google Doc', text: renderDoc(raw).text }
}

export function parseGoogleUrl(url: string): { doc_id: string; doc_type: 'sheet' | 'doc'; gid?: string } | null {
  const sheet = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  if (sheet) { const gid = url.match(/[#&?]gid=(\d+)/); return { doc_id: sheet[1], doc_type: 'sheet', gid: gid?.[1] } }
  const doc = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/)
  if (doc) return { doc_id: doc[1], doc_type: 'doc' }
  return null
}

function runReader(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const proc = spawn(VENV_PYTHON, [path.join(SCRIPTS_DIR, 'schema_source_reader.py'), ...args], { env: { ...process.env }, timeout: 60_000 })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', () => {
      try {
        const j = JSON.parse(out.trim() || '{}')
        if (j.error) reject(new Error(j.error)); else if (!out.trim()) reject(new Error(err.slice(-400) || 'No output from reader')); else resolve(j)
      } catch { reject(new Error((err || out).slice(-400) || 'Reader failed')) }
    })
    proc.on('error', e => reject(e))
  })
}

export async function serviceAccountEmail(): Promise<string | null> {
  try { return (await runReader(['whoami'])).email || null } catch { return null }
}

export async function listTabs(docId: string): Promise<{ title: string; tabs: string[] }> {
  return runReader(['tabs', '--id', docId])
}

// ── rendering ──────────────────────────────────────────────────────────────
type RGB = number[] | null | undefined

export function colorName(c: RGB, kind: 'fg' | 'bg'): string | null {
  if (!c) return null
  const [r, g, b] = [c[0] || 0, c[1] || 0, c[2] || 0]
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  if (kind === 'fg' && max < 0.3) return null                  // black / near-black = default
  if (kind === 'bg' && min > 0.93) return null                 // white = default
  if (max - min < 0.12) return max > 0.8 ? 'white' : 'gray'
  if (r >= g && r >= b) {
    if (g > 0.75 && b < 0.5) return 'yellow'
    if (g > 0.35 && b < 0.35) return 'orange'
    if (b > 0.5) return 'pink'
    return 'red'
  }
  if (g >= r && g >= b) return r > 0.6 ? 'yellow' : b > 0.6 ? 'teal' : 'green'
  return r > 0.5 ? 'purple' : 'blue'
}

const colLetter = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) } return s }
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

export function renderSheet(raw: any): { text: string; rows: Record<string, string> } {
  const rows: Record<string, string> = {}
  const lines: string[] = []
  const start = Number(raw.startRow || 0)
  ;(raw.rowData || []).forEach((row: any, i: number) => {
    const cells: string[] = []
    ;(row.values || []).forEach((v: any, j: number) => {
      const val = v.formattedValue
      if (val == null || String(val).trim() === '') { if (v.note) cells.push(`${colLetter(j)}=(note: ${clean(v.note)})`); return }
      const tf = v.effectiveFormat?.textFormat || {}
      const fg = colorName(tf.foregroundColorStyle?.rgbColor ? [tf.foregroundColorStyle.rgbColor.red, tf.foregroundColorStyle.rgbColor.green, tf.foregroundColorStyle.rgbColor.blue] : null, 'fg')
      const bgS = v.effectiveFormat?.backgroundColorStyle?.rgbColor
      const bg = colorName(bgS ? [bgS.red, bgS.green, bgS.blue] : null, 'bg')
      let t = clean(String(val))
      if (tf.strikethrough) t = `~~${t}~~`
      const tags: string[] = []
      const isLink = !!v.hyperlink || /^https?:\/\//.test(String(val))
      if (fg && !(fg === 'blue' && isLink)) tags.push(fg)
      if (bg) tags.push('hl:' + bg)
      let cell = `${colLetter(j)}=${t}`
      if (tags.length) cell += ` {${tags.join(',')}}`
      if (v.hyperlink && v.hyperlink !== val) cell += ` <${v.hyperlink}>`
      if (v.note) cell += ` (note: ${clean(v.note)})`
      cells.push(cell)
    })
    if (!cells.length) return
    const key = `R${start + i + 1}`
    rows[key] = cells.join(' | ')
    lines.push(`${key}: ${rows[key]}`)
  })
  return { text: lines.join('\n'), rows }
}

export function renderDoc(raw: any): { text: string; rows: Record<string, string> } {
  if (raw.text) {
    const rows: Record<string, string> = {}
    raw.text.split(/\r?\n/).filter((l: string) => l.trim()).forEach((l: string, i: number) => { rows[`P${i + 1}`] = clean(l) })
    return { text: Object.keys(rows).map(k => `${k}: ${rows[k]}`).join('\n'), rows }
  }
  const rows: Record<string, string> = {}
  ;(raw.paragraphs || []).forEach((runs: any[], i: number) => {
    const s = runs.map(r => {
      let t = String(r.t || '').replace(/\n$/, '')
      if (!t.trim()) return t
      if (r.strike) t = `~~${t}~~`
      const fg = colorName(r.fg, 'fg'), bg = colorName(r.bg, 'bg')
      const tags = [fg && !(fg === 'blue' && r.link) ? fg : null, bg ? 'hl:' + bg : null].filter(Boolean)
      if (tags.length) t = `{${tags.join(',')}: ${t}}`
      if (r.link) t += ` <${r.link}>`
      return t
    }).join('')
    if (clean(s)) rows[`P${i + 1}`] = clean(s)
  })
  return { text: Object.keys(rows).map(k => `${k}: ${rows[k]}`).join('\n'), rows }
}

function diffRows(prev: Record<string, string> | null, next: Record<string, string>) {
  if (!prev) return null
  const added: string[] = [], changed: string[] = [], removed: string[] = []
  const prevByText: Record<string, string> = {}
  Object.keys(prev).forEach(k => { prevByText[prev[k]] = k })
  Object.keys(next).forEach(k => {
    if (prev[k] === next[k]) return
    if (prevByText[next[k]]) return // row only moved
    ;(prev[k] ? changed : added).push(`${k}: ${next[k]}`)
  })
  const nextTexts = new Set(Object.keys(next).map(k => next[k]))
  Object.keys(prev).forEach(k => { if (!next[k] && !nextTexts.has(prev[k])) removed.push(`${k}: ${prev[k]}`) })
  return { added, changed, removed }
}

// ── CRUD ───────────────────────────────────────────────────────────────────
export function listSources(): SourceRow[] {
  ensure()
  return getDb().prepare('SELECT * FROM schema_tool_sources ORDER BY id').all() as SourceRow[]
}

export function getSource(id: number): SourceRow | null {
  ensure()
  return (getDb().prepare('SELECT * FROM schema_tool_sources WHERE id=?').get(id) as SourceRow) || null
}

export async function addSource(input: { url: string; label?: string; tab?: string; legend?: string; by?: string | null }): Promise<SourceRow> {
  ensure()
  const p = parseGoogleUrl(input.url)
  if (!p) throw new Error('Paste a Google Sheets or Google Docs link.')
  const r = getDb().prepare('INSERT INTO schema_tool_sources (label,url,doc_id,doc_type,tab,legend,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(input.label || 'Untitled source', input.url, p.doc_id, p.doc_type, input.tab || null, input.legend ?? (p.doc_type === 'sheet' ? DEFAULT_LEGEND : null), input.by || null)
  const id = Number(r.lastInsertRowid)
  await refreshSource(id)
  return getSource(id)!
}

export function updateSource(id: number, f: Partial<Pick<SourceRow, 'label' | 'tab' | 'legend' | 'enabled'>>) {
  ensure()
  const cols: string[] = [], vals: unknown[] = []
  ;(['label', 'tab', 'legend', 'enabled'] as const).forEach(k => { if (f[k] !== undefined) { cols.push(`${k}=?`); vals.push(f[k]) } })
  if (!cols.length) return
  getDb().prepare(`UPDATE schema_tool_sources SET ${cols.join(',')} WHERE id=?`).run(...vals, id)
}

export function deleteSource(id: number) {
  ensure()
  getDb().prepare('DELETE FROM schema_tool_sources WHERE id=?').run(id)
}

export async function refreshSource(id: number): Promise<SourceRow> {
  const s = getSource(id)
  if (!s) throw new Error('Source not found')
  try {
    const raw = s.doc_type === 'sheet'
      ? await runReader(['sheet', '--id', s.doc_id, ...(s.tab ? ['--tab', s.tab] : [])])
      : await runReader(['doc', '--id', s.doc_id])
    const r = s.doc_type === 'sheet' ? renderSheet(raw) : renderDoc(raw)
    const prev = s.rows_json ? JSON.parse(s.rows_json) : null
    const changes = diffRows(prev, r.rows)
    getDb().prepare(`UPDATE schema_tool_sources SET title=?, tab=COALESCE(tab, ?), content=?, rows_json=?, changes=COALESCE(?, changes), fetched_at=datetime('now'), error=NULL WHERE id=?`)
      .run(raw.title || null, raw.tab || null, r.text, JSON.stringify(r.rows), changes ? JSON.stringify(changes) : null, id)
  } catch (e: any) {
    getDb().prepare(`UPDATE schema_tool_sources SET error=?, fetched_at=datetime('now') WHERE id=?`).run(e?.message || String(e), id)
  }
  return getSource(id)!
}

/** Sources summary for the assistant's system prompt. */
export function sourcesForPrompt(): string {
  const list = listSources().filter(s => s.enabled)
  if (!list.length) return ''
  return list.map(s => {
    const rows = s.rows_json ? Object.keys(JSON.parse(s.rows_json)).length : 0
    const ch = s.changes ? JSON.parse(s.changes) : null
    const chs = ch ? ` · last refresh: ${ch.added.length} added, ${ch.changed.length} changed, ${ch.removed.length} removed rows` : ''
    return `- Source #${s.id} "${s.label}" (${s.doc_type}${s.tab ? `, tab "${s.tab}"` : ''}; ${rows} rows; refreshed ${s.fetched_at || 'never'}${chs})${s.error ? ` — ERROR: ${s.error}` : ''}${s.legend ? `\n  ${s.legend.replace(/\n/g, '\n  ')}` : ''}`
  }).join('\n')
}

export function readSourceText(id: number, opts?: { query?: string; changesOnly?: boolean; limit?: number }): string {
  const s = getSource(id)
  if (!s) return 'Source not found'
  if (opts?.changesOnly) return s.changes || 'No changes recorded yet (changes are tracked from the second refresh on).'
  let lines = (s.content || '').split('\n')
  if (opts?.query) { const q = opts.query.toLowerCase(); lines = lines.filter(l => l.toLowerCase().includes(q)) }
  const text = lines.slice(0, opts?.limit || 800).join('\n')
  return `Source #${s.id} "${s.label}" — ${s.title || ''}${s.tab ? ` / ${s.tab}` : ''} (refreshed ${s.fetched_at})\nFormat: R<row>: <col>=<value> {colour tags} <link> (note: …); ~~strikethrough~~\n${text}`
}
