/**
 * Schema Tool — SQLite storage (own tables in the shared AgenticOS database).
 * Every change is a "changeset" of per-snippet items with the full before/after text,
 * so any applied change can be reverted later.
 */
import zlib from 'zlib'
import { getDb } from '@/lib/db'

let ensured = false
export function ensureSchemaToolTables() {
  if (ensured) return
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS schema_tool_changesets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      site          TEXT NOT NULL,
      title         TEXT NOT NULL,
      summary       TEXT,
      kind          TEXT NOT NULL DEFAULT 'edit',      -- edit | replace | config | revert | manual
      status        TEXT NOT NULL DEFAULT 'proposed',  -- proposed | applying | applied | partial | failed | discarded | reverting | reverted
      source        TEXT NOT NULL DEFAULT 'chat',      -- chat | manual
      conversation_id TEXT,
      revert_of     INTEGER,
      meta          TEXT,
      created_by    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      applied_at    TEXT,
      reverted_at   TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_tool_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      changeset_id  INTEGER NOT NULL,
      snippet_id    INTEGER NOT NULL,
      snippet_name  TEXT,
      item_type     TEXT NOT NULL DEFAULT 'code',     -- code | config
      before_blob   BLOB,
      after_blob    BLOB,
      mentions      INTEGER DEFAULT 0,
      preview       TEXT,                              -- JSON: short before/after snippets for the UI
      selected      INTEGER NOT NULL DEFAULT 1,
      status        TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | skipped | failed | conflict | reverted
      error         TEXT,
      applied_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schema_tool_items_cs ON schema_tool_items(changeset_id);
    CREATE TABLE IF NOT EXISTS schema_tool_messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      changeset_ids   TEXT,
      created_by      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_schema_tool_msgs ON schema_tool_messages(conversation_id);
    CREATE TABLE IF NOT EXISTS schema_tool_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_tool_jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'running',   -- running | done | error
      steps           TEXT,
      error           TEXT,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_schema_tool_jobs ON schema_tool_jobs(conversation_id);
  `)
  try { getDb().exec('ALTER TABLE schema_tool_messages ADD COLUMN steps TEXT') } catch {}
  try { getDb().exec('ALTER TABLE schema_tool_messages ADD COLUMN usage TEXT') } catch {}
  try { getDb().exec('ALTER TABLE schema_tool_messages ADD COLUMN attachments TEXT') } catch {}
  ensured = true
}

const pack = (s: string | null | undefined) => (s == null ? null : zlib.deflateSync(Buffer.from(s, 'utf8')))
const unpack = (b: Buffer | null | undefined) => (b == null ? null : zlib.inflateSync(b).toString('utf8'))

export interface ChangesetRow {
  id: number; site: string; title: string; summary: string | null; kind: string; status: string; source: string
  conversation_id: string | null; revert_of: number | null; meta: string | null; created_by: string | null
  created_at: string; applied_at: string | null; reverted_at: string | null
}
export interface ItemRow {
  id: number; changeset_id: number; snippet_id: number; snippet_name: string | null; item_type: 'code' | 'config'
  mentions: number; preview: string | null; selected: number; status: string; error: string | null; applied_at: string | null
}
export interface ItemFull extends ItemRow { before: string | null; after: string | null }

export interface NewItem {
  snippet_id: number; snippet_name: string; item_type: 'code' | 'config'
  before: string; after: string; mentions: number; preview?: unknown
}

export function createChangeset(cs: {
  site: string; title: string; summary?: string; kind: string; source: string
  conversation_id?: string | null; revert_of?: number | null; meta?: unknown; created_by?: string | null
}, items: NewItem[]): number {
  ensureSchemaToolTables()
  const db = getDb()
  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO schema_tool_changesets (site,title,summary,kind,source,conversation_id,revert_of,meta,created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(cs.site, cs.title, cs.summary || null, cs.kind, cs.source, cs.conversation_id || null,
      cs.revert_of || null, cs.meta ? JSON.stringify(cs.meta) : null, cs.created_by || null)
    const id = Number(r.lastInsertRowid)
    const ins = db.prepare(`INSERT INTO schema_tool_items (changeset_id,snippet_id,snippet_name,item_type,before_blob,after_blob,mentions,preview)
      VALUES (?,?,?,?,?,?,?,?)`)
    for (const it of items) {
      ins.run(id, it.snippet_id, it.snippet_name, it.item_type, pack(it.before), pack(it.after), it.mentions,
        it.preview ? JSON.stringify(it.preview) : null)
    }
    return id
  })
  return tx()
}

export function getChangeset(id: number): ChangesetRow | null {
  ensureSchemaToolTables()
  return (getDb().prepare('SELECT * FROM schema_tool_changesets WHERE id=?').get(id) as ChangesetRow) || null
}

export function listChangesets(limit = 50, conversationId?: string): (ChangesetRow & { item_count: number; snippet_count: number; mention_count: number; applied_count: number })[] {
  ensureSchemaToolTables()
  const where = conversationId ? 'WHERE c.conversation_id = ?' : ''
  const args: unknown[] = conversationId ? [conversationId, limit] : [limit]
  return getDb().prepare(`
    SELECT c.*, COUNT(i.id) AS item_count, COUNT(DISTINCT i.snippet_id) AS snippet_count,
           COALESCE(SUM(i.mentions),0) AS mention_count,
           SUM(CASE WHEN i.status='applied' THEN 1 ELSE 0 END) AS applied_count
    FROM schema_tool_changesets c LEFT JOIN schema_tool_items i ON i.changeset_id = c.id
    ${where} GROUP BY c.id ORDER BY c.id DESC LIMIT ?`).all(...args) as any
}

export function getItems(changesetId: number, withText = false): (ItemRow | ItemFull)[] {
  ensureSchemaToolTables()
  const cols = withText ? '*' : 'id,changeset_id,snippet_id,snippet_name,item_type,mentions,preview,selected,status,error,applied_at'
  const rows = getDb().prepare(`SELECT ${cols} FROM schema_tool_items WHERE changeset_id=? ORDER BY snippet_id`).all(changesetId) as any[]
  if (!withText) return rows
  return rows.map(r => {
    const { before_blob, after_blob, ...rest } = r
    return { ...rest, before: unpack(before_blob), after: unpack(after_blob) }
  })
}

export function setChangesetStatus(id: number, status: string, extra?: { applied?: boolean; reverted?: boolean }) {
  ensureSchemaToolTables()
  const sets = ['status=?']
  if (extra?.applied) sets.push("applied_at=datetime('now')")
  if (extra?.reverted) sets.push("reverted_at=datetime('now')")
  getDb().prepare(`UPDATE schema_tool_changesets SET ${sets.join(',')} WHERE id=?`).run(status, id)
}

export function setItemStatus(id: number, status: string, error?: string | null) {
  getDb().prepare(`UPDATE schema_tool_items SET status=?, error=?, applied_at=CASE WHEN ?='applied' THEN datetime('now') ELSE applied_at END WHERE id=?`)
    .run(status, error || null, status, id)
}

/** After applying on top of newer changes: remember what was really there before / written, so Undo restores exactly that. */
export function updateItemContent(id: number, before: string, after: string, mentions?: number) {
  getDb().prepare('UPDATE schema_tool_items SET before_blob=?, after_blob=?, mentions=COALESCE(?, mentions) WHERE id=?').run(pack(before), pack(after), mentions ?? null, id)
}

export function setItemsSelected(changesetId: number, selectedIds: number[] | null) {
  const db = getDb()
  if (!selectedIds) { db.prepare('UPDATE schema_tool_items SET selected=1 WHERE changeset_id=?').run(changesetId); return }
  db.prepare('UPDATE schema_tool_items SET selected=0 WHERE changeset_id=?').run(changesetId)
  const st = db.prepare('UPDATE schema_tool_items SET selected=1 WHERE changeset_id=? AND id=?')
  for (const id of selectedIds) st.run(changesetId, id)
}

// ── chat messages ──────────────────────────────────────────────────────────
export function addMessage(conversationId: string, role: string, content: string, changesetIds?: number[], by?: string | null, steps?: string[], usage?: unknown, attachments?: unknown[]): number {
  ensureSchemaToolTables()
  return Number(getDb().prepare('INSERT INTO schema_tool_messages (conversation_id, role, content, changeset_ids, created_by, steps, usage, attachments) VALUES (?,?,?,?,?,?,?,?)')
    .run(conversationId, role, content, changesetIds && changesetIds.length ? JSON.stringify(changesetIds) : null, by || null, steps && steps.length ? JSON.stringify(steps) : null, usage ? JSON.stringify(usage) : null, attachments && attachments.length ? JSON.stringify(attachments) : null).lastInsertRowid)
}

/** Attachments shown on a message: [{ id, kind, name, url, error? }] */
export function setMessageAttachments(messageId: number, attachments: unknown[]) {
  getDb().prepare('UPDATE schema_tool_messages SET attachments=? WHERE id=?').run(attachments.length ? JSON.stringify(attachments) : null, messageId)
}

/** AI usage + estimated cost over the last N days (from assistant messages). */
export function usageSummary(days = 30): { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number } {
  ensureSchemaToolTables()
  const rows = getDb().prepare(`SELECT usage FROM schema_tool_messages WHERE usage IS NOT NULL AND created_at >= datetime('now', ?)`).all(`-${days} days`) as { usage: string }[]
  const s = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
  for (const r of rows) {
    try { const u = JSON.parse(r.usage); s.requests++; s.input += u.input || 0; s.output += u.output || 0; s.cacheRead += u.cacheRead || 0; s.cacheWrite += u.cacheWrite || 0; s.costUsd += u.costUsd || 0 } catch {}
  }
  return s
}

// ── background assistant jobs (survive tab switches; UI polls) ─────────────
export interface JobRow { id: number; conversation_id: string; status: string; steps: string[]; error: string | null; started_at: string; finished_at: string | null }

export function createJob(conversationId: string): number {
  ensureSchemaToolTables()
  return Number(getDb().prepare('INSERT INTO schema_tool_jobs (conversation_id) VALUES (?)').run(conversationId).lastInsertRowid)
}
export function updateJobSteps(id: number, steps: string[]) {
  getDb().prepare('UPDATE schema_tool_jobs SET steps=? WHERE id=?').run(JSON.stringify(steps), id)
}
export function finishJob(id: number, status: 'done' | 'error', error?: string) {
  getDb().prepare("UPDATE schema_tool_jobs SET status=?, error=?, finished_at=datetime('now') WHERE id=?").run(status, error || null, id)
}
export function latestJob(conversationId: string): JobRow | null {
  ensureSchemaToolTables()
  const r = getDb().prepare('SELECT * FROM schema_tool_jobs WHERE conversation_id=? ORDER BY id DESC LIMIT 1').get(conversationId) as any
  if (!r) return null
  // a job "running" for over 20 minutes was lost (e.g. server restarted)
  if (r.status === 'running' && Date.now() - new Date(r.started_at.replace(' ', 'T') + 'Z').getTime() > 20 * 60_000) {
    finishJob(r.id, 'error', 'Interrupted (the server restarted or the request took too long).')
    r.status = 'error'; r.error = 'Interrupted (the server restarted or the request took too long).'
  }
  return { ...r, steps: r.steps ? JSON.parse(r.steps) : [] }
}

export function getMessages(conversationId: string, limit = 60): { role: string; content: string; changeset_ids: number[]; steps: string[]; usage: any; attachments: any[]; created_at: string }[] {
  ensureSchemaToolTables()
  const rows = getDb().prepare('SELECT role, content, changeset_ids, steps, usage, attachments, created_at FROM schema_tool_messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?')
    .all(conversationId, limit) as any[]
  return rows.reverse().map(r => ({ ...r, changeset_ids: r.changeset_ids ? JSON.parse(r.changeset_ids) : [], steps: r.steps ? JSON.parse(r.steps) : [], usage: r.usage ? JSON.parse(r.usage) : null, attachments: r.attachments ? JSON.parse(r.attachments) : [] }))
}

export function listConversations(limit = 20): { conversation_id: string; title: string; updated_at: string }[] {
  ensureSchemaToolTables()
  return getDb().prepare(`
    SELECT conversation_id,
      (SELECT content FROM schema_tool_messages m2 WHERE m2.conversation_id = m.conversation_id AND role='user' ORDER BY id LIMIT 1) AS title,
      MAX(created_at) AS updated_at
    FROM schema_tool_messages m GROUP BY conversation_id ORDER BY MAX(id) DESC LIMIT ?`).all(limit) as any
}

// ── settings ───────────────────────────────────────────────────────────────
export const DEFAULT_RULES = `- Work only on the configured site (staging). Never claim a change reached the live site.
- Change only what was asked. Leave every other part of a snippet exactly as it is.
- FAQ schema answers must match the visible FAQ on the page word for word.
- Jeremy Maher has one Person ID: https://phxhomeremodeling.com/author-jeremy-maher/#person. Never create a second Person for him.
- Jeremy's title is always "Co-Founder & COO" (never owner, founder, co-owner or general contractor). Ben Chesley: "Co-Founder & CFO". Mark Chesley: "Co-Founder & Chief Construction Officer".
- Only approved URLs go in sameAs. Press, podcasts and videos go in subjectOf. Book links go in the Book (https://phxhomeremodeling.com/remodel-book/#book).
- Never include Credit Repair Doctor / mycreditdoc.com, Patch, EnrollBusiness, ZoomInfo, RocketReach, Grokipedia or tier-3/parasite pages.
- PHR Organization ID: https://phxhomeremodeling.com/#organization. Wikidata: company Q138340466, Jeremy Q141665193, book Q141727039.
- Project minimum is $20,000.`

/** Background the assistant gets on every request (editable in Settings). Facts here are as of Oct 2026. */
export const DEFAULT_CONTEXT = `Company
- Phoenix Home Remodeling (PHR) — legal name "CMC Group Ventures, Inc. DBA Phoenix Home Remodeling". Founded 2017. Interior design-build remodeler (kitchens, bathrooms, whole-home interiors) serving the Phoenix metro.
- Office: 6700 W Chicago St #1, Chandler, AZ 85226. Phone +1 602-492-8205. Email support@phxhomeremodeling.com. Website https://phxhomeremodeling.com
- Owners: Jeremy Maher (Co-Founder & COO; author of the book "Remodel Without Regret"), Ben Chesley (Co-Founder & CFO), Mark Chesley (Co-Founder & Chief Construction Officer).
- Person IDs: Jeremy https://phxhomeremodeling.com/author-jeremy-maher/#person · Ben https://phxhomeremodeling.com/about-phoenix-home-remodeling/#ben-chesley · Mark https://phxhomeremodeling.com/about-phoenix-home-remodeling/#mark-chesley
- Other IDs: #organization, #website, Book https://phxhomeremodeling.com/remodel-book/#book. Google KG: company kgmid /g/11fy2d3flq, Jeremy /g/11gffc0shl.
- Service area: Phoenix, Mesa, Chandler, Tempe, Gilbert, Scottsdale, Queen Creek, Sun Lakes, Laveen, Ahwatukee, Arcadia, Biltmore, South Phoenix (city pages are /…-az/).
- Credentials: Arizona Registered Contractor (ROC), BBB A+ accredited, NARI and NKBA member. Ratings change — read the current number from the schema instead of assuming one.

Confirmed facts (use these when schema disagrees)
- Project minimum $20,000 (never $15,000 or $18,000).
- Timelines: primary bathroom 4-7 weeks; guest bathroom 3-4 weeks.
- Laundry room remodel $20,000 to $25,000.
- Not decided yet — ask before changing: kitchen price range ($40K vs $50K–$100K+), whole-home range ($200K vs $150K–$500K), whether the shower range $12K–$30K applies site-wide, and minPrice/maxPrice numbers.

Website & schema setup
- Schema lives in Header Footer Code Manager (HFCM) snippets; one snippet per page, named with the page's live URL. About 150 snippets are active; inactive ones are old/retired.
- Key snippets: #407 homepage, #410 About, #537 Our Story, #556 Jeremy's author page, #557 Ben's author page, #559 media kit, #560 book page.
- The full Organization is copied into ~130 snippets (not defined once). A company-wide change means editing every copy — find them by searching for facebook.com/PhoenixHomeRemodelingCompany/.
- Rank Math also outputs its own schema block (class "rank-math-schema-pro": basic Organization, VideoObject…). It is NOT editable here; ignore it unless asked.
- Pages were renamed: bathroom-remodeling → bathroom-remodel, kitchen-remodeling → kitchen-remodel. The old kitchen-bath-renovation pages are retired.
- The team's sameAs tracking sheet and fact-fix docs are usually shared as Google links.`

export interface Settings { auto_apply_max: number; rules: string; effort: string; context: string; notes: string }
export function getSettings(): Settings {
  ensureSchemaToolTables()
  const rows = getDb().prepare('SELECT key, value FROM schema_tool_settings').all() as { key: string; value: string }[]
  const m: Record<string, string> = {}
  for (const r of rows) m[r.key] = r.value
  return {
    auto_apply_max: m.auto_apply_max != null ? Number(m.auto_apply_max) : 0,
    rules: m.rules != null ? m.rules : DEFAULT_RULES,
    effort: m.effort || '',
    context: m.context != null ? m.context : DEFAULT_CONTEXT,
    notes: m.notes || '',
  }
}

/** The assistant's "remember this" — appended to the notes shown (and editable) in Settings. */
export function addNote(note: string, by?: string | null): string {
  const n = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!n) return getSettings().notes
  const cur = getSettings().notes
  const line = `- ${n}${by ? ` (${by.split('@')[0]}, ${new Date().toISOString().slice(0, 10)})` : ''}`
  const next = (cur ? cur.trimEnd() + '\n' : '') + line
  saveSettings({ notes: next })
  return next
}

export function saveSettings(s: Partial<Settings>) {
  ensureSchemaToolTables()
  const st = getDb().prepare('INSERT INTO schema_tool_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
  if (s.auto_apply_max != null) st.run('auto_apply_max', String(Math.max(0, Math.floor(Number(s.auto_apply_max) || 0))))
  if (s.rules != null) st.run('rules', String(s.rules).slice(0, 20000))
  if (s.effort != null && ['', 'low', 'medium', 'high'].indexOf(s.effort) >= 0) st.run('effort', s.effort)
  if (s.context != null) st.run('context', String(s.context).slice(0, 30000))
  if (s.notes != null) st.run('notes', String(s.notes).slice(0, 20000))
}
