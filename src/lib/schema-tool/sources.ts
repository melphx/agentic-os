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

export const DEFAULT_LEGEND = `How to read this sheet (SEO sameAs / mentions tracker):
- Column A says where the URL in column B belongs. Read it carefully — it decides WHERE in the schema the link goes:
  • "SAMEAS - All Pages" → sameAs of every full Organization definition (homepage #407 plus any snippet that still defines the whole company; city pages only reference {"@id": "https://phxhomeremodeling.com/#organization"} and inherit it — never add a company block back to them).
  • "SAMEAS - Homepage Only" → sameAs of the Organization on the homepage (#407) only.
  • "MENTIONS - Homepage Only" → third-party pages about PHR, on the homepage Organization (as subjectOf, see below).
  • "SUBJECTOF - Homepage + Author Page" → subjectOf on the homepage Organization and on Jeremy's Person (author page #556). Not in sameAs.
  • "MENTIONS - <Service> - <City>" → on that service's page for that city, e.g. "MENTIONS - Kitchen - Mesa" → /services/kitchen-remodel/mesa-az/. Services: Bathroom → bathroom-remodel, Kitchen → kitchen-remodel, Shower → shower-remodeling, GC → general-contractor, Home → home-remodeling.
  • "MENTIONS - <Service> - All Cities" → that service's page in EVERY city (all active -az pages for that service).
  • "MENTIONS - All <City> Service Pages" → every active -az page for that city.
  • "NO" → must not be in any schema. Remove it if it is there.
- Write MENTIONS rows as subjectOf entries ({"@type": "Article", "url": "…", "name": "…"}) on the Organization (homepage) or the page's Service (city pages). schema.org only allows "mentions" on articles/web pages, so "mentions" on an Organization or Service is flagged by validators.
- Column C sometimes holds the OLD link ("old url", "OLD LINK", "old one", "Is the old one"): replace the old link with the column B link wherever the old one appears.
- Column E (NOTES) is the team's history ("Added 09-2026", "Replaced 09-2026", "Needs to be changed on schema"). Columns F–H are formula helpers — ignore them.
- When you mark a row, your note REPLACES the NOTES cell (e.g. "Needs to be added to schema Oct 2026" becomes just "Added {date}"), so keep it short: "Added {date}", "Replaced {date}", "Removed {date}", or for Not Added a short reason.
- Column I (Schema status) is the dropdown you keep up to date: "Added" when the URL is in every place column A asks for, "Not Added" when it isn't (NO rows, or rows you couldn't add — say why in the note).
- {red} text marks something that still needs doing. Blue text is just link styling. Rows under a heading (Socials, Listing Sites, Wikis, Press, Listicles, Podcasts…) are grouping only.`

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
  try { getDb().exec('ALTER TABLE schema_tool_sources ADD COLUMN writeback TEXT') } catch {}
  ensured = true
}

export interface SourceRow {
  id: number; label: string; url: string; doc_id: string; doc_type: 'sheet' | 'doc'; tab: string | null; legend: string | null
  enabled: number; title: string | null; content: string | null; rows_json: string | null; changes: string | null
  fetched_at: string | null; error: string | null; created_by: string | null; created_at: string
  writeback: string | null   // JSON { status_col: 'I', note_col: 'E', values: ['Added','Not Added'], first_row: 3 }
}

export interface Writeback { status_col: string; note_col: string; values: string[]; first_row: number }
export const writebackOf = (s: SourceRow): Writeback | null => { try { return s.writeback ? JSON.parse(s.writeback) : null } catch { return null } }

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

// ── write-back (status dropdown + notes) ───────────────────────────────────
const colOk = (c: string) => /^[A-Z]{1,2}$/.test(c)

/** Add the status dropdown column to the sheet and remember where to write. Needs Editor access. */
export async function setupWriteback(id: number, cfg: { status_col?: string; note_col?: string; values?: string[] }): Promise<SourceRow> {
  const s = getSource(id)
  if (!s) throw new Error('Source not found')
  if (s.doc_type !== 'sheet' || !s.tab) throw new Error('Write-back works on a sheet tab.')
  const status_col = String(cfg.status_col || 'I').toUpperCase(), note_col = String(cfg.note_col || 'E').toUpperCase()
  if (!colOk(status_col) || !colOk(note_col)) throw new Error('Columns must be letters like I or E.')
  const values = (cfg.values && cfg.values.length ? cfg.values : ['Added', 'Not Added']).map(v => String(v).trim()).filter(Boolean)
  await runReader(['setup', '--id', s.doc_id, '--tab', s.tab, '--status-col', status_col, '--values', values.join(','), '--first-row', '3'])
  getDb().prepare('UPDATE schema_tool_sources SET writeback=? WHERE id=?').run(JSON.stringify({ status_col, note_col, values, first_row: 3 }), id)
  return refreshSource(id)
}

export interface SheetRowUpdate { row: number; status?: string; note?: string; url?: string }

/** The plain text of one cell from the last read (formatting markers removed). */
export function cellText(s: SourceRow, row: number, col: string): string {
  const rows: Record<string, string> = s.rows_json ? JSON.parse(s.rows_json) : {}
  const r = rows['R' + row]
  if (!r) return ''
  const c = r.split(' | ').find(x => x.startsWith(col + '='))
  if (!c) return ''
  return c.slice(col.length + 1).replace(/\s\(note: .*\)$/, '').replace(/\s<[^>]+>$/, '').replace(/\s\{[a-z:,]+\}$/, '').replace(/~~/g, '').trim()
}

/** Add what the person needs to review each row: its type (A), URL (B), and the current status / note. */
export function describeRows(s: SourceRow, rows: SheetRowUpdate[]) {
  const wb = writebackOf(s)
  return rows.map(u => ({
    ...u,
    type: cellText(s, u.row, 'A') || undefined,
    url: u.url || cellText(s, u.row, 'B') || undefined,
    prev_status: wb ? cellText(s, u.row, wb.status_col) || '' : '',
    prev_note: wb ? cellText(s, u.row, wb.note_col) || '' : '',
  }))
}

/** Turn row-level updates into cell writes. The note replaces the notes cell and is written in black. */
export function planSheetWrites(s: SourceRow, rows: SheetRowUpdate[]): SheetCell[] {
  const wb = writebackOf(s)
  if (!wb) throw new Error(`Source #${s.id} has no write-back set up (Sources tab → Set up status column).`)
  const out: SheetCell[] = []
  for (const u of rows) {
    const row = Math.floor(Number(u.row))
    if (!(row >= wb.first_row)) throw new Error(`Row ${u.row} is not a data row`)
    if (u.status != null) {
      if (wb.values.indexOf(u.status) < 0) throw new Error(`Status must be one of: ${wb.values.join(', ')}`)
      out.push({ cell: `${wb.status_col}${row}`, value: u.status })
    }
    // the note replaces what was there (e.g. a red "Needs to be added to schema" becomes a black "Added 10-2026")
    if (u.note && String(u.note).trim()) out.push({ cell: `${wb.note_col}${row}`, value: String(u.note).trim().slice(0, 300), black: true })
  }
  return out
}

export interface SheetCell { cell: string; value: string; append?: boolean; black?: boolean }

/** Write cells and return what was there before (for undo). */
export async function writeCells(id: number, cells: SheetCell[]): Promise<{ cell: string; value: string }[]> {
  const s = getSource(id)
  if (!s || !s.tab) throw new Error('Source not found')
  if (!cells.length) return []
  const r = await runReader(['write', '--id', s.doc_id, '--tab', s.tab, '--updates', JSON.stringify(cells)])
  return r.previous || []
}

/** Sources summary for the assistant's system prompt. */
export function sourcesForPrompt(): string {
  const list = listSources().filter(s => s.enabled)
  if (!list.length) return ''
  return list.map(s => {
    const rows = s.rows_json ? Object.keys(JSON.parse(s.rows_json)).length : 0
    const ch = s.changes ? JSON.parse(s.changes) : null
    const chs = ch ? ` · last refresh: ${ch.added.length} added, ${ch.changed.length} changed, ${ch.removed.length} removed rows` : ''
    const wb = writebackOf(s)
    const wbs = wb ? ` · write-back ON: status column ${wb.status_col} (${wb.values.join(' / ')}), notes column ${wb.note_col}` : ''
    return `- Source #${s.id} "${s.label}" (${s.doc_type}${s.tab ? `, tab "${s.tab}"` : ''}; ${rows} rows; refreshed ${s.fetched_at || 'never'}${chs}${wbs})${s.error ? ` — ERROR: ${s.error}` : ''}${s.legend ? `\n  ${s.legend.replace(/\n/g, '\n  ')}` : ''}`
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
