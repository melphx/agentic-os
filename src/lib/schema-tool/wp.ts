/**
 * Schema Tool — client for the phr-schema/v1 REST API (HFCM snippets) on the configured WordPress site.
 * Server-side only.
 */
import { getConfig, SCHEMA_UA } from './config'

export interface Snippet {
  id: number
  name: string
  status: string
  location?: string
  display_on?: string
  s_pages?: number[]
  s_posts?: number[]
  page_urls?: string[]
  snippet: string
  last_revision_date?: string
}

export interface SnippetConfig {
  name: string
  display_on: string
  s_pages: number[]
  s_posts: number[]
  status: string
}

function authHeader(): Record<string, string> {
  const c = getConfig()
  if (!c.configured) throw new Error('Schema tool is not configured: set SCHEMA_TOOL_WP_USER and SCHEMA_TOOL_WP_APP_PASSWORD in .env.local')
  return {
    Authorization: 'Basic ' + Buffer.from(`${c.user}:${c.appPassword}`).toString('base64'),
    'User-Agent': SCHEMA_UA,
    Accept: 'application/json',
  }
}

async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const c = getConfig()
  const url = `${c.siteUrl}/wp-json/phr-schema/v1${path}`
  let lastErr: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: init?.method || 'GET',
        headers: { ...authHeader(), ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        cache: 'no-store',
      })
      const text = await res.text()
      let data: any
      try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 300) } }
      if (!res.ok) {
        const msg = data?.message || data?.error || data?.raw || res.statusText
        // 4xx are real errors — don't retry
        if (res.status >= 400 && res.status < 500) throw Object.assign(new Error(`WordPress ${res.status}: ${msg}`), { noRetry: true })
        throw new Error(`WordPress ${res.status}: ${msg}`)
      }
      return data as T
    } catch (e: any) {
      lastErr = e
      if (e?.noRetry) throw e
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw lastErr
}

function normalize(raw: any): Snippet {
  const arr = (v: any): number[] => {
    if (Array.isArray(v)) return v.map(Number).filter(n => !isNaN(n))
    if (typeof v === 'string' && v.trim().startsWith('[')) { try { return JSON.parse(v).map(Number) } catch { return [] } }
    return []
  }
  return {
    id: Number(raw.id),
    name: String(raw.name || ''),
    status: String(raw.status || ''),
    location: raw.location,
    display_on: raw.display_on,
    s_pages: arr(raw.s_pages),
    s_posts: arr(raw.s_posts),
    page_urls: Array.isArray(raw.page_urls) ? raw.page_urls : [],
    snippet: typeof raw.snippet === 'string' ? raw.snippet : '',
    last_revision_date: raw.last_revision_date,
  }
}

// ── small in-memory cache of the full snippet list (with code) ──────────────
let cache: { at: number; data: Snippet[] } | null = null
const TTL = 45_000

export async function listSnippets(opts?: { fresh?: boolean }): Promise<Snippet[]> {
  if (!opts?.fresh && cache && Date.now() - cache.at < TTL) return cache.data
  const raw = await api<any[]>('/snippets?with_snippet=1')
  const data = (Array.isArray(raw) ? raw : (raw as any)?.snippets || []).map(normalize)
  cache = { at: Date.now(), data }
  return data
}

export function invalidateCache() { cache = null }

export async function getSnippet(id: number): Promise<Snippet> {
  return normalize(await api(`/snippets/${id}`))
}

export async function saveSnippetCode(id: number, snippet: string): Promise<void> {
  await api(`/snippets/${id}`, { method: 'POST', body: { snippet } })
  invalidateCache()
}

export async function saveSnippetConfig(id: number, cfg: Partial<SnippetConfig> & { pages?: number[]; posts?: number[] }): Promise<void> {
  await api(`/snippets/${id}`, { method: 'POST', body: cfg })
  invalidateCache()
}

export function configOf(s: Snippet): SnippetConfig {
  return {
    name: s.name,
    display_on: s.display_on || '',
    s_pages: s.s_pages || [],
    s_posts: s.s_posts || [],
    status: s.status,
  }
}

/** Fetch a public page on the configured site (for render checks). */
export async function fetchPage(url: string): Promise<{ finalUrl: string; status: number; html: string }> {
  const sep = url.includes('?') ? '&' : '?'
  const res = await fetch(`${url}${sep}phr_nc=${Date.now()}`, { headers: { 'User-Agent': SCHEMA_UA }, redirect: 'follow', cache: 'no-store' })
  const html = await res.text()
  return { finalUrl: res.url.replace(/[?&]phr_nc=\d+/, ''), status: res.status, html }
}

export async function ping(): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const s = await listSnippets({ fresh: true })
    return { ok: true, count: s.length }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}
