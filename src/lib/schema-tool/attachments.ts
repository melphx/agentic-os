/**
 * Schema Tool — chat attachments: uploaded files and Google links pasted into a message.
 *
 * Files are turned into text the assistant can read, keeping formatting that carries meaning
 * (the same markers as connected sources: {red: …} text colour, {hl:yellow: …} highlight,
 * ~~strikethrough~~, <links>, (note: …)). PDFs and images are also sent to Claude as-is so it
 * can see layout and colours.
 */
import { getDb } from '@/lib/db'
import { ensureSchemaToolTables } from './store'
import { colorName, readGoogleLink } from './sources'

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 400_000         // stored
export const INLINE_CHARS = 60_000     // sent with the message; the rest via read_attachment

export type AttachmentKind = 'gsheet' | 'gdoc' | 'text' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'image'

export interface AttachmentRow {
  id: number; conversation_id: string | null; kind: AttachmentKind; name: string; url: string | null; mime: string | null
  size: number; text: string | null; data: Buffer | null; meta: string | null; error: string | null
  created_by: string | null; created_at: string
}
export interface AttachmentSummary { id: number; kind: AttachmentKind; name: string; url: string | null; size: number; chars: number; error: string | null; note?: string }

let ensured = false
function ensure() {
  if (ensured) return
  ensureSchemaToolTables()
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS schema_tool_attachments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      url             TEXT,
      mime            TEXT,
      size            INTEGER NOT NULL DEFAULT 0,
      text            TEXT,
      data            BLOB,                 -- original bytes for PDFs / images (sent to Claude directly)
      meta            TEXT,
      error           TEXT,
      created_by      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_schema_tool_att_conv ON schema_tool_attachments(conversation_id);
  `)
  ensured = true
}

export const KIND_LABEL: Record<AttachmentKind, string> = {
  gsheet: 'Google Sheet', gdoc: 'Google Doc', text: 'Text file', csv: 'CSV', docx: 'Word document', xlsx: 'Excel workbook',
  pptx: 'PowerPoint', pdf: 'PDF', image: 'Image',
}

// ── extraction ─────────────────────────────────────────────────────────────
const TEXT_EXT = /\.(txt|md|markdown|json|jsonld|html?|xml|js|ts|css|ya?ml|log|php|svg)$/i
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i

const xmlDecode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&')
const hexRgb = (h?: string | null) => {
  if (!h) return null
  const x = h.replace(/^#/, '').slice(-6)
  if (!/^[0-9a-f]{6}$/i.test(x) || /^0{6}$|^auto$/i.test(x)) return null
  return [parseInt(x.slice(0, 2), 16) / 255, parseInt(x.slice(2, 4), 16) / 255, parseInt(x.slice(4, 6), 16) / 255]
}
const attr = (tag: string, name: string) => { const m = tag.match(new RegExp(`${name}="([^"]*)"`)); return m ? m[1] : null }
const clean = (s: string) => s.replace(/[ \t ]+/g, ' ').trim()

function loadZip(buf: Buffer): Promise<any> {
  const JSZip = require('jszip')
  return JSZip.loadAsync(buf)
}
async function zipText(zip: any, path: string): Promise<string | null> {
  const f = zip.file(path)
  return f ? f.async('string') : null
}
function relsMap(xml: string | null): Record<string, string> {
  const m: Record<string, string> = {}
  if (!xml) return m
  const re = /<Relationship\b[^>]*>/g
  let r: RegExpExecArray | null
  while ((r = re.exec(xml))) { const id = attr(r[0], 'Id'), t = attr(r[0], 'Target'); if (id && t) m[id] = xmlDecode(t) }
  return m
}

/** Word: paragraphs and table rows, with colour / highlight / strikethrough / links kept. */
async function docxText(buf: Buffer): Promise<string> {
  const zip = await loadZip(buf)
  const doc = (await zipText(zip, 'word/document.xml')) || ''
  const rels = relsMap(await zipText(zip, 'word/_rels/document.xml.rels'))
  const HL: Record<string, string> = { yellow: 'yellow', green: 'green', cyan: 'teal', magenta: 'pink', blue: 'blue', red: 'red', darkYellow: 'yellow', lightGray: 'gray', darkGray: 'gray' }

  const runText = (pXml: string): string => {
    // hyperlinks wrap runs: tag each run with its link
    const parts: string[] = []
    const re = /<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>|<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g
    let m: RegExpExecArray | null
    const one = (rXml: string, link: string | null) => {
      const t = (rXml.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g) || [])
        .map(x => x.startsWith('<w:tab') ? ' ' : x.startsWith('<w:br') ? ' ' : xmlDecode(x.replace(/<[^>]+>/g, ''))).join('')
      if (!t) return
      const rPr = (rXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [])[1] || ''
      const fg = colorName(hexRgb(attr((rPr.match(/<w:color\b[^>]*>/) || [''])[0], 'w:val')), 'fg')
      const hlv = attr((rPr.match(/<w:highlight\b[^>]*>/) || [''])[0], 'w:val')
      const shd = attr((rPr.match(/<w:shd\b[^>]*>/) || [''])[0], 'w:fill')
      const bg = hlv && hlv !== 'none' ? (HL[hlv] || hlv) : colorName(hexRgb(shd), 'bg')
      const strike = /<w:(d?strike)(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(rPr) && !/<w:d?strike\s+w:val="(?:0|false|off)"/.test(rPr)
      let s = t
      if (!s.trim()) { parts.push(s); return }
      if (strike) s = `~~${s}~~`
      const tags = [fg && !(fg === 'blue' && link) ? fg : null, bg ? 'hl:' + bg : null].filter(Boolean)
      if (tags.length) s = `{${tags.join(',')}: ${s}}`
      if (link) s += ` <${link}>`
      parts.push(s)
    }
    while ((m = re.exec(pXml))) {
      if (m[2] != null) {
        const rid = attr(m[1], 'r:id'); const anchor = attr(m[1], 'w:anchor')
        const link = rid ? rels[rid] || null : anchor ? '#' + anchor : null
        const inner = m[2].match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) || []
        // one link marker for the whole hyperlink text
        const before = parts.length
        inner.forEach(r => one(r, null))
        if (link && parts.length > before) parts[parts.length - 1] += ` <${link}>`
      } else one(m[0], null)
    }
    return parts.join('')
  }

  const lines: string[] = []
  const body = (doc.match(/<w:body>([\s\S]*)<\/w:body>/) || [])[1] || doc
  // walk top-level paragraphs and tables in order
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const x = m[0]
    if (x.startsWith('<w:tbl')) {
      for (const tr of x.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []) {
        const cells = (tr.match(/<w:tc>[\s\S]*?<\/w:tc>|<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g) || [])
          .map(tc => (tc.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || []).map(p => clean(runText(p))).filter(Boolean).join(' / '))
        if (cells.some(Boolean)) lines.push('| ' + cells.join(' | ') + ' |')
      }
    } else {
      const t = clean(runText(x))
      if (!t) continue
      const style = attr((x.match(/<w:pStyle\b[^>]*>/) || [''])[0], 'w:val') || ''
      const h = style.match(/^Heading(\d)$/i)
      const list = /<w:numPr>/.test(x) || /^List(Bullet|Number|Paragraph)/i.test(style)
      lines.push(h ? `${'#'.repeat(Number(h[1]))} ${t}` : list ? `- ${t}` : t)
    }
  }
  // comments (reviewers' notes often carry the instruction)
  const comments = await zipText(zip, 'word/comments.xml')
  if (comments) {
    const cs = (comments.match(/<w:comment\b[\s\S]*?<\/w:comment>/g) || []).map(c => `- ${attr(c, 'w:author') || 'Comment'}: ${clean(xmlDecode((c.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')))}`)
    if (cs.length) lines.push('', 'Comments in the document:', ...cs)
  }
  return lines.join('\n')
}

/** Resolve a relationship target relative to the part that owns it ("/xl/x.xml", "../x.xml", "x.xml"). */
function resolvePart(owner: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = owner.split('/').slice(0, -1)
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg) }
  return parts.join('/')
}

const colLetter = (i: number) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26) } return s }
const colIndex = (ref: string) => { const l = (ref.match(/^[A-Z]+/) || ['A'])[0]; let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1 }

/** Excel: every sheet as `R<row>: A=value {red,hl:yellow} <link> (note: …)` — same format as Google Sheets sources. */
async function xlsxText(buf: Buffer): Promise<string> {
  const zip = await loadZip(buf)
  const wb = (await zipText(zip, 'xl/workbook.xml')) || ''
  const wbRels = relsMap(await zipText(zip, 'xl/_rels/workbook.xml.rels'))
  const ss = await zipText(zip, 'xl/sharedStrings.xml')
  const strings = ss ? (ss.match(/<si>[\s\S]*?<\/si>/g) || []).map(si => xmlDecode((si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))) : []
  // styles: cellXfs → font (colour, strike) + fill
  const st = (await zipText(zip, 'xl/styles.xml')) || ''
  const fonts = ((st.match(/<fonts\b[\s\S]*?<\/fonts>/) || [''])[0].match(/<font\b[\s\S]*?<\/font>|<font\/>/g) || []).map(f => ({
    fg: colorName(hexRgb(attr((f.match(/<color\b[^>]*>/) || [''])[0], 'rgb')), 'fg'), strike: /<strike\b(?![^>]*val="0")/.test(f),
  }))
  const fills = ((st.match(/<fills\b[\s\S]*?<\/fills>/) || [''])[0].match(/<fill\b[\s\S]*?<\/fill>|<fill\/>/g) || []).map(f =>
    /patternType="solid"/.test(f) ? colorName(hexRgb(attr((f.match(/<fgColor\b[^>]*>/) || [''])[0], 'rgb')), 'bg') : null)
  const xfs = ((st.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/) || [''])[0].match(/<xf\b[^>]*>/g) || []).map(x => ({ font: Number(attr(x, 'fontId') || 0), fill: Number(attr(x, 'fillId') || 0) }))

  const out: string[] = []
  const sheets = wb.match(/<sheet\b[^>]*>/g) || []
  for (const sh of sheets.slice(0, 20)) {
    const name = xmlDecode(attr(sh, 'name') || 'Sheet')
    const target = wbRels[attr(sh, 'r:id') || '']
    if (!target) continue
    const path = resolvePart('xl/workbook.xml', target)
    const xml = await zipText(zip, path)
    if (!xml) continue
    const sRels = relsMap(await zipText(zip, path.replace(/([^/]+)$/, '_rels/$1.rels')))
    const links: Record<string, string> = {}
    for (const h of xml.match(/<hyperlink\b[^>]*>/g) || []) { const ref = attr(h, 'ref'), rid = attr(h, 'r:id'); if (ref && rid && sRels[rid]) links[ref.split(':')[0]] = sRels[rid] }
    const notes: Record<string, string> = {}
    const commentsPath = Object.values(sRels).find(t => /comments?\d*\.xml$/i.test(t))
    if (commentsPath) {
      const cx = await zipText(zip, resolvePart(path, commentsPath))
      for (const c of (cx || '').match(/<comment\b[\s\S]*?<\/comment>/g) || []) { const ref = attr(c, 'ref'); if (ref) notes[ref] = clean(xmlDecode((c.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''))) }
    }
    out.push(`## Sheet: ${name}`)
    let rows = 0
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      if (rows >= 3000) { out.push('…(more rows not shown)'); break }
      const r = attr(row, 'r')
      const cells: string[] = []
      for (const c of row.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) || []) {
        const ref = attr(c, 'r') || ''
        const t = attr(c, 't')
        const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1]
        let val = t === 's' && v != null ? strings[Number(v)] : t === 'inlineStr' ? xmlDecode((c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '') : v != null ? xmlDecode(v) : ''
        val = clean(val || '')
        const note = notes[ref]
        if (!val && !note) continue
        const xf = xfs[Number(attr(c, 's') || 0)] || { font: 0, fill: 0 }
        const font = fonts[xf.font] || { fg: null, strike: false }
        const bg = fills[xf.fill] || null
        let cell = `${colLetter(colIndex(ref))}=${font.strike && val ? `~~${val}~~` : val}`
        const tags = [font.fg && !(font.fg === 'blue' && links[ref]) ? font.fg : null, bg ? 'hl:' + bg : null].filter(Boolean)
        if (tags.length) cell += ` {${tags.join(',')}}`
        if (links[ref] && links[ref] !== val) cell += ` <${links[ref]}>`
        if (note) cell += ` (note: ${note})`
        cells.push(cell)
      }
      if (cells.length) { out.push(`R${r}: ${cells.join(' | ')}`); rows++ }
    }
  }
  return out.join('\n')
}

async function pptxText(buf: Buffer): Promise<string> {
  const zip = await loadZip(buf)
  const names = Object.keys(zip.files).filter((n: string) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a: string, b: string) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()))
  const out: string[] = []
  for (const n of names) {
    const x = (await zipText(zip, n)) || ''
    const paras = (x.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map(p => clean(xmlDecode((p.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')))).filter(Boolean)
    out.push(`## Slide ${n.match(/\d+/g)!.pop()}`, ...paras)
  }
  return out.join('\n')
}

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  try {
    const pdfParse = require('pdf-parse')
    const d = await pdfParse(buf)
    return { text: String(d.text || '').replace(/\n{3,}/g, '\n\n').trim(), pages: d.numpages || 0 }
  } catch { return { text: '', pages: 0 } }
}

/** Turn bytes into an attachment (kind, text, original data for PDFs/images). */
export async function extract(name: string, mime: string, buf: Buffer): Promise<{ kind: AttachmentKind; text: string; data: Buffer | null; meta: Record<string, unknown> }> {
  const lower = name.toLowerCase()
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
    const p = await pdfText(buf)
    return { kind: 'pdf', text: p.text, data: buf, meta: { pages: p.pages } }
  }
  if (IMAGE_MIME.test(mime) || /\.(png|jpe?g|gif|webp)$/.test(lower)) {
    if (buf.length > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB.')
    return { kind: 'image', text: '', data: buf, meta: {} }
  }
  if (lower.endsWith('.docx')) return { kind: 'docx', text: await docxText(buf), data: null, meta: {} }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return { kind: 'xlsx', text: await xlsxText(buf), data: null, meta: {} }
  if (lower.endsWith('.pptx')) return { kind: 'pptx', text: await pptxText(buf), data: null, meta: {} }
  if (/\.(csv|tsv)$/.test(lower) || /csv/.test(mime)) return { kind: 'csv', text: buf.toString('utf8'), data: null, meta: {} }
  if (TEXT_EXT.test(lower) || /^text\//.test(mime) || /json|xml/.test(mime)) return { kind: 'text', text: buf.toString('utf8'), data: null, meta: {} }
  if (/\.(doc|xls|ppt)$/.test(lower)) throw new Error('Old Office formats (.doc/.xls/.ppt) aren’t supported — save as .docx/.xlsx/.pptx or PDF.')
  throw new Error(`Can’t read ${name}. Supported: PDF, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), CSV, text/JSON/HTML, and images.`)
}

const normMime = (kind: AttachmentKind, mime: string, name: string) => {
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'image') { const l = name.toLowerCase(); return /^image\//.test(mime) ? mime.replace('image/jpg', 'image/jpeg') : l.endsWith('.png') ? 'image/png' : l.endsWith('.gif') ? 'image/gif' : l.endsWith('.webp') ? 'image/webp' : 'image/jpeg' }
  return mime || null
}

// ── storage ────────────────────────────────────────────────────────────────
function insert(a: { conversation_id: string | null; kind: AttachmentKind; name: string; url?: string | null; mime?: string | null; size: number; text?: string | null; data?: Buffer | null; meta?: unknown; error?: string | null; by?: string | null }): number {
  ensure()
  return Number(getDb().prepare(`INSERT INTO schema_tool_attachments (conversation_id,kind,name,url,mime,size,text,data,meta,error,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(a.conversation_id, a.kind, a.name.slice(0, 200), a.url || null, a.mime || null, a.size, a.text ? a.text.slice(0, MAX_TEXT_CHARS) : null, a.data || null, a.meta ? JSON.stringify(a.meta) : null, a.error || null, a.by || null).lastInsertRowid)
}

export function getAttachment(id: number): AttachmentRow | null {
  ensure()
  return (getDb().prepare('SELECT * FROM schema_tool_attachments WHERE id=?').get(id) as AttachmentRow) || null
}

export function summarize(a: AttachmentRow): AttachmentSummary {
  const meta = a.meta ? JSON.parse(a.meta) : {}
  return { id: a.id, kind: a.kind, name: a.name, url: a.url, size: a.size, chars: (a.text || '').length, error: a.error, note: meta.tab ? `tab “${meta.tab}”${meta.tabs?.length > 1 ? ` of ${meta.tabs.length}` : ''}` : meta.pages ? `${meta.pages} page${meta.pages === 1 ? '' : 's'}` : undefined }
}

export function summaries(ids: number[]): AttachmentSummary[] {
  return ids.map(getAttachment).filter(Boolean).map(a => summarize(a!))
}

/** Uploaded file → stored attachment (not tied to a conversation until the message is sent). */
export async function saveUpload(name: string, mime: string, buf: Buffer, by: string | null, conversationId: string | null = null): Promise<AttachmentSummary> {
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('Files must be under 20 MB.')
  const x = await extract(name, mime, buf)
  if (!x.text.trim() && !x.data) throw new Error(`${name} has no readable text.`)
  const id = insert({ conversation_id: conversationId, kind: x.kind, name, mime: normMime(x.kind, mime, name), size: buf.length, text: x.text, data: x.data, meta: x.meta, by })
  return summarize(getAttachment(id)!)
}

/** Google link → stored attachment. Failures are stored too (with the error) so the assistant can explain. */
export async function attachLink(url: string, conversationId: string | null, by: string | null, tab?: string): Promise<AttachmentSummary> {
  try {
    const r = await readGoogleLink(url, tab)
    if (r.kind === 'binary') {
      const x = await extract(r.title, r.mime, r.data)
      return summarize(getAttachment(insert({ conversation_id: conversationId, kind: x.kind, name: r.title, url, mime: normMime(x.kind, r.mime, r.title), size: r.data.length, text: x.text, data: x.data, meta: x.meta, by }))!)
    }
    const kind: AttachmentKind = r.kind === 'sheet' ? 'gsheet' : 'gdoc'
    const meta = r.kind === 'sheet' ? { tab: r.tab, tabs: r.tabs } : {}
    return summarize(getAttachment(insert({ conversation_id: conversationId, kind, name: r.title, url, size: r.text.length, text: r.text, meta, by }))!)
  } catch (e: any) {
    const kind: AttachmentKind = /spreadsheets/.test(url) ? 'gsheet' : 'gdoc'
    return summarize(getAttachment(insert({ conversation_id: conversationId, kind, name: 'Google link', url, size: 0, error: e?.message || String(e), by }))!)
  }
}

export function claimAttachments(ids: number[], conversationId: string) {
  ensure()
  const st = getDb().prepare('UPDATE schema_tool_attachments SET conversation_id=? WHERE id=? AND (conversation_id IS NULL OR conversation_id=?)')
  for (const id of ids) st.run(conversationId, id, conversationId)
}

export function conversationAttachments(conversationId: string): AttachmentSummary[] {
  ensure()
  return (getDb().prepare('SELECT * FROM schema_tool_attachments WHERE conversation_id=? ORDER BY id').all(conversationId) as AttachmentRow[]).map(summarize)
}

// ── what the assistant sees ────────────────────────────────────────────────
export const FORMAT_LEGEND = 'Formatting is kept as markers: {red: text} = coloured text (often "needs changing"), {hl:yellow: text} = highlight, ~~text~~ = strikethrough (removed / no longer valid), <url> = link, (note: …) = a cell note or comment. Sheets are "R<row>: <column>=<value>".'

function header(a: AttachmentRow) {
  const s = summarize(a)
  return `id="${a.id}" name="${a.name.replace(/"/g, "'")}" type="${KIND_LABEL[a.kind]}"${a.url ? ` url="${a.url}"` : ''}${s.note ? ` note="${s.note}"` : ''}`
}

/** Content blocks for the message that carries these attachments (Anthropic format). */
export function attachmentBlocks(ids: number[], provider: 'anthropic' | 'openai'): any[] {
  const blocks: any[] = []
  for (const id of ids) {
    const a = getAttachment(id)
    if (!a) continue
    if (a.error) { blocks.push({ type: 'text', text: `<attachment ${header(a)} error="could not open">${a.error}</attachment>` }); continue }
    if (provider === 'anthropic' && a.kind === 'image' && a.data) {
      blocks.push({ type: 'text', text: `<attachment ${header(a)}>(image below)</attachment>` })
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime || 'image/png', data: Buffer.from(a.data).toString('base64') } })
      continue
    }
    if (a.kind === 'image') { blocks.push({ type: 'text', text: `<attachment ${header(a)}>(image — can't be viewed with the current AI provider)</attachment>` }); continue }
    const meta = a.meta ? JSON.parse(a.meta) : {}
    if (provider === 'anthropic' && a.kind === 'pdf' && a.data && (meta.pages || 0) <= 100 && a.data.length <= 20 * 1024 * 1024) {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(a.data).toString('base64') }, title: a.name.slice(0, 200) })
      blocks.push({ type: 'text', text: `<attachment ${header(a)}>(PDF above${meta.pages ? `, ${meta.pages} pages` : ''})</attachment>` })
      continue
    }
    const text = a.text || ''
    const cut = text.length > INLINE_CHARS
    blocks.push({ type: 'text', text: `<attachment ${header(a)}${cut ? ` showing="first ${INLINE_CHARS} of ${text.length} characters — use read_attachment with query or offset for the rest"` : ''}>\n${text.slice(0, INLINE_CHARS)}\n</attachment>` })
  }
  return blocks
}

/** Short reference used for older turns (keeps history small; the assistant re-reads with read_attachment). */
export function attachmentRefLine(list: { id: number; name: string; kind: AttachmentKind; error?: string | null }[]): string {
  if (!list.length) return ''
  return `\n[Attached: ${list.map(a => `#${a.id} ${a.name} (${KIND_LABEL[a.kind] || a.kind}${a.error ? ', could not open' : ''})`).join('; ')} — read_attachment to see it again]`
}

export function readAttachmentText(id: number, opts: { query?: string; offset?: number }): string {
  const a = getAttachment(id)
  if (!a) return 'Attachment not found.'
  if (a.error) return `Could not open this attachment: ${a.error}`
  const text = a.text || ''
  if (!text) return a.kind === 'image' ? 'This is an image; it was shown with the message it came with.' : 'No text could be read from this file.'
  if (opts.query) {
    const q = opts.query.toLowerCase()
    const lines = text.split('\n')
    const hits: string[] = []
    lines.forEach((l, i) => { if (l.toLowerCase().includes(q)) hits.push(lines.slice(Math.max(0, i - 1), i + 2).join('\n')) })
    return `<attachment ${header(a)} query="${opts.query}" matches="${hits.length}">\n${hits.slice(0, 120).join('\n---\n').slice(0, 40000)}\n</attachment>`
  }
  const off = Math.max(0, Math.floor(opts.offset || 0))
  const chunk = text.slice(off, off + 40000)
  return `<attachment ${header(a)} chars="${off}-${off + chunk.length} of ${text.length}">\n${chunk}\n</attachment>`
}
