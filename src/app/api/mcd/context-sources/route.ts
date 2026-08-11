import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { spawn } from 'child_process'
import pathModule from 'path'
import {
  getMcdContextSources,
  addMcdContextSource,
  updateMcdContextSourceCache,
  toggleMcdContextSource,
  updateMcdContextSourceLabel,
  deleteMcdContextSource,
} from '@/lib/db'

const SCRIPTS_DIR  = process.env.MCD_SCRIPTS_DIR || '/root/agentic-os/mcd/scripts'
const VENV_PYTHON  = process.env.MCD_VENV_PYTHON  || '/root/agentic-os/mcd/venv/bin/python3'

// ── Parse a Google URL → { doc_id, doc_type } ────────────────────────────
function parseGoogleUrl(url: string): { doc_id: string; doc_type: 'doc' | 'sheet' } | null {
  try {
    const u = new URL(url)
    const docMatch  = u.pathname.match(/\/document\/d\/([^/]+)/)
    const sheetMatch= u.pathname.match(/\/spreadsheets\/d\/([^/]+)/)
    if (docMatch)   return { doc_id: docMatch[1],   doc_type: 'doc' }
    if (sheetMatch) return { doc_id: sheetMatch[1], doc_type: 'sheet' }
    return null
  } catch { return null }
}

// ── Fetch content via Python context_reader ───────────────────────────────
function fetchContent(docId: string, docType: 'doc' | 'sheet', tabName: string): Promise<{ content: string; ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const args = docType === 'doc'
      ? ['doc',   '--id', docId]
      : ['sheet', '--id', docId, ...(tabName ? ['--tab', tabName] : [])]

    const proc = spawn(VENV_PYTHON, [pathModule.join(SCRIPTS_DIR, 'context_reader.py'), ...args], {
      env: { ...process.env },
      timeout: 30_000,
    })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code === 0 && out.trim()) {
        resolve({ content: out.trim().slice(0, 20_000), ok: true })
      } else {
        resolve({ content: '', ok: false, error: err.slice(0, 500) || 'No output' })
      }
    })
    proc.on('error', e => resolve({ content: '', ok: false, error: e.message }))
  })
}

// ── GET — list all sources ────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json({ sources: getMcdContextSources() })
}

// ── POST — add a source or refresh one ───────────────────────────────────
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json().catch(() => ({}))

  // Refresh action: re-fetch content for an existing source
  if (body.action === 'refresh' && body.id) {
    const sources = getMcdContextSources()
    const src = sources.find(s => s.id === body.id)
    if (!src) return NextResponse.json({ error: 'Source not found' }, { status: 404 })

    const { content, ok, error: fetchErr } = await fetchContent(src.doc_id, src.doc_type as 'doc' | 'sheet', src.tab_name)
    if (!ok) return NextResponse.json({ error: `Failed to fetch: ${fetchErr}` }, { status: 502 })

    updateMcdContextSourceCache(src.id, content)
    return NextResponse.json({ ok: true, chars: content.length })
  }

  // Add new source
  const { url, label, tab_name = '' } = body
  if (!url || !label) return NextResponse.json({ error: 'url and label are required' }, { status: 400 })

  const parsed = parseGoogleUrl(url)
  if (!parsed) return NextResponse.json({ error: 'URL must be a Google Doc or Google Sheet URL' }, { status: 400 })

  const source = addMcdContextSource({ label, url, ...parsed, tab_name })

  // Fetch content immediately
  const { content, ok, error: fetchErr } = await fetchContent(parsed.doc_id, parsed.doc_type, tab_name)
  if (ok) {
    updateMcdContextSourceCache(source.id, content)
    return NextResponse.json({ ok: true, source: { ...source, content_cache: content, cached_at: new Date().toISOString() }, chars: content.length })
  } else {
    return NextResponse.json({ ok: true, source, warning: `Added but content fetch failed: ${fetchErr}` })
  }
}

// ── PATCH — toggle enabled or update label ────────────────────────────────
export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const { id, enabled, label } = body
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  if (typeof enabled === 'boolean') toggleMcdContextSource(id, enabled)
  if (typeof label === 'string' && label.trim()) updateMcdContextSourceLabel(id, label.trim())

  return NextResponse.json({ ok: true })
}

// ── DELETE — remove a source ──────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  deleteMcdContextSource(id)
  return NextResponse.json({ ok: true })
}
