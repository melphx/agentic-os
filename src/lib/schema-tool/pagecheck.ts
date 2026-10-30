/**
 * Schema Tool — check what schema a page actually outputs on the configured site.
 */
import { toSiteUrl } from './config'
import { fetchPage, listSnippets } from './wp'
import { decodeEntities, faqPairs, jsonLdBlocks, normalizeForCompare, visibleText } from './engine'

export interface PageCheck {
  url: string
  finalUrl: string
  status: number
  pageId: number | null
  pageType: 'page' | 'post' | null
  canonical: string | null
  hfcmSnippets: { id: number; name: string }[]
  expectedSnippets: { id: number; name: string; showing: boolean }[]
  jsonLd: { source: string; types: string[]; valid: boolean; error?: string }[]
  /** FAQ items in the page's JSON-LD schema, and which of them don't match the visible page */
  faq: { total: number; mismatched: { q: string; reason: string }[] }
  /** FAQ questions + answers visible in the page HTML (accordions, <details>, question headings) */
  visibleFaq: { count: number; items: { q: string; a: string }[] }
}

/** Extract the FAQ a visitor sees: GenerateBlocks / generic accordions, <details>, and question headings. */
export function extractVisibleFaq(html: string): { q: string; a: string }[] {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  const text = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  const items: { q: string; a: string }[] = []
  const seen: Record<string, boolean> = {}
  const add = (q: string, a: string) => {
    const k = q.toLowerCase()
    if (q.length < 8 || q.length > 300 || seen[k]) return
    seen[k] = true; items.push({ q, a: a.slice(0, 2000) })
  }
  // 1. accordions (GenerateBlocks: toggle + content; also generic "accordion" markup)
  const accRe = /<[^>]+class="[^"]*accordion__toggle[^"]*"[^>]*>([\s\S]*?)<[^>]+class="[^"]*accordion__content[^"]*"[^>]*>([\s\S]*?)(?=<[^>]+class="[^"]*accordion__(?:item|toggle)[^"]*"|<\/section>|$)/gi
  let m: RegExpExecArray | null
  while ((m = accRe.exec(body))) add(text(m[1]), text(m[2]))
  // 2. <details><summary>Q</summary>A</details>
  const detRe = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi
  while ((m = detRe.exec(body))) add(text(m[1]), text(m[2]))
  // 3. headings that are questions, answer = text until the next heading
  const hRe = /<h([2-5])[^>]*>([\s\S]*?)<\/h\1>([\s\S]*?)(?=<h[1-5][^>]*>|$)/gi
  while ((m = hRe.exec(body))) { const q = text(m[2]); if (/\?$/.test(q)) add(q, text(m[3]).slice(0, 1500)) }
  return items
}

function typesOf(o: any, acc: Set<string>) {
  if (Array.isArray(o)) { o.forEach(x => typesOf(x, acc)); return }
  if (o && typeof o === 'object') {
    const t = o['@type']
    if (typeof t === 'string') acc.add(t)
    else if (Array.isArray(t)) acc.add(t.join('/'))
    Object.keys(o).forEach(k => typesOf(o[k], acc))
  }
}

export async function checkPage(inputUrl: string): Promise<PageCheck> {
  const url = toSiteUrl(inputUrl)
  const { finalUrl, status, html } = await fetchPage(url)
  const pid = html.match(/\bpage-id-(\d+)\b/) || html.match(/\bpostid-(\d+)\b/)
  const pageType = /\bpage-id-\d+/.test(html) ? 'page' : /\bpostid-\d+/.test(html) ? 'post' : null
  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || html.match(/og:url["']\s+content=["']([^"']+)/i) || [])[1] || null

  const hfcmIds: number[] = []
  const re = /HFCM by 99 Robots - Snippet\s*#\s*(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) if (hfcmIds.indexOf(Number(m[1])) < 0) hfcmIds.push(Number(m[1]))

  const snippets = await listSnippets()
  const byId: Record<number, string> = {}
  snippets.forEach(s => { byId[s.id] = s.name })
  const path = finalUrl.replace(/^https?:\/\/[^/]+/, '').replace(/\/?$/, '/')
  const expected = snippets.filter(s => s.status === 'active' && s.name.replace(/^https?:\/\/[^/]+/, '').replace(/\/?$/, '/') === path)

  // JSON-LD blocks with their origin
  const blocks: PageCheck['jsonLd'] = []
  const scriptRe = /<script([^>]*application\/ld\+json[^>]*)>([\s\S]*?)<\/script>/gi
  while ((m = scriptRe.exec(html))) {
    const before = html.slice(0, m.index)
    const lastOpen = before.lastIndexOf('HFCM by 99 Robots - Snippet')
    const lastClose = before.lastIndexOf('/end HFCM')
    const src = /rank-math/i.test(m[1]) ? 'Rank Math' : lastOpen > lastClose ? 'HFCM' : 'Page content'
    const acc = new Set<string>()
    try { typesOf(JSON.parse(m[2]), acc); blocks.push({ source: src, types: Array.from(acc).slice(0, 15), valid: true }) }
    catch (e: any) { blocks.push({ source: src, types: [], valid: false, error: e?.message }) }
  }

  // FAQ comparison against visible text
  const vis = normalizeForCompare(visibleText(html))
  const pairs = jsonLdBlocks(html).map(b => `<script type="application/ld+json">${b}</script>`).map(faqPairs).reduce((a, b) => a.concat(b), [] as { q: string; a: string }[])
  const mismatched: { q: string; reason: string }[] = []
  for (const p of pairs) {
    const q = normalizeForCompare(p.q), a = normalizeForCompare(p.a)
    if (q && vis.indexOf(q) < 0) mismatched.push({ q: p.q, reason: 'question not on page' })
    else if (a && vis.indexOf(a) < 0) mismatched.push({ q: p.q, reason: 'answer differs from page' })
  }

  return {
    url, finalUrl, status,
    pageId: pid ? Number(pid[1]) : null,
    pageType,
    canonical,
    hfcmSnippets: hfcmIds.map(id => ({ id, name: byId[id] || '' })),
    expectedSnippets: expected.map(s => ({ id: s.id, name: s.name, showing: hfcmIds.indexOf(s.id) >= 0 })),
    jsonLd: blocks,
    faq: { total: pairs.length, mismatched },
    visibleFaq: (() => { const v = extractVisibleFaq(html); return { count: v.length, items: v } })(),
  }
}
