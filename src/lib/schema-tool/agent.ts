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
import { createChangeset, getChangeset, getItems, getSettings, ItemFull, listChangesets } from './store'
import { checkPage } from './pagecheck'

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
    name: 'get_snippet',
    description: 'Read one snippet in full (code + settings).',
    parameters: { type: 'object', properties: { id: num }, required: ['id'] },
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
    description: 'Fetch a page on the site and report which HFCM snippets it outputs, whether all JSON-LD parses, the canonical URL, and FAQ schema vs visible FAQ mismatches.',
    parameters: { type: 'object', properties: { url: str }, required: ['url'] },
  },
  {
    name: 'recent_changes',
    description: 'List recent changesets (id, title, status, counts).',
    parameters: { type: 'object', properties: { limit: num } },
  },
]

export interface AgentResult { reply: string; changesetIds: number[] }
interface Ctx { conversationId: string; user: string | null; changesetIds: number[] }

const cap = (o: unknown, n = 14000) => { const s = JSON.stringify(o); return s.length > n ? s.slice(0, n) + '…(truncated)' : s }

async function runTool(name: string, args: any, ctx: Ctx): Promise<string> {
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
    case 'get_snippet': {
      const s = await getSnippet(Number(args.id))
      const v = validateSnippet(s.snippet)
      return cap({ id: s.id, name: s.name, status: s.status, display_on: s.display_on, pages: s.s_pages, posts: s.s_posts, page_urls: s.page_urls, valid: v, code: s.snippet }, 60000)
    }
    case 'propose_replace': {
      const snippets = await listSnippets({ fresh: true })
      const plan = planReplace(snippets, {
        find: String(args.find || ''), replace: String(args.replace ?? ''), regex: !!args.regex, caseSensitive: args.case_sensitive !== false,
        wholeWord: !!args.whole_word, requireContext: args.require_context, excludeContext: args.exclude_context,
        onlyIds: args.only_ids, excludeIds: args.exclude_ids, activeOnly: !args.include_inactive,
      })
      const id = changesetFromPlan(plan, { ...csInfo(args.title), kind: 'replace', meta: { find: args.find, replace: args.replace, regex: !!args.regex, require_context: args.require_context, exclude_context: args.exclude_context } })
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
      const id = changesetFromEdits(staged, { ...csInfo(args.title), kind: 'edit' })
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
    case 'check_page': return cap(await checkPage(String(args.url)))
    case 'recent_changes': return cap(listChangesets(Math.min(Number(args.limit) || 10, 30)).map(c => ({ id: c.id, title: c.title, status: c.status, snippets: c.snippet_count, mentions: c.mention_count, created_at: c.created_at })))
    default: return cap({ error: `unknown tool ${name}` })
  }
}

function systemPrompt(): string {
  const c = getConfig()
  const s = getSettings()
  return `You are the Schema assistant inside MCD (Phoenix Home Remodeling's AgenticOS). You manage the JSON-LD schema stored in Header Footer Code Manager (HFCM) snippets on ${c.siteLabel} (${c.siteUrl}).

How you work:
- Snippet names are the URL of the page they belong to (normally the production URL ${c.prodOrigin}/…; on a staging copy the domain may be the staging domain). Match pages by path.
- Always look first (search_snippets / list_snippets / get_snippet / check_page). Base every number you report on tool results.
- To change anything, call a propose_* tool. That only STAGES a changeset; the person sees one card with counts and a before/after and applies it with one click. Never say something was saved or applied — say it is staged / ready to apply.
- Bundle related edits into one changeset when it is one logical change. Separate unrelated changes.
- Be careful with numbers that mean different things in different places (e.g. "5-7 weeks" for primary baths vs cabinets). Use require_context / exclude_context, check skipped_samples, and tell the person what was left out and why.
- If something is ambiguous and the choice changes the result, ask one short question instead of guessing.
- Keep replies short and plain: what you found, what is staged (snippets / mentions), anything skipped or worth knowing. No headings unless needed. Use bullet points sparingly.

House rules (must follow):
${s.rules}`
}

// ── provider loops ─────────────────────────────────────────────────────────
type Turn = { role: 'user' | 'assistant'; content: string }

async function runOpenAI(history: Turn[], ctx: Ctx, model: string): Promise<string> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt() }, ...history.map(h => ({ role: h.role, content: h.content }) as OpenAI.ChatCompletionMessageParam)]
  const tools: OpenAI.ChatCompletionTool[] = TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  for (let i = 0; i < 10; i++) {
    const r = await openai.chat.completions.create({ model, messages, tools })
    const msg = r.choices[0].message
    messages.push(msg as OpenAI.ChatCompletionMessageParam)
    if (!msg.tool_calls || !msg.tool_calls.length) return msg.content || ''
    for (const tc of msg.tool_calls) {
      let out: string
      try { out = await runTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'), ctx) } catch (e: any) { out = JSON.stringify({ error: e?.message || String(e) }) }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out })
    }
  }
  return 'I stopped after several steps without finishing. Try narrowing the request.'
}

async function runAnthropic(history: Turn[], ctx: Ctx, model: string): Promise<string> {
  const messages: any[] = history.map(h => ({ role: h.role, content: h.content }))
  const tools = TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  for (let i = 0; i < 10; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || '', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt(), tools, messages }),
    })
    const data: any = await res.json()
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`)
    messages.push({ role: 'assistant', content: data.content })
    const uses = (data.content || []).filter((b: any) => b.type === 'tool_use')
    if (data.stop_reason !== 'tool_use' || !uses.length) {
      return (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
    }
    const results: any[] = []
    for (const u of uses) {
      let out: string
      try { out = await runTool(u.name, u.input || {}, ctx) } catch (e: any) { out = JSON.stringify({ error: e?.message || String(e) }) }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out })
    }
    messages.push({ role: 'user', content: results })
  }
  return 'I stopped after several steps without finishing. Try narrowing the request.'
}

export async function runAgent(history: Turn[], ctx: { conversationId: string; user: string | null }): Promise<AgentResult> {
  const { provider, model } = getAiProvider()
  const c: Ctx = { ...ctx, changesetIds: [] }
  if (provider === 'none') return { reply: 'No AI key is configured. Add ANTHROPIC_API_KEY or OPENAI_API_KEY to .env.local. You can still use the Snippets tab to edit by hand.', changesetIds: [] }
  const reply = provider === 'anthropic' ? await runAnthropic(history, c, model) : await runOpenAI(history, c, model)
  return { reply, changesetIds: c.changesetIds }
}
