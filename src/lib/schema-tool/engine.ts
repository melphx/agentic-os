/**
 * Schema Tool — pure helpers: JSON-LD parsing/validation, search, guarded bulk replace, diffs.
 */
import type { Snippet } from './wp'

const LD_RE = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi

export function jsonLdBlocks(text: string): string[] {
  const out: string[] = []
  let m: RegExpExecArray | null
  const re = new RegExp(LD_RE.source, 'gi')
  while ((m = re.exec(text))) out.push(m[1])
  return out
}

export function validateSnippet(text: string): { ok: boolean; blocks: number; error?: string } {
  const blocks = jsonLdBlocks(text)
  for (let i = 0; i < blocks.length; i++) {
    try { JSON.parse(blocks[i]) } catch (e: any) {
      return { ok: false, blocks: blocks.length, error: `JSON-LD block ${i + 1}: ${e?.message || 'invalid JSON'}` }
    }
  }
  return { ok: true, blocks: blocks.length }
}

/** Text outside the JSON-LD script blocks (must never change on a schema edit). */
export function outsideScripts(text: string): string {
  return text.replace(new RegExp(LD_RE.source, 'gi'), '<script>…</script>')
}

export function collapse(s: string) { return s.replace(/\s+/g, ' ').trim() }

/** Nearest FAQ question ("name") preceding a position, if the position sits inside an Answer. */
function questionBefore(text: string, pos: number): string | null {
  const win = text.slice(Math.max(0, pos - 4000), pos)
  const qi = win.lastIndexOf('"@type": "Question"')
  if (qi < 0) return null
  const after = win.slice(qi)
  const m = after.match(/"name":\s*"((?:[^"\\]|\\.)*)"/)
  return m ? m[1] : null
}

function contextAround(text: string, start: number, end: number, w = 110) {
  const ws = (s: string) => s.replace(/\s+/g, ' ')
  let before = ws(text.slice(Math.max(0, start - w), start))
  // inside a JSON string value: show only the value text, not the JSON keys before it
  const k = before.lastIndexOf('": "')
  if (k >= 0 && before.slice(k + 4).indexOf('"') < 0) before = before.slice(k + 4)
  let after = ws(text.slice(end, end + Math.round(w * 0.7)))
  const q = after.indexOf('"')
  if (q >= 0) after = after.slice(0, q)
  return { before: before.replace(/^\s+/, ''), match: text.slice(start, end), after: after.replace(/\s+$/, '') }
}

/** The clause a match belongs to: text since the last , . ; : or quote, plus a little after. */
function clauseOf(text: string, start: number, end: number): string {
  let s = start
  const stops = ',.;:"\n'
  while (s > 0 && stops.indexOf(text[s - 1]) < 0 && start - s < 220) s--
  return (text.slice(s, start) + ' ' + text.slice(end, end + 45)).toLowerCase()
}

function sentenceOf(text: string, start: number): string {
  let s = start
  while (s > 0 && '."\n'.indexOf(text[s - 1]) < 0 && start - s < 600) s--
  return text.slice(s, start).toLowerCase()
}

export interface FindOptions {
  find: string
  regex?: boolean
  caseSensitive?: boolean
  wholeWord?: boolean
}

export function buildRegex(o: FindOptions): RegExp {
  let src = o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (o.wholeWord) src = `(?<![A-Za-z0-9])(?:${src})(?![A-Za-z0-9])`
  return new RegExp(src, o.caseSensitive === false ? 'gi' : 'g')
}

export interface Occurrence {
  snippet_id: number
  snippet_name: string
  index: number
  before: string
  match: string
  after: string
  question?: string | null
  in_schema: boolean
}

export function searchSnippets(snippets: Snippet[], o: FindOptions & { activeOnly?: boolean; ids?: number[]; limitPerSnippet?: number }) {
  const re = buildRegex(o)
  const results: { snippet_id: number; name: string; status: string; count: number; occurrences: Occurrence[] }[] = []
  let total = 0
  for (const s of snippets) {
    if (o.activeOnly !== false && s.status !== 'active') continue
    if (o.ids && o.ids.length && o.ids.indexOf(s.id) < 0) continue
    const occ: Occurrence[] = []
    let count = 0
    const r = new RegExp(re.source, re.flags)
    let m: RegExpExecArray | null
    while ((m = r.exec(s.snippet))) {
      if (m[0] === '') { r.lastIndex++; continue }
      count++
      if (occ.length < (o.limitPerSnippet ?? 3)) {
        const c = contextAround(s.snippet, m.index, m.index + m[0].length)
        occ.push({ snippet_id: s.id, snippet_name: s.name, index: m.index, ...c, question: questionBefore(s.snippet, m.index), in_schema: true })
      }
    }
    if (count) { results.push({ snippet_id: s.id, name: s.name, status: s.status, count, occurrences: occ }); total += count }
  }
  return { total, snippetCount: results.length, results }
}

export interface ReplaceOptions extends FindOptions {
  replace: string
  /** keep a match only if its clause/sentence/FAQ question mentions one of these words */
  requireContext?: string[]
  /** skip a match if its clause mentions one of these words */
  excludeContext?: string[]
  onlyIds?: number[]
  excludeIds?: number[]
  activeOnly?: boolean
}

export interface PlannedItem {
  snippet: Snippet
  after: string
  mentions: number
  samples: { before: string; match: string; after: string; replacement: string; question?: string | null }[]
}

export interface ReplacePlan {
  items: PlannedItem[]
  totalMentions: number
  skipped: { snippet_id: number; snippet_name: string; reason: string; before: string; match: string; after: string }[]
  invalid: { snippet_id: number; snippet_name: string; error: string }[]
}

export function planReplace(snippets: Snippet[], o: ReplaceOptions): ReplacePlan {
  const re = buildRegex(o)
  const req = (o.requireContext || []).map(w => w.toLowerCase()).filter(Boolean)
  const exc = (o.excludeContext || []).map(w => w.toLowerCase()).filter(Boolean)
  const plan: ReplacePlan = { items: [], totalMentions: 0, skipped: [], invalid: [] }

  for (const s of snippets) {
    if (o.activeOnly !== false && s.status !== 'active') continue
    if (o.onlyIds && o.onlyIds.length && o.onlyIds.indexOf(s.id) < 0) continue
    if (o.excludeIds && o.excludeIds.indexOf(s.id) >= 0) continue
    const text = s.snippet
    const r = new RegExp(re.source, re.flags)
    let out = ''
    let last = 0
    let mentions = 0
    const samples: PlannedItem['samples'] = []
    let m: RegExpExecArray | null
    while ((m = r.exec(text))) {
      if (m[0] === '') { r.lastIndex++; continue }
      const start = m.index, end = start + m[0].length
      // never touch anything outside JSON-LD blocks
      const before = text.slice(0, start)
      const opens = (before.match(/<script[^>]*application\/ld\+json[^>]*>/gi) || []).length
      const closes = (before.match(/<\/script>/gi) || []).length
      const ctx = contextAround(text, start, end)
      if (opens <= closes) {
        plan.skipped.push({ snippet_id: s.id, snippet_name: s.name, reason: 'outside JSON-LD', ...ctx })
        continue
      }
      if (req.length || exc.length) {
        const clause = clauseOf(text, start, end)
        const wide = clause + ' ' + sentenceOf(text, start) + ' ' + (questionBefore(text, start) || '').toLowerCase()
        if (exc.length && exc.some(w => clause.indexOf(w) >= 0)) {
          plan.skipped.push({ snippet_id: s.id, snippet_name: s.name, reason: 'excluded by context', ...ctx }); continue
        }
        if (req.length) {
          // prefer the clause; fall back to the sentence / FAQ question
          const hitClause = req.some(w => clause.indexOf(w) >= 0)
          const hitWide = hitClause || req.some(w => wide.indexOf(w) >= 0)
          if (!hitWide) { plan.skipped.push({ snippet_id: s.id, snippet_name: s.name, reason: 'context not matched', ...ctx }); continue }
        }
      }
      const replacement = o.regex ? expandReplacement(o.replace, m) : o.replace
      out += text.slice(last, start) + replacement
      last = end
      mentions++
      if (samples.length < 3) samples.push({ ...ctx, replacement, question: questionBefore(text, start) })
    }
    if (!mentions) continue
    out += text.slice(last)
    const v = validateSnippet(out)
    if (!v.ok) { plan.invalid.push({ snippet_id: s.id, snippet_name: s.name, error: v.error || 'invalid' }); continue }
    if (outsideScripts(out) !== outsideScripts(text)) { plan.invalid.push({ snippet_id: s.id, snippet_name: s.name, error: 'would change text outside JSON-LD' }); continue }
    plan.items.push({ snippet: s, after: out, mentions, samples })
    plan.totalMentions += mentions
  }
  return plan
}

/** Expand $&, $1..$99 and $<name> in a regex replacement string using an exec() match. */
export function expandReplacement(tpl: string, m: RegExpExecArray): string {
  return tpl.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g, (all, tok: string) => {
    if (tok === '$') return '$'
    if (tok === '&') return m[0]
    if (tok[0] === '<') return (m.groups && m.groups[tok.slice(1, -1)]) || ''
    const n = Number(tok)
    return n < m.length ? (m[n] ?? '') : all
  })
}

/** Apply a list of exact old→new string edits to one snippet. Each old must occur exactly once. */
export function applyExactEdits(text: string, edits: { old: string; new: string }[]): { ok: true; text: string } | { ok: false; error: string } {
  let out = text
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]
    if (!e.old) return { ok: false, error: `edit ${i + 1}: empty "old"` }
    const n = out.split(e.old).length - 1
    if (n !== 1) return { ok: false, error: `edit ${i + 1}: "old" text found ${n} times (must be exactly once)` }
    out = out.replace(e.old, () => e.new)
  }
  return { ok: true, text: out }
}

// ── diffs for previews ─────────────────────────────────────────────────────
export interface DiffHunk { before: string[]; after: string[]; context?: string }

/** Compact line-level diff. Handles same-line-count edits exactly; otherwise trims common prefix/suffix. */
export function lineDiff(a: string, b: string, maxHunks = 40): DiffHunk[] {
  const A = a.split(/\r?\n/), B = b.split(/\r?\n/)
  const hunks: DiffHunk[] = []
  if (A.length === B.length) {
    let i = 0
    while (i < A.length && hunks.length < maxHunks) {
      if (A[i] === B[i]) { i++; continue }
      const h: DiffHunk = { before: [], after: [], context: i > 0 ? A[i - 1].trim().slice(0, 120) : undefined }
      while (i < A.length && A[i] !== B[i]) { h.before.push(A[i]); h.after.push(B[i]); i++ }
      hunks.push(h)
    }
    return hunks
  }
  let p = 0
  while (p < A.length && p < B.length && A[p] === B[p]) p++
  let sa = A.length - 1, sb = B.length - 1
  while (sa >= p && sb >= p && A[sa] === B[sb]) { sa--; sb-- }
  hunks.push({ before: A.slice(p, sa + 1).slice(0, 400), after: B.slice(p, sb + 1).slice(0, 400), context: p > 0 ? A[p - 1].trim().slice(0, 120) : undefined })
  return hunks
}

/** Short human preview of what changed in a snippet. */
export function previewOf(before: string, after: string, max = 3) {
  return lineDiff(before, after, max).map(h => ({
    before: collapse(h.before.join(' ')).slice(0, 600),
    after: collapse(h.after.join(' ')).slice(0, 600),
    context: h.context,
  }))
}

/** FAQ Q/A pairs found in a snippet's JSON-LD. */
export function faqPairs(text: string): { q: string; a: string }[] {
  const out: { q: string; a: string }[] = []
  const walk = (o: any) => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o && typeof o === 'object') {
      if (o['@type'] === 'Question' && o.acceptedAnswer) {
        const a = Array.isArray(o.acceptedAnswer) ? o.acceptedAnswer[0] : o.acceptedAnswer
        out.push({ q: String(o.name || ''), a: String(a?.text || '') })
      }
      Object.keys(o).forEach(k => walk(o[k]))
    }
  }
  for (const b of jsonLdBlocks(text)) { try { walk(JSON.parse(b)) } catch {} }
  return out
}

export function visibleText(html: string): string {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<head[\s\S]*?<\/head>/gi, ' ')
  return decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export function normalizeForCompare(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim().toLowerCase()
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
}
