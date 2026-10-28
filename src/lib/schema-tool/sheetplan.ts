/**
 * Schema Tool — where each row of the sameAs sheet belongs (deterministic, no AI guessing).
 *
 * Column A of the team's sameAs sheet says where a URL goes ("SAMEAS - All Pages",
 * "MENTIONS - Kitchen - Mesa", "MENTIONS - All Chandler Service Pages", "NO", …). This turns a row
 * into the exact list of snippets it applies to, and says which of them already contain the URL,
 * so the assistant never has to work out (or forget) the page list itself.
 */
import { getConfig } from './config'
import { listSnippets, Snippet } from './wp'
import { cellText, getSource, SourceRow, writebackOf } from './sources'
import { getItems, ItemFull, listChangesets } from './store'

/** Pages that never get links: retired sections and metro-wide pages that only look like city pages. */
export const RETIRED_PATHS = ['/services/kitchen-bath-renovation/']

const SERVICE_SLUGS: [RegExp, string][] = [
  [/^bath(room)?$/i, 'bathroom-remodel'],
  [/^kitchen$/i, 'kitchen-remodel'],
  [/^shower$/i, 'shower-remodeling'],
  [/^(gc|general contractor)$/i, 'general-contractor'],
  [/^home( remodel(ing)?)?$/i, 'home-remodeling'],
  [/^laundry( room)?$/i, 'laundry-room-remodeling'],
  [/^(designer|home remodel designer|design)$/i, 'home-remodel-designer'],
  [/^entertainment( wall)?$/i, 'entertainment-wall-remodel'],
  [/^home improvement$/i, 'home-improvement-contractor'],
]

export type Placement = 'Organization sameAs' | 'Organization subjectOf' | 'Jeremy Person subjectOf' | 'Service subjectOf' | 'remove'

export interface RowTarget { snippet_id: number; path: string; place: Placement; has_url: boolean; has_old_url?: boolean }
export interface RowPlan {
  row: number; type: string; url: string; old_url?: string; status: string; note: string
  action: 'nothing to do' | 'add' | 'remove' | 'replace old link' | 'no page' | 'needs judgement' | 'not a link row'
  targets: RowTarget[]
  missing: number[]              // target snippets that don't have the URL yet
  unexpected?: { snippet_id: number; path: string }[]   // URL found where column A doesn't put it
  reason?: string
}

export const normUrl = (u: string) => u.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/\/+$/, '')

/** Does the snippet contain this URL (ignoring http/https, www and a trailing slash)? */
export function snippetHas(text: string, url: string): boolean {
  if (!url) return false
  const n = normUrl(url)
  const hay = text.toLowerCase().replace(/\\\//g, '/')
  const re = new RegExp(`https?://(www\\.)?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(?=["'\\s,<\\]])`)
  return re.test(hay)
}

const pathOf = (name: string) => name.replace(/^https?:\/\/[^/]+/, '') || '/'
const citySlug = (c: string) => c.trim().toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')
const isRetired = (s: Snippet) => RETIRED_PATHS.some(p => pathOf(s.name).startsWith(p))

function definesOrganization(s: Snippet): boolean {
  const org = `${getConfig().prodOrigin}/#organization`
  // a full definition (not just a {"@id": …} reference): the node carries the company's own fields
  let found = false
  const walk = (o: any) => {
    if (found || !o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o['@id'] === org && (o.address || o.legalName || o.telephone)) { found = true; return }   // a short stub (name/url/sameAs) doesn't count
    Object.keys(o).forEach(k => walk(o[k]))
  }
  const re = /<script[^>]*ld\+json[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(s.snippet)) && !found) { try { walk(JSON.parse(m[1])) } catch {} }
  return found
}

export function serviceSlug(word: string): string | null {
  const w = word.trim()
  for (const [re, slug] of SERVICE_SLUGS) if (re.test(w)) return slug
  return null
}

/** Rows of a sheet that hold a link (skips headers, section titles and blank rows). */
export function linkRows(src: SourceRow): number[] {
  const rows: Record<string, string> = src.rows_json ? JSON.parse(src.rows_json) : {}
  return Object.keys(rows).map(k => Number(k.slice(1))).filter(r => r >= 3 && /^https?:\/\//.test(cellText(src, r, 'B'))).sort((a, b) => a - b)
}

export async function planRows(sourceId: number, rowNumbers: number[] | 'pending'): Promise<{ source: SourceRow; plans: RowPlan[] }> {
  const src = getSource(sourceId)
  if (!src) throw new Error('Source not found')
  const wb = writebackOf(src)
  const all = (await listSnippets()).filter(s => s.status === 'active' && !isRetired(s))
  const prod = getConfig().prodOrigin
  const home = all.find(s => s.name === `${prod}/` || s.name === prod)
  const author = all.find(s => /\/author-jeremy-maher\/?$/.test(s.name))
  const orgDefs = all.filter(definesOrganization)
  const rows = rowNumbers === 'pending'
    ? linkRows(src).filter(r => !wb || !cellText(src, r, wb.status_col))
    : rowNumbers

  const plans: RowPlan[] = []
  for (const row of rows) {
    const type = cellText(src, row, 'A')
    const url = cellText(src, row, 'B')
    const cText = cellText(src, row, 'C')
    const status = wb ? cellText(src, row, wb.status_col) : ''
    const note = wb ? cellText(src, row, wb.note_col) : ''
    const old = /old/i.test(cText) ? (cText.match(/https?:\/\/[^\s"]+/) || [])[0] : undefined
    const base: RowPlan = { row, type, url, old_url: old, status, note, action: 'needs judgement', targets: [], missing: [] }
    if (!/^https?:\/\//.test(url)) { plans.push({ ...base, action: 'not a link row', reason: 'column B has no URL' }); continue }

    const T = (list: Snippet[], place: Placement): RowTarget[] => list.map(s => ({ snippet_id: s.id, path: pathOf(s.name), place, has_url: snippetHas(s.snippet, url), ...(old ? { has_old_url: snippetHas(s.snippet, old) } : {}) }))
    const typeClean = type.replace(/\s+/g, ' ').trim()
    const A = typeClean.toUpperCase()
    let targets: RowTarget[] = []
    let reason: string | undefined

    if (A === 'NO') {
      const found = all.filter(s => snippetHas(s.snippet, url))
      plans.push({ ...base, action: found.length ? 'remove' : 'nothing to do', targets: T(found, 'remove'), missing: [], reason: found.length ? `marked NO but found in ${found.length} snippet(s) — remove it` : 'marked NO and not in any schema' })
      continue
    }
    if (/^SAMEAS - ALL PAGES/.test(A)) targets = T(orgDefs, 'Organization sameAs')
    else if (/^SAMEAS - HOMEPAGE ONLY/.test(A)) targets = home ? T([home], 'Organization sameAs') : []
    else if (/^MENTIONS - HOMEPAGE ONLY/.test(A)) targets = home ? T([home], 'Organization subjectOf') : []
    else if (/^SUBJECTOF - HOMEPAGE \+ AUTHOR PAGE/.test(A)) targets = [...(home ? T([home], 'Organization subjectOf') : []), ...(author ? T([author], 'Jeremy Person subjectOf') : [])]
    else {
      const allCity = typeClean.match(/^MENTIONS - All (.+?) Service Pages$/i)
      const svcCity = typeClean.match(/^MENTIONS - (.+?) - (.+)$/i)
      if (allCity) {
        const city = citySlug(allCity[1])
        const list = all.filter(s => new RegExp(`^/services/[a-z-]+/${city}-az/?$`).test(pathOf(s.name)))
        targets = T(list, 'Service subjectOf')
        if (!list.length) reason = `no active service pages for ${allCity[1]}`
      } else if (svcCity) {
        const slug = serviceSlug(svcCity[1])
        const cityWord = svcCity[2].trim()
        if (!slug) { plans.push({ ...base, reason: `unknown service "${svcCity[1]}" in column A` }); continue }
        if (/^ALL CITIES$/i.test(cityWord)) {
          const list = all.filter(s => new RegExp(`^/services/${slug}/[a-z-]+-az/?$`).test(pathOf(s.name)))
          targets = T(list, 'Service subjectOf')
          if (!list.length) reason = `no city pages for /services/${slug}/`
        } else {
          const city = citySlug(cityWord)
          const page = all.find(s => new RegExp(`^/services/${slug}/${city}-az/?$`).test(pathOf(s.name)))
          targets = page ? T([page], 'Service subjectOf') : []
          if (!page) reason = `no ${svcCity[1]} page for ${cityWord} (/services/${slug}/${city}-az/ doesn't exist)`
        }
      } else {
        plans.push({ ...base, reason: `column A "${type}" isn't a type this knows` }); continue
      }
    }

    const missing = targets.filter(t => !t.has_url).map(t => t.snippet_id)
    const targetIds = new Set(targets.map(t => t.snippet_id))
    const unexpected = all.filter(s => !targetIds.has(s.id) && snippetHas(s.snippet, url)).map(s => ({ snippet_id: s.id, path: pathOf(s.name) }))
    const oldLeft = old ? targets.filter(t => t.has_old_url).length + all.filter(s => !targetIds.has(s.id) && snippetHas(s.snippet, old)).length : 0
    const action: RowPlan['action'] = !targets.length ? 'no page' : oldLeft ? 'replace old link' : missing.length ? 'add' : 'nothing to do'
    plans.push({ ...base, action, targets, missing, ...(unexpected.length ? { unexpected } : {}), reason })
  }
  return { source: src, plans }
}

/** Compact text for the assistant. */
export function plansForAssistant(plans: RowPlan[]): any[] {
  return plans.map(p => ({
    row: p.row, type: p.type, url: p.url, ...(p.old_url ? { old_url: p.old_url } : {}),
    current_status: p.status || '(blank)', action: p.action, ...(p.reason ? { reason: p.reason } : {}),
    place: p.targets[0]?.place,
    targets: p.targets.length > 12
      ? { count: p.targets.length, missing_url: p.missing, already_have_it: p.targets.length - p.missing.length }
      : p.targets.map(t => `#${t.snippet_id} ${t.path}${t.has_url ? ' (has it)' : ''}${t.has_old_url ? ' (has OLD link)' : ''}`),
    ...(p.unexpected ? { also_found_in: p.unexpected.map(u => `#${u.snippet_id} ${u.path}`) } : {}),
  }))
}

/** URL present in the snippet now, or in a change staged in this chat that is still waiting to be applied. */
export async function coverageGaps(sourceId: number, rows: { row: number; status?: string }[], conversationId: string): Promise<string[]> {
  const added = rows.filter(r => r.status === 'Added').map(r => r.row)
  if (!added.length) return []
  const { plans } = await planRows(sourceId, added)
  const staged: Record<number, string[]> = {}
  for (const cs of listChangesets(200, conversationId).filter(c => c.status === 'proposed' || c.status === 'applying')) {
    for (const it of getItems(cs.id, true) as ItemFull[]) if (it.item_type === 'code' && it.after) (staged[it.snippet_id] = staged[it.snippet_id] || []).push(it.after)
  }
  const gaps: string[] = []
  for (const p of plans) {
    if (p.action === 'needs judgement' || p.action === 'not a link row') continue
    if (!p.targets.length) { gaps.push(`row ${p.row}: ${p.reason || 'no page to put it on'} — mark it Not Added with that reason instead`); continue }
    const still = p.missing.filter(id => !(staged[id] || []).some(t => snippetHas(t, p.url)))
    if (still.length) gaps.push(`row ${p.row}: link not on ${still.length} target snippet(s) yet: ${still.map(i => '#' + i).join(', ')}`)
  }
  return gaps
}
