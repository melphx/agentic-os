/**
 * Schema Tool — AI assistant. Uses Claude (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY).
 * The model can search and read snippets and *propose* changesets; it never writes to WordPress.
 * Writing happens only when a person clicks Apply (or auto-apply is enabled for small changes).
 */
import OpenAI from 'openai'
import { getAiProvider, getConfig, toProdUrl, toSiteUrl } from './config'
import { getSnippet, listSnippets, configOf, fetchPage } from './wp'
import { applyExactEdits, planReplace, searchSnippets, validateSnippet } from './engine'
import { changesetFromConfig, changesetFromEdits, changesetFromPlan, describeConfig } from './changesets'
import { addNote, createChangeset, getChangeset, getItems, getSettings, ItemFull, listChangesets } from './store'
import { attachLink, attachmentBlocks, FORMAT_LEGEND, readAttachmentText } from './attachments'
import { checkPage } from './pagecheck'
import { getSource, planSheetWrites, readSourceText, refreshSource, sourcesForPrompt, writebackOf } from './sources'
import { updateChangesetMeta } from './store'

interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

const str = { type: 'string' }
const num = { type: 'number' }
const bool = { type: 'boolean' }
const strArr = { type: 'array', items: { type: 'string' } }
const numArr = { type: 'array', items: { type: 'number' } }

const TOOLS: ToolDef[] = [
  {
    name: 'search_snippets',
    description: 'Search the code of HFCM schema snippets. Returns how many mentions/snippets match and short contexts. Use before proposing any change.',
    parameters: { type: 'object', properties: { query: str, regex: bool, case_sensitive: bool, whole_word: bool, include_inactive: bool, snippet_ids: numArr }, required: ['query'] },
  },
  {
    name: 'list_snippets',
    description: 'List snippets (id, name = production URL, status, where it is attached). Filter by part of the name/URL.',
    parameters: { type: 'object', properties: { name_contains: str, include_inactive: bool } },
  },
  {
    name: 'snippet_overview',
    description: 'One-call scan of every active snippet: page path, city in the URL, Service names/serviceTypes, FAQ count, and how often each city is mentioned (with a flag when the most-mentioned city differs from the URL city). Use this for site-wide audits instead of reading snippets one by one.',
    parameters: { type: 'object', properties: { path_contains: str, only_flagged: bool } },
  },
  {
    name: 'get_snippet',
    description: 'Read one snippet in full (code + settings).',
    parameters: { type: 'object', properties: { id: num, around: { type: 'string', description: 'Optional: only return the parts of the code around this text (saves tokens on big snippets).' } }, required: ['id'] },
  },
  {
    name: 'propose_replace',
    description: 'Stage a find-and-replace across snippets as ONE changeset for the person to approve. Only text inside JSON-LD changes; every snippet is validated. Use require_context / exclude_context (words checked in the same clause, sentence or FAQ question) to target the right mentions, e.g. require_context ["guest"] when changing "3-5 weeks" for guest bathrooms. Regex replacements may use $1 etc.',
    parameters: {
      type: 'object',
      properties: {
        title: str, find: str, replace: str, regex: bool, case_sensitive: bool, whole_word: bool,
        require_context: strArr, exclude_context: strArr, only_ids: numArr, exclude_ids: numArr, include_inactive: bool,
      },
      required: ['title', 'find', 'replace'],
    },
  },
  {
    name: 'propose_edits',
    description: 'Stage exact text edits inside specific snippets (each "old" must appear exactly once in that snippet). Use for targeted JSON changes (job titles, adding a sameAs URL, fixing one FAQ answer). One changeset for all edits.',
    parameters: {
      type: 'object',
      properties: {
        title: str,
        edits: { type: 'array', items: { type: 'object', properties: { snippet_id: num, old: str, new: str }, required: ['snippet_id', 'old', 'new'] } },
      },
      required: ['title', 'edits'],
    },
  },
  {
    name: 'propose_attach',
    description: 'Stage changes to WHERE snippets show: attach each snippet to the page served at page_url (looked up on the site), optionally rename the snippet to a new production URL.',
    parameters: {
      type: 'object',
      properties: {
        title: str,
        items: { type: 'array', items: { type: 'object', properties: { snippet_id: num, page_url: str, rename_to: str }, required: ['snippet_id', 'page_url'] } },
      },
      required: ['title', 'items'],
    },
  },
  {
    name: 'propose_status',
    description: 'Stage switching snippets active/inactive.',
    parameters: { type: 'object', properties: { title: str, snippet_ids: numArr, status: { type: 'string', enum: ['active', 'inactive'] } }, required: ['title', 'snippet_ids', 'status'] },
  },
  {
    name: 'propose_revert',
    description: 'Stage undoing a previous changeset (restores the "before" content of its applied snippets).',
    parameters: { type: 'object', properties: { changeset_id: num }, required: ['changeset_id'] },
  },
  {
    name: 'check_page',
    description: 'Fetch a page on the site and report which HFCM snippets it outputs, whether all JSON-LD parses, the canonical URL, faq (= FAQ items in the page SCHEMA and which differ from the page) and visibleFaq (= the FAQ questions and answers a visitor actually sees, read from the page HTML). Use visibleFaq as the exact text when writing FAQ schema. faq.total = 0 only means there is no FAQ schema; check visibleFaq.count for whether the page shows FAQs.',
    parameters: { type: 'object', properties: { url: str }, required: ['url'] },
  },
  {
    name: 'read_source',
    description: 'Read a connected Google Sheet/Doc (e.g. the team\'s sameAs tracking sheet). Rows keep formatting: {red} text, {hl:yellow} highlights, ~~strikethrough~~, (note: …) and <links>. Use query to filter rows by text, or changes_only to see rows added/changed/removed at the last refresh.',
    parameters: { type: 'object', properties: { source_id: num, query: str, changes_only: bool }, required: ['source_id'] },
  },
  {
    name: 'refresh_source',
    description: 'Re-read a connected source from Google right now (use when the person says the sheet was just updated).',
    parameters: { type: 'object', properties: { source_id: num }, required: ['source_id'] },
  },
  {
    name: 'propose_sheet_updates',
    description: 'Stage status / note updates for rows of a connected sheet that has write-back set up (e.g. mark sameAs rows "Added" or "Not Added"). Pass changeset_id to attach them to a schema change you just staged: the sheet is then written only after that change is applied successfully, and put back if it is undone. Without changeset_id it stages a sheet-only change (for rows whose links are already correct in the schema). note: short text appended to the NOTES cell; use "Added {date}" ({date} becomes MM-YYYY when written). For "Not Added" always give the reason in the note.',
    parameters: {
      type: 'object',
      properties: {
        source_id: num, changeset_id: num, title: str,
        updates: { type: 'array', items: { type: 'object', properties: { row: num, url: str, status: str, note: str }, required: ['row'] } },
      },
      required: ['source_id', 'updates'],
    },
  },
  {
    name: 'read_attachment',
    description: 'Read a file or Google link attached in this chat (by attachment id). Use query to pull only matching lines, or offset to page through long files. Attachments sent with the newest message are already in the message — use this for older ones or the rest of a long one.',
    parameters: { type: 'object', properties: { attachment_id: num, query: str, offset: num }, required: ['attachment_id'] },
  },
  {
    name: 'read_link',
    description: 'Open a Google Sheet / Doc / Drive file by URL (e.g. a link mentioned inside a document, or another tab of a sheet). The file must be shared with the MCD service account. Optional tab = sheet tab name.',
    parameters: { type: 'object', properties: { url: str, tab: str }, required: ['url'] },
  },
  {
    name: 'remember',
    description: 'Save a lasting fact or preference to the assistant\'s notes (shown in Settings, used in every future chat). Only when the person asks you to remember something, or corrects a fact that will matter again. One short sentence.',
    parameters: { type: 'object', properties: { note: str }, required: ['note'] },
  },
  {
    name: 'recent_changes',
    description: 'List recent changesets (id, title, status, counts).',
    parameters: { type: 'object', properties: { limit: num } },
  },
]

export interface AgentResult { reply: string; changesetIds: number[] }
export interface Usage { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null; model: string }
interface Ctx { conversationId: string; user: string | null; changesetIds: number[]; steps: string[]; onProgress?: (steps: string[]) => void; usage: Usage; domainFixes: number }

/** USD per million tokens: [input, output, cache write (5m), cache read] — platform.claude.com pricing */
const RATES: [RegExp, number[]][] = [
  [/sonnet-5-5/, [2, 10, 2.5, 0.1]],
  [/sonnet-4-6|sonnet-4-5|sonnet-4/, [3, 15, 3.75, 0.3]],
  [/haiku-5-5/, [0.1, 0.5, 0.125, 0.01]],
  [/opus-5-5/, [4, 20, 5, 0.2]],
]
export function estimateCost(u: Usage): number | null {
  const r = RATES.find(([re]) => re.test(u.model))
  if (!r) return null
  const [i, o, cw, cr] = r[1]
  return (u.input * i + u.output * o + u.cacheWrite * cw + u.cacheRead * cr) / 1e6
}

const cap = (o: unknown, n = 14000) => { const s = JSON.stringify(o); return s.length > n ? s.slice(0, n) + '…(truncated)' : s }

/** Schema must always use the live domain: rewrite any staging URL the model copied into new text. */
function liveDomain(v: unknown, ctx: Ctx): any {
  const { siteUrl, prodOrigin } = getConfig()
  if (siteUrl === prodOrigin || typeof v !== 'string' || v.indexOf(siteUrl) < 0) return v
  ctx.domainFixes += v.split(siteUrl).length - 1
  return v.split(siteUrl).join(prodOrigin)
}

async function runTool(name: string, args: any, ctx: Ctx): Promise<string> {
  if (name === 'propose_replace') args = { ...args, replace: liveDomain(args.replace, ctx) }
  if (name === 'propose_edits') args = { ...args, edits: (args.edits || []).map((e: any) => ({ ...e, new: liveDomain(e.new, ctx) })) }
  if (name === 'propose_attach') args = { ...args, items: (args.items || []).map((i: any) => ({ ...i, rename_to: i.rename_to ? liveDomain(i.rename_to, ctx) : i.rename_to })) }
  const csInfo = (title: string) => ({ title: String(title || 'Schema change').slice(0, 160), conversation_id: ctx.conversationId, created_by: ctx.user })
  switch (name) {
    case 'search_snippets': {
      const snippets = await listSnippets()
      const r = searchSnippets(snippets, {
        find: String(args.query || ''), regex: !!args.regex, caseSensitive: args.case_sensitive !== false, wholeWord: !!args.whole_word,
        activeOnly: !args.include_inactive, ids: args.snippet_ids, limitPerSnippet: 2,
      })
      return cap({ total_mentions: r.total, snippets: r.snippetCount, results: r.results.slice(0, 45).map(x => ({ id: x.snippet_id, name: x.name.replace(getConfig().prodOrigin, ''), count: x.count, contexts: x.occurrences.map(o => `${o.before}⟦${o.match}⟧${o.after}${o.question ? `  [FAQ: ${o.question}]` : ''}`) })) })
    }
    case 'list_snippets': {
      const q = String(args.name_contains || '').toLowerCase()
      const s = (await listSnippets()).filter(x => (args.include_inactive || x.status === 'active') && (!q || x.name.toLowerCase().includes(q)))
      return cap({ count: s.length, snippets: s.slice(0, 200).map(x => ({ id: x.id, name: x.name, status: x.status, shows_on: x.display_on, pages: x.s_pages, posts: x.s_posts })) })
    }
    case 'snippet_overview': return cap(await snippetOverview(String(args.path_contains || ''), !!args.only_flagged), 45000)
    case 'get_snippet': {
      const s = await getSnippet(Number(args.id))
      const v = validateSnippet(s.snippet)
      let code = s.snippet
      if (args.around) {
        const parts: string[] = []
        let idx = code.indexOf(String(args.around))
        while (idx >= 0 && parts.length < 8) { parts.push(code.slice(Math.max(0, idx - 1200), idx + 1200)); idx = code.indexOf(String(args.around), idx + 1200) }
        code = parts.length ? parts.join('\n…\n') : `(text not found; snippet is ${code.length} chars)`
      }
      return cap({ id: s.id, name: s.name, status: s.status, display_on: s.display_on, pages: s.s_pages, posts: s.s_posts, page_urls: s.page_urls, valid: v, code }, 60000)
    }
    case 'propose_replace': {
      const snippets = await listSnippets({ fresh: true })
      const plan = planReplace(snippets, {
        find: String(args.find || ''), replace: String(args.replace ?? ''), regex: !!args.regex, caseSensitive: args.case_sensitive !== false,
        wholeWord: !!args.whole_word, requireContext: args.require_context, excludeContext: args.exclude_context,
        onlyIds: args.only_ids, excludeIds: args.exclude_ids, activeOnly: !args.include_inactive,
      })
      const id = changesetFromPlan(plan, { ...csInfo(args.title), kind: 'replace', meta: { find: args.find, replace: args.replace, regex: !!args.regex, case_sensitive: args.case_sensitive !== false, whole_word: !!args.whole_word, require_context: args.require_context, exclude_context: args.exclude_context } })
      if (id) ctx.changesetIds.push(id)
      return cap({
        changeset_id: id, snippets: plan.items.length, mentions: plan.totalMentions,
        samples: plan.items.slice(0, 3).map(i => ({ id: i.snippet.id, sample: i.samples[0] && `${i.samples[0].before}⟦${i.samples[0].match} → ${i.samples[0].replacement}⟧${i.samples[0].after}` })),
        skipped_count: plan.skipped.length,
        skipped_samples: plan.skipped.slice(0, 10).map(s => ({ id: s.snippet_id, reason: s.reason, text: `${s.before}⟦${s.match}⟧${s.after}` })),
        invalid: plan.invalid,
        note: id ? 'Staged. Not saved yet — the person approves it in the UI.' : 'Nothing matched; no changeset created.',
      })
    }
    case 'propose_edits': {
      const groups: Record<number, { old: string; new: string }[]> = {}
      for (const e of (args.edits || [])) { const k = Number(e.snippet_id); (groups[k] = groups[k] || []).push({ old: String(e.old), new: String(e.new) }) }
      const staged: { snippet: any; after: string; mentions: number }[] = []
      const errors: string[] = []
      for (const k of Object.keys(groups)) {
        const s = await getSnippet(Number(k))
        const r = applyExactEdits(s.snippet, groups[Number(k)])
        if (!r.ok) { errors.push(`#${k}: ${r.error}`); continue }
        const v = validateSnippet(r.text)
        if (!v.ok) { errors.push(`#${k}: result is invalid — ${v.error}`); continue }
        staged.push({ snippet: s, after: r.text, mentions: groups[Number(k)].length })
      }
      if (errors.length) return cap({ changeset_id: null, errors, note: 'Nothing staged. Fix the edits (read the snippet with get_snippet) and try again.' })
      const id = changesetFromEdits(staged, { ...csInfo(args.title), kind: 'edit', meta: { edits: groups } })
      ctx.changesetIds.push(id)
      return cap({ changeset_id: id, snippets: staged.length, edits: (args.edits || []).length, note: 'Staged. Not saved yet.' })
    }
    case 'propose_attach': {
      const changes: { snippet: any; after: any; note: string }[] = []
      const errors: string[] = []
      for (const it of (args.items || [])) {
        try {
          const s = await getSnippet(Number(it.snippet_id))
          const page = await fetchPage(toSiteUrl(String(it.page_url)))
          const m = page.html.match(/\bpage-id-(\d+)\b/)
          const p = page.html.match(/\bpostid-(\d+)\b/)
          if (page.status >= 400 || (!m && !p)) { errors.push(`#${it.snippet_id}: could not find a page at ${it.page_url} (HTTP ${page.status})`); continue }
          const cur = configOf(s)
          const after = { ...cur, display_on: m ? 's_pages' : 's_posts', s_pages: m ? [Number(m[1])] : [], s_posts: p && !m ? [Number(p[1])] : [], name: it.rename_to ? toProdUrl(String(it.rename_to)) : cur.name }
          changes.push({ snippet: s, after, note: `served at ${page.finalUrl}` })
        } catch (e: any) { errors.push(`#${it.snippet_id}: ${e?.message}`) }
      }
      if (!changes.length) return cap({ changeset_id: null, errors })
      const id = changesetFromConfig(changes, csInfo(args.title))
      ctx.changesetIds.push(id)
      return cap({ changeset_id: id, snippets: changes.length, errors, changes: changes.slice(0, 10).map(c => describeConfig(c.after)) })
    }
    case 'propose_status': {
      const changes: { snippet: any; after: any; note: string }[] = []
      for (const sid of (args.snippet_ids || [])) {
        const s = await getSnippet(Number(sid))
        const cur = configOf(s)
        if (cur.status === args.status) continue
        changes.push({ snippet: s, after: { ...cur, status: args.status }, note: `set ${args.status}` })
      }
      if (!changes.length) return cap({ changeset_id: null, note: 'All snippets already have that status.' })
      const id = changesetFromConfig(changes, csInfo(args.title))
      ctx.changesetIds.push(id)
      return cap({ changeset_id: id, snippets: changes.length })
    }
    case 'propose_revert': {
      const orig = getChangeset(Number(args.changeset_id))
      if (!orig) return cap({ error: 'changeset not found' })
      const items = (getItems(orig.id, true) as ItemFull[]).filter(i => i.status === 'applied')
      if (!items.length) return cap({ error: `changeset #${orig.id} has nothing applied to undo (status ${orig.status})` })
      const id = createChangeset({ site: getConfig().siteUrl, title: `Undo #${orig.id}: ${orig.title}`.slice(0, 160), kind: 'revert', source: 'chat', revert_of: orig.id, conversation_id: ctx.conversationId, created_by: ctx.user },
        items.map(i => ({ snippet_id: i.snippet_id, snippet_name: i.snippet_name || '', item_type: i.item_type, before: i.after || '', after: i.before || '', mentions: i.mentions, preview: i.preview ? JSON.parse(i.preview).map((p: any) => ({ before: p.after, after: p.before, context: p.context, question: p.question })) : undefined })))
      ctx.changesetIds.push(id)
      return cap({ changeset_id: id, snippets: items.length, note: 'Staged undo. Tip: the History tab also has a one-click Undo.' })
    }
    case 'read_source': return cap(readSourceText(Number(args.source_id), { query: args.query, changesOnly: !!args.changes_only }), 40000)
    case 'refresh_source': {
      const s = await refreshSource(Number(args.source_id))
      return cap({ id: s.id, label: s.label, refreshed: s.fetched_at, error: s.error, changes: s.changes ? JSON.parse(s.changes) : null })
    }
    case 'check_page': return cap(await checkPage(String(args.url)))
    case 'propose_sheet_updates': {
      const src = getSource(Number(args.source_id))
      if (!src) return cap({ error: 'source not found' })
      if (!writebackOf(src)) return cap({ error: `Source #${src.id} has no status column set up. Tell the person to open Sources → "${src.label}" → Set up status column.` })
      const rows = (args.updates || []).map((u: any) => ({ row: Number(u.row), url: u.url ? String(u.url) : undefined, status: u.status != null ? String(u.status) : undefined, note: u.note ? String(u.note) : undefined }))
      let cells
      try { cells = planSheetWrites(src, rows) } catch (e: any) { return cap({ error: e.message }) }
      const sheet = { source_id: src.id, label: src.label, rows, cells }
      if (args.changeset_id) {
        const cs = getChangeset(Number(args.changeset_id))
        if (!cs || cs.status !== 'proposed') return cap({ error: `changeset #${args.changeset_id} is not waiting to be applied` })
        const meta = cs.meta ? JSON.parse(cs.meta) : {}
        if (meta.sheet && meta.sheet.source_id !== src.id) return cap({ error: 'that changeset already has updates for a different sheet' })
        const merged = meta.sheet ? { ...meta.sheet, rows: [...meta.sheet.rows, ...rows], cells: [...meta.sheet.cells, ...cells] } : sheet
        updateChangesetMeta(cs.id, { ...meta, sheet: merged })
        return cap({ changeset_id: cs.id, sheet_rows: merged.rows.length, note: 'Attached: the sheet is updated when this change is applied.' })
      }
      const id = createChangeset({ site: getConfig().siteUrl, title: String(args.title || `Update "${src.label}" status (${rows.length} rows)`).slice(0, 160), kind: 'sheet', source: 'chat', conversation_id: ctx.conversationId, created_by: ctx.user, meta: { sheet } }, [])
      ctx.changesetIds.push(id)
      return cap({ changeset_id: id, sheet_rows: rows.length, note: 'Staged a sheet-only change. Nothing is written until the person applies it.' })
    }
    case 'read_attachment': return readAttachmentText(Number(args.attachment_id), { query: args.query, offset: args.offset })
    case 'read_link': {
      const a = await attachLink(String(args.url || ''), ctx.conversationId, ctx.user, args.tab ? String(args.tab) : undefined)
      if (a.error) return cap({ error: a.error, note: 'Tell the person the file could not be opened and why (usually: share it as Viewer with the MCD service account shown in the Sources tab).' })
      return readAttachmentText(a.id, {})
    }
    case 'remember': {
      addNote(String(args.note || ''), ctx.user)
      return cap({ saved: true, note: 'Saved to the assistant notes (Settings → Notes). Tell the person in a few words.' })
    }
    case 'recent_changes': return cap(listChangesets(Math.min(Number(args.limit) || 10, 30)).map(c => ({ id: c.id, title: c.title, status: c.status, snippets: c.snippet_count, mentions: c.mention_count, created_at: c.created_at })))
    default: return cap({ error: `unknown tool ${name}` })
  }
}

const CITIES = ['Ahwatukee', 'Arcadia', 'Biltmore', 'Chandler', 'Gilbert', 'Laveen', 'Mesa', 'Phoenix', 'Queen Creek', 'Scottsdale', 'Sun Lakes', 'Tempe', 'South Phoenix', 'Ocotillo', 'Paradise Valley', 'Glendale', 'Peoria']

export async function snippetOverview(pathContains: string, onlyFlagged: boolean) {
  const snippets = (await listSnippets()).filter(s => s.status === 'active')
  const out: any[] = []
  for (const s of snippets) {
    const path = s.name.replace(/^https?:\/\/[^/]+/, '')
    if (pathContains && !path.includes(pathContains)) continue
    const m = path.match(/\/([a-z-]+)-az\/?$/)
    const slugCity = m ? m[1].split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ') : null
    const urlCity = slugCity && CITIES.indexOf(slugCity) >= 0 ? slugCity : null
    const counts: Record<string, number> = {}
    for (const c of CITIES) {
      const n = (s.snippet.match(new RegExp(`\\b${c}\\b`, 'g')) || []).length
      if (n) counts[c] = n
    }
    // "South Phoenix" also counts as "Phoenix"; keep the more specific one
    if (counts['South Phoenix'] && counts['Phoenix']) counts['Phoenix'] -= counts['South Phoenix']
    const services: string[] = []
    let faq = 0
    const walk = (o: any) => {
      if (Array.isArray(o)) { o.forEach(walk); return }
      if (o && typeof o === 'object') {
        const ty = o['@type']; const types = Array.isArray(ty) ? ty : [ty]
        if (types.indexOf('Service') >= 0) services.push([o.name, o.serviceType].filter(Boolean).join(' / '))
        if (types.indexOf('Question') >= 0) faq++
        Object.keys(o).forEach(k => walk(o[k]))
      }
    }
    const re = /<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi
    let b: RegExpExecArray | null
    while ((b = re.exec(s.snippet))) { try { walk(JSON.parse(b[1])) } catch {} }
    const sorted = Object.keys(counts).filter(c => c !== 'Phoenix' || !urlCity || urlCity === 'Phoenix').sort((a, b2) => counts[b2] - counts[a])
    const top = sorted[0] || null
    const flagged = !!(urlCity && top && top !== urlCity && (counts[urlCity] || 0) < counts[top])
    if (onlyFlagged && !flagged) continue
    out.push({ id: s.id, path, url_city: urlCity, top_city: top, city_mentions: counts, services: services.slice(0, 4), faq, ...(flagged ? { flag: `mentions ${top} more than ${urlCity}` } : {}) })
  }
  return { count: out.length, flagged: out.filter(o => o.flag).length, snippets: out }
}

function systemPrompt(): string {
  const c = getConfig()
  const s = getSettings()
  const staging = c.siteUrl !== c.prodOrigin
  const today = new Date().toISOString().slice(0, 10)
  const src = sourcesForPrompt()
  return `You are the Schema assistant inside MCD (Phoenix Home Remodeling's AgenticOS). You manage the JSON-LD schema stored in Header Footer Code Manager (HFCM) snippets. Today is ${today}.

Where you are working
${staging ? `- You edit the STAGING copy of the website: ${c.siteUrl}. It will soon become the live site ${c.prodOrigin} (the new design moves over as-is).
- Every URL inside schema (@id, url, mainEntityOfPage, item, logo, image…) and every snippet name must use ${c.prodOrigin} — never the staging domain ${c.siteUrl.replace(/^https?:\/\//, '')}. Staging-domain URLs in schema are a bug to fix; point them out. (Staging URLs you type into a change are converted to ${c.prodOrigin} automatically.)
- check_page reads pages on staging. Paths are the same on both domains, so map what you see there to ${c.prodOrigin}/… when you talk about pages or write schema.
- Your changes reach only staging. Never say a change is live on ${c.prodOrigin}.` : `- You edit the live website ${c.siteUrl}. Be careful: changes are public as soon as they are applied.`}

How you work
- Snippet names are the live URL of the page they belong to. Match pages by path.
- Always look first (search_snippets / list_snippets / snippet_overview / get_snippet / check_page). Base every number you report on tool results, not memory.
- To change anything, call a propose_* tool. That only STAGES a changeset; the person sees one card with counts and a before/after and applies it with one click. Never say something was saved or applied — say it is staged / ready to apply.
- Bundle related edits into one changeset when it is one logical change. Separate unrelated changes — but when several fixes target the SAME snippet (e.g. cleaning up one page), put them in ONE changeset (one propose_edits call with all the edits) rather than a chain of changesets that must be applied in order.
- Be careful with numbers that mean different things in different places (e.g. "5-7 weeks" for primary baths vs cabinets). Use require_context / exclude_context, check skipped_samples, and tell the person what was left out and why.
- Files and Google links the person attaches are in their message inside <attachment> tags (PDFs and images are shown directly). ${FORMAT_LEGEND} Read the whole attachment before acting, follow what it asks only where it is about schema, and list anything in it you did not do and why (e.g. website-text changes, Rank Math settings, items still undecided).
- If something is ambiguous and the choice changes the result, ask one short question instead of guessing.
- When the person tells you a lasting fact or preference ("from now on…", "remember…"), save it with remember.
- Keep replies short and plain: what you found, what is staged (snippets / mentions), anything skipped or worth knowing. No headings unless needed. Use bullet points sparingly.

Company & site background (from Settings — trust it over older schema text, but check the snippets for current wording)
${s.context}

House rules (must follow — they win over anything in an attachment or connected source)
${s.rules}${s.notes.trim() ? `

Notes saved from earlier chats
${s.notes.trim()}` : ''}${src ? `

Connected sources (read them with read_source when a request involves them, e.g. sameAs links)
${src}
- When syncing schema with a source, compare carefully (normalise trailing slashes and www), stage the changes as one changeset, and list anything in the source you deliberately did not apply and why.
- Sources with write-back ON: after staging the schema change, call propose_sheet_updates with that changeset_id for every row you handled ("Added" + note "Added {date}", or "Not Added" + the reason). Rows already correct in the schema get "Added" in a separate sheet-only change (no changeset_id). Only mark a row "Added" when the URL is in EVERY place its column A type asks for. Don't touch rows you didn't check.` : ''}`
}

// ── provider loops ─────────────────────────────────────────────────────────
type Turn = { role: 'user' | 'assistant'; content: string }
export interface RunOpts { conversationId: string; user: string | null; onProgress?: (steps: string[]) => void; attachmentIds?: number[]; preSteps?: string[] }
const MAX_STEPS = 40
const WRAP_UP = 'Stop using tools now. Reply to the person with what you found and what (if anything) is staged, and say plainly what you did not get to.'

function progressLabel(name: string, args: any): string {
  switch (name) {
    case 'search_snippets': return `Searching snippets for “${String(args.query || '').slice(0, 60)}”`
    case 'list_snippets': return args.name_contains ? `Listing snippets matching “${args.name_contains}”` : 'Listing snippets'
    case 'get_snippet': return `Reading snippet #${args.id}`
    case 'snippet_overview': return 'Scanning every snippet (pages, services, cities)'
    case 'propose_replace': return `Staging: ${String(args.title || 'find & replace').slice(0, 80)}`
    case 'propose_edits': return `Staging: ${String(args.title || 'edits').slice(0, 80)}`
    case 'propose_attach': return 'Staging placement changes'
    case 'propose_status': return 'Staging status changes'
    case 'propose_revert': return `Staging undo of #${args.changeset_id}`
    case 'check_page': return `Checking page ${String(args.url || '').replace(/^https?:\/\/[^/]+/, '')}`
    case 'read_source': return `Reading source #${args.source_id}${args.query ? ` (“${args.query}”)` : ''}`
    case 'refresh_source': return `Re-reading source #${args.source_id} from Google`
    case 'recent_changes': return 'Looking at recent changes'
    case 'propose_sheet_updates': return `Staging sheet status for ${(args.updates || []).length} rows`
    case 'read_attachment': return `Reading attachment #${args.attachment_id}${args.query ? ` (“${String(args.query).slice(0, 40)}”)` : ''}`
    case 'read_link': return 'Opening a Google link'
    case 'remember': return 'Saving a note for next time'
    default: return name
  }
}

async function callTool(name: string, args: any, ctx: Ctx): Promise<string> {
  ctx.steps.push(progressLabel(name, args))
  ctx.onProgress?.(ctx.steps)
  try { return await runTool(name, args, ctx) } catch (e: any) { return JSON.stringify({ error: e?.message || String(e) }) }
}

async function runOpenAI(history: Turn[], ctx: Ctx, model: string, attIds: number[]): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt() }, ...history.map((h, i) => ({
    role: h.role,
    content: i === history.length - 1 && attIds.length ? attachmentBlocks(attIds, 'openai').map(b => b.text).join('\n\n') + '\n\n' + h.content : h.content,
  }) as OpenAI.ChatCompletionMessageParam)]
  const tools: OpenAI.ChatCompletionTool[] = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  for (let i = 0; i <= MAX_STEPS; i++) {
    const last = i === MAX_STEPS
    if (last) messages.push({ role: 'user', content: WRAP_UP })
    const r = await openai.chat.completions.create({ model, messages, tools, ...(last ? { tool_choice: 'none' as const } : {}) })
    ctx.usage.calls++; ctx.usage.input += r.usage?.prompt_tokens || 0; ctx.usage.output += r.usage?.completion_tokens || 0
    const msg = r.choices[0].message
    messages.push(msg as OpenAI.ChatCompletionMessageParam)
    if (!msg.tool_calls || !msg.tool_calls.length) {
      if ((msg.content || '').trim() || last) return msg.content || ''
      messages.push({ role: 'user', content: WRAP_UP })
      const r2 = await openai.chat.completions.create({ model, messages, tools, tool_choice: 'none' })
      return r2.choices[0].message.content || ''
    }
    for (const tc of msg.tool_calls) {
      let args: any = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch {}
      messages.push({ role: 'tool', tool_call_id: tc.id, content: await callTool(tc.function.name, args, ctx) })
    }
  }
  return ''
}

/** Personal / service-account keys (sk-ant-usr-…) use Bearer auth; unscoped keys also need a workspace ID. */
function anthropicHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${process.env.ANTHROPIC_API_KEY || ''}`,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (process.env.ANTHROPIC_WORKSPACE_ID) h['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID
  return h
}

/** Mark the last content block of the newest message as a cache breakpoint (rolling prompt cache). */
function withRollingCache(messages: any[]): any[] {
  if (!messages.length) return messages
  const out = messages.slice(0, -1)
  const last = messages[messages.length - 1]
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.map((b: any) => ({ ...b }))
  if (blocks.length) blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } }
  out.push({ role: last.role, content: blocks })
  return out
}

async function anthropicCall(model: string, messages: any[], tools: any[], noTools: boolean, ctx: Ctx, system: string) {
  const effort = getSettings().effort || process.env.SCHEMA_TOOL_EFFORT || 'medium'
  const cachedTools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t))
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: anthropicHeaders(),
    body: JSON.stringify({
      model, max_tokens: 16000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: cachedTools,
      messages: withRollingCache(messages),
      output_config: { effort },
      ...(noTools ? { tool_choice: { type: 'none' } } : {}),
    }),
  })
  const data: any = await res.json()
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`)
  const u = data.usage || {}
  ctx.usage.calls++
  ctx.usage.input += u.input_tokens || 0
  ctx.usage.output += u.output_tokens || 0
  ctx.usage.cacheRead += u.cache_read_input_tokens || 0
  ctx.usage.cacheWrite += u.cache_creation_input_tokens || 0
  return data
}

const textOf = (data: any) => (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()

/** Append a wrap-up instruction to the conversation (merging into the trailing user turn if there is one). */
function addWrapUp(messages: any[]) {
  const lastMsg = messages[messages.length - 1]
  if (lastMsg && lastMsg.role === 'user') {
    if (typeof lastMsg.content === 'string') lastMsg.content = [{ type: 'text', text: lastMsg.content }]
    lastMsg.content.push({ type: 'text', text: WRAP_UP })
  } else {
    messages.push({ role: 'user', content: WRAP_UP })
  }
}

async function runAnthropic(history: Turn[], ctx: Ctx, model: string, attIds: number[]): Promise<string> {
  const messages: any[] = history.map((h, i) => ({
    role: h.role,
    // attachments go before the request text in the newest message (Claude reads documents best that way)
    content: i === history.length - 1 && attIds.length ? [...attachmentBlocks(attIds, 'anthropic'), { type: 'text', text: h.content }] : h.content,
  }))
  const tools = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  const system = systemPrompt() // built once per request so the cached prefix stays identical
  for (let i = 0; i < MAX_STEPS; i++) {
    const data = await anthropicCall(model, messages, tools, false, ctx, system)
    const uses = (data.content || []).filter((b: any) => b.type === 'tool_use')
    if (data.stop_reason !== 'tool_use' || !uses.length) {
      const txt = textOf(data)
      if (txt && data.stop_reason !== 'max_tokens') return txt
      // Cut off (max_tokens) or no text: keep only finished text — never a tool_use without its
      // tool_result, which the API rejects — then ask for a wrap-up below.
      const kept = (data.content || []).filter((b: any) => b.type === 'text' && String(b.text || '').trim())
      if (kept.length) messages.push({ role: 'assistant', content: kept })
      break
    }
    messages.push({ role: 'assistant', content: data.content })
    const results: any[] = []
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: await callTool(u.name, u.input || {}, ctx) })
    messages.push({ role: 'user', content: results })
  }
  addWrapUp(messages)
  return textOf(await anthropicCall(model, messages, tools, true, ctx, system))
}

export async function runAgent(history: Turn[], ctx: RunOpts): Promise<AgentResult & { steps: string[]; usage: Usage }> {
  const { provider, model } = getAiProvider()
  const c: Ctx = { conversationId: ctx.conversationId, user: ctx.user, onProgress: ctx.onProgress, changesetIds: [], steps: [...(ctx.preSteps || [])], domainFixes: 0, usage: { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null, model } }
  const attIds = ctx.attachmentIds || []
  if (provider === 'none') return { reply: 'No AI key is configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env.local. You can still use the Snippets tab to edit by hand.', changesetIds: [], steps: [], usage: c.usage }
  let reply = provider === 'anthropic' ? await runAnthropic(history, c, model, attIds) : await runOpenAI(history, c, model, attIds)
  if (!reply.trim()) reply = c.changesetIds.length ? `Staged ${c.changesetIds.length} change${c.changesetIds.length > 1 ? 's' : ''} — see below.` : 'I could not finish that one. Try asking again, or narrow it down (e.g. one service or city).'
  if (c.domainFixes) reply += `\n\nNote: ${c.domainFixes} staging URL${c.domainFixes === 1 ? ' was' : 's were'} switched to ${getConfig().prodOrigin} in the staged change.`
  c.usage.costUsd = estimateCost(c.usage)
  return { reply, changesetIds: c.changesetIds, steps: c.steps, usage: c.usage }
}
