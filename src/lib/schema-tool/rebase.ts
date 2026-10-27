/**
 * Schema Tool — apply a staged change on top of a snippet that changed since it was staged.
 *
 * Several changesets often touch the same snippet (e.g. five fixes to one city page). Each was
 * computed from the same original text, so once one is applied the others no longer match.
 * Instead of refusing, we re-apply the change to the current text:
 *   1. find & replace changesets: run the same find/replace (same context rules) on the current text
 *   2. exact edits: re-apply each old → new edit (an edit already present counts as done)
 *   3. anything else: line-based three-way merge (fails only if both changes touch the same lines)
 */
import { applyExactEdits, planReplace } from './engine'
import { Snippet } from './wp'

// ── three-way line merge ───────────────────────────────────────────────────
interface Hunk { s: number; e: number; lines: string[] }   // replace base lines [s, e) with lines

/** Hunks that turn `a` into `b` (line-level LCS after trimming the common prefix/suffix). */
function hunks(a: string[], b: string[]): Hunk[] | null {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf)
  if (!A.length && !B.length) return []
  if (A.length * B.length > 16_000_000) return null
  // LCS table (lengths of LCS of suffixes)
  const n = A.length, m = B.length
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: Hunk[] = []
  let i = 0, j = 0, cur: Hunk | null = null
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { if (cur) { out.push(cur); cur = null } i++; j++; continue }
    if (!cur) cur = { s: pre + i, e: pre + i, lines: [] }
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { cur.lines.push(B[j]); j++ }
    else { i++; cur.e = pre + i }
  }
  if (cur) out.push(cur)
  return out
}

const overlaps = (x: Hunk, y: Hunk) => (x.s < y.e && y.s < x.e) || x.s === y.s || (x.s === x.e && x.s > y.s && x.s < y.e) || (y.s === y.e && y.s > x.s && y.s < x.e)
const same = (x: Hunk, y: Hunk) => x.s === y.s && x.e === y.e && x.lines.join('\n') === y.lines.join('\n')

/** Merge the change base→mine into theirs (= base + other changes). null = real conflict. */
export function mergeText(base: string, mine: string, theirs: string): string | null {
  const B = base.split('\n'), M = mine.split('\n'), T = theirs.split('\n')
  const hm = hunks(B, M), ht = hunks(B, T)
  if (!hm || !ht) return null
  const all: Hunk[] = []
  for (const h of hm) {
    const clash = ht.filter(t => overlaps(h, t))
    if (clash.length && !clash.every(t => same(h, t))) return null
    if (!clash.length) all.push(h)
  }
  all.push(...ht)
  all.sort((x, y) => x.s - y.s || x.e - y.e)
  const out: string[] = []
  let pos = 0
  for (const h of all) {
    if (h.s < pos) return null
    out.push(...B.slice(pos, h.s), ...h.lines)
    pos = h.e
  }
  out.push(...B.slice(pos))
  return out.join('\n')
}

// ── rebase one staged item onto the current snippet text ───────────────────
export type Rebased = { ok: true; text: string; how: string; mentions?: number } | { ok: false; reason: string }

export function rebaseCode(opts: {
  kind: string; meta: any; snippet: Snippet; base: string; mine: string; live: string; semantic?: boolean
}): Rebased {
  const { kind, meta, snippet, base, mine, live } = opts
  const semantic = opts.semantic !== false
  if (semantic && kind === 'replace' && meta && typeof meta.find === 'string') {
    const plan = planReplace([{ ...snippet, snippet: live }], {
      find: meta.find, replace: String(meta.replace ?? ''), regex: !!meta.regex, caseSensitive: meta.case_sensitive !== false,
      wholeWord: !!meta.whole_word, requireContext: meta.require_context, excludeContext: meta.exclude_context, onlyIds: [snippet.id], activeOnly: false,
    })
    if (!plan.items.length) return { ok: true, text: live, how: 'nothing left to change' }
    return { ok: true, text: plan.items[0].after, how: 're-ran the find & replace on the current snippet', mentions: plan.items[0].mentions }
  }
  if (semantic && meta?.edits && Array.isArray(meta.edits[String(snippet.id)])) {
    let text = live, done = 0
    let failed = false
    for (const e of meta.edits[String(snippet.id)] as { old: string; new: string }[]) {
      const r = applyExactEdits(text, [e])
      if (r.ok) { text = r.text; done++; continue }
      if (e.new && text.indexOf(e.new) >= 0 && text.indexOf(e.old) < 0) continue   // already applied
      failed = true; break
    }
    if (!failed) return { ok: true, text, how: done ? 're-applied the edits on the current snippet' : 'edits were already there', mentions: done }
  }
  const merged = mergeText(base, mine, live)
  if (merged == null) return { ok: false, reason: 'Another change edited the same lines — ask the assistant to redo this one on the current snippet' }
  return { ok: true, text: merged, how: 'merged with newer changes' }
}

/** Config (name / placement / status): apply only the fields this change touched. */
export function rebaseConfig<C extends Record<string, any>>(base: C, mine: C, live: C): { ok: true; value: C } | { ok: false; reason: string } {
  const out: any = { ...live }
  for (const k of Object.keys(mine)) {
    const b = JSON.stringify(base[k]), m = JSON.stringify(mine[k]), l = JSON.stringify(live[k])
    if (m === b) continue           // not part of this change
    if (l === b || l === m) { out[k] = mine[k]; continue }
    return { ok: false, reason: `"${k}" was changed by someone else since this was staged` }
  }
  return { ok: true, value: out }
}
