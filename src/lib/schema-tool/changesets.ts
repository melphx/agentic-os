/**
 * Schema Tool — build, apply and revert changesets.
 * Apply/revert run in the background (in-process) and update item rows as they go;
 * the UI polls the changeset to show progress.
 */
import { getConfig } from './config'
import { configOf, getSnippet, invalidateCache, listSnippets, saveSnippetCode, saveSnippetConfig, Snippet, SnippetConfig } from './wp'
import { previewOf, validateSnippet, outsideScripts, ReplacePlan } from './engine'
import {
  createChangeset, getChangeset, getItems, ItemFull, NewItem, setChangesetStatus, setItemStatus, setItemsSelected, updateItemContent,
} from './store'
import { rebaseCode, rebaseConfig } from './rebase'

export interface CsMeta { [k: string]: unknown }

export function changesetFromPlan(plan: ReplacePlan, info: { title: string; summary?: string; kind?: string; source?: string; conversation_id?: string | null; created_by?: string | null; meta?: CsMeta }): number | null {
  if (!plan.items.length) return null
  const items: NewItem[] = plan.items.map(p => ({
    snippet_id: p.snippet.id,
    snippet_name: p.snippet.name,
    item_type: 'code',
    before: p.snippet.snippet,
    after: p.after,
    mentions: p.mentions,
    preview: p.samples.length ? p.samples.map(s => ({ before: `${s.before}${s.match}${s.after}`, after: `${s.before}${s.replacement}${s.after}`, match: s.match, replacement: s.replacement, question: s.question })) : previewOf(p.snippet.snippet, p.after),
  }))
  return createChangeset({
    site: getConfig().siteUrl, title: info.title, summary: info.summary, kind: info.kind || 'replace', source: info.source || 'chat',
    conversation_id: info.conversation_id, created_by: info.created_by,
    meta: { ...(info.meta || {}), skipped: plan.skipped.slice(0, 60), skipped_count: plan.skipped.length, invalid: plan.invalid },
  }, items)
}

export function changesetFromEdits(edits: { snippet: Snippet; after: string; mentions?: number }[], info: { title: string; summary?: string; kind?: string; source?: string; conversation_id?: string | null; created_by?: string | null; meta?: CsMeta }): number {
  for (const e of edits) {
    const v = validateSnippet(e.after)
    if (!v.ok) throw new Error(`Snippet #${e.snippet.id}: ${v.error}`)
  }
  return createChangeset({
    site: getConfig().siteUrl, title: info.title, summary: info.summary, kind: info.kind || 'edit', source: info.source || 'chat',
    conversation_id: info.conversation_id, created_by: info.created_by, meta: info.meta,
  }, edits.map(e => ({
    snippet_id: e.snippet.id, snippet_name: e.snippet.name, item_type: 'code' as const,
    before: e.snippet.snippet, after: e.after, mentions: e.mentions ?? 1, preview: previewOf(e.snippet.snippet, e.after),
  })))
}

export function changesetFromConfig(changes: { snippet: Snippet; after: SnippetConfig; note: string }[], info: { title: string; summary?: string; conversation_id?: string | null; created_by?: string | null; source?: string }): number {
  return createChangeset({
    site: getConfig().siteUrl, title: info.title, summary: info.summary, kind: 'config', source: info.source || 'chat',
    conversation_id: info.conversation_id, created_by: info.created_by,
  }, changes.map(c => {
    const before = configOf(c.snippet)
    return {
      snippet_id: c.snippet.id, snippet_name: c.snippet.name, item_type: 'config' as const,
      before: JSON.stringify(before), after: JSON.stringify(c.after), mentions: 1,
      preview: [{ before: describeConfig(before), after: describeConfig(c.after), context: c.note }],
    }
  }))
}

export function describeConfig(c: SnippetConfig): string {
  const where = c.display_on === 's_pages' ? `pages ${JSON.stringify(c.s_pages)}` : c.display_on === 's_posts' ? `posts ${JSON.stringify(c.s_posts)}` : c.display_on || '—'
  return `${c.status} · ${c.name} · shows on ${where}`
}

// ── apply / revert ─────────────────────────────────────────────────────────
const running = new Set<number>()

function sameConfig(a: SnippetConfig, b: SnippetConfig) {
  return a.name === b.name && a.display_on === b.display_on && a.status === b.status &&
    JSON.stringify(a.s_pages) === JSON.stringify(b.s_pages) && JSON.stringify(a.s_posts) === JSON.stringify(b.s_posts)
}

type WriteResult = { r: 'applied' | 'conflict' | 'noop'; note?: string }

/**
 * Write one item. If the snippet changed since the item was staged (usually another change to the same
 * snippet was applied first), the change is re-applied on top of the current text instead of refused.
 */
async function writeItem(it: ItemFull, target: string, expectCurrent: string, force: boolean, how: { mode: 'apply' | 'revert'; kind: string; meta: any }): Promise<WriteResult> {
  const live = await getSnippet(it.snippet_id)
  if (it.item_type === 'config') {
    const cur = configOf(live)
    let want = JSON.parse(target) as SnippetConfig
    const exp = JSON.parse(expectCurrent) as SnippetConfig
    let note: string | undefined
    if (!force && !sameConfig(cur, exp)) {
      const rb = rebaseConfig(exp as any, want as any, cur as any)
      if (!rb.ok) return { r: 'conflict', note: rb.reason }
      want = rb.value as any
      note = 'applied on top of newer changes'
    }
    if (sameConfig(cur, want)) return { r: 'noop', note: 'already had these settings' }
    const body: any = { name: want.name, status: want.status, display_on: want.display_on, s_pages: want.s_pages, s_posts: want.s_posts }
    await saveSnippetConfig(it.snippet_id, body)
    const after = configOf(await getSnippet(it.snippet_id))
    if (!sameConfig(after, want)) throw new Error('saved, but WordPress returned a different configuration')
    if (note && how.mode === 'apply') updateItemContent(it.id, JSON.stringify(cur), JSON.stringify(want))
    return { r: 'applied', note }
  }
  if (live.snippet === target) return { r: 'noop', note: 'already had this content' }
  let text = target, note: string | undefined, mentions: number | undefined
  if (!force && live.snippet !== expectCurrent) {
    const rb = rebaseCode({ kind: how.kind, meta: how.meta, snippet: live, base: expectCurrent, mine: target, live: live.snippet, semantic: how.mode === 'apply' })
    if (!rb.ok) return { r: 'conflict', note: rb.reason }
    if (rb.text === live.snippet) return { r: 'noop', note: rb.how }
    text = rb.text; note = rb.how; mentions = rb.mentions
  }
  const v = validateSnippet(text)
  if (!v.ok) throw new Error(v.error)
  if (!force && outsideScripts(text) !== outsideScripts(live.snippet)) throw new Error('change would alter text outside JSON-LD')
  await saveSnippetCode(it.snippet_id, text)
  const check = await getSnippet(it.snippet_id)
  if (check.snippet !== text) throw new Error('saved, but WordPress returned different content')
  if (note && how.mode === 'apply') updateItemContent(it.id, live.snippet, text, mentions)
  return { r: 'applied', note }
}

function checkApplicable(changesetId: number): string | null {
  const cs = getChangeset(changesetId)
  if (!cs) return 'not found'
  if (running.has(changesetId)) return 'already running'
  if (!['proposed', 'partial', 'failed'].includes(cs.status)) return `changeset is ${cs.status}`
  return null
}

async function runApply(changesetId: number, opts?: { force?: boolean }) {
  let ok = 0, bad = 0
  try {
    const cs = getChangeset(changesetId)!
    const meta = cs.meta ? JSON.parse(cs.meta) : {}
    const items = (getItems(changesetId, true) as ItemFull[]).filter(i => i.selected && ['pending', 'conflict', 'failed'].includes(i.status))
    for (const it of items) {
      try {
        const w = await writeItem(it, it.after || '', it.before || '', !!opts?.force, { mode: 'apply', kind: cs.kind, meta })
        if (w.r === 'conflict') { setItemStatus(it.id, 'conflict', w.note || 'Snippet changed since this was proposed — re-run the request'); bad++ }
        else { setItemStatus(it.id, 'applied', w.note || null); ok++ }
      } catch (e: any) { setItemStatus(it.id, 'failed', e?.message || String(e)); bad++ }
    }
    const all = getItems(changesetId) as any[]
    for (const it of all) if (!it.selected && it.status === 'pending') setItemStatus(it.id, 'skipped')
    const done = (getItems(changesetId) as any[]).filter(i => i.selected)
    const allOk = done.every(i => i.status === 'applied')
    setChangesetStatus(changesetId, allOk ? 'applied' : done.some(i => i.status === 'applied') ? 'partial' : 'failed', { applied: ok > 0 })
  } catch {
    setChangesetStatus(changesetId, 'failed')
  } finally {
    running.delete(changesetId)
    invalidateCache()
  }
}

export function startApply(changesetId: number, opts?: { itemIds?: number[] | null; force?: boolean }): { started: boolean; reason?: string } {
  const why = checkApplicable(changesetId)
  if (why) return { started: false, reason: why }
  if (opts?.itemIds !== undefined) setItemsSelected(changesetId, opts.itemIds)
  running.add(changesetId)
  setChangesetStatus(changesetId, 'applying')
  void runApply(changesetId, opts)
  return { started: true }
}

/** Apply several changesets one after another (oldest first), e.g. "Apply all" in a chat. */
export function startApplyMany(ids: number[]): { started: number[]; skipped: { id: number; reason: string }[] } {
  const started: number[] = [], skipped: { id: number; reason: string }[] = []
  for (const id of Array.from(new Set(ids)).sort((a, b) => a - b)) {
    const why = checkApplicable(id)
    if (why) { skipped.push({ id, reason: why }); continue }
    running.add(id)
    setChangesetStatus(id, 'applying')
    started.push(id)
  }
  void (async () => { for (const id of started) await runApply(id) })()
  return { started, skipped }
}

/** Revert applied items back to their "before" content (only if nobody changed them since). */
export function startRevert(changesetId: number, opts?: { force?: boolean; by?: string | null }): { started: boolean; reason?: string } {
  const cs = getChangeset(changesetId)
  if (!cs) return { started: false, reason: 'not found' }
  if (running.has(changesetId)) return { started: false, reason: 'busy' }
  if (!['applied', 'partial', 'revert_partial'].includes(cs.status)) return { started: false, reason: `changeset is ${cs.status}` }
  running.add(changesetId)
  setChangesetStatus(changesetId, 'reverting')
  void (async () => {
    let ok = 0, bad = 0
    try {
      const items = (getItems(changesetId, true) as ItemFull[]).filter(i => i.status === 'applied')
      for (const it of items) {
        try {
          const w = await writeItem(it, it.before || '', it.after || '', !!opts?.force, { mode: 'revert', kind: cs.kind, meta: null })
          if (w.r === 'conflict') { setItemStatus(it.id, 'applied', 'Not reverted: a later change edited the same lines'); bad++ }
          else { setItemStatus(it.id, 'reverted'); ok++ }
        } catch (e: any) { setItemStatus(it.id, 'applied', 'Revert failed: ' + (e?.message || String(e))); bad++ }
      }
      setChangesetStatus(changesetId, bad === 0 ? 'reverted' : ok > 0 ? 'revert_partial' : cs.status, { reverted: ok > 0 })
    } finally {
      running.delete(changesetId)
      invalidateCache()
    }
  })()
  return { started: true }
}

export function isRunning(id: number) { return running.has(id) }

export async function snapshot(fresh = false) { return listSnippets({ fresh }) }
