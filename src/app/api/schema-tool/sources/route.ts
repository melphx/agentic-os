/**
 * /api/schema-tool/sources
 * GET                                   → connected sources (+ service-account email to share files with)
 * POST { url, label?, tab?, legend? }   → connect a Google Sheet / Doc and read it
 * POST { action: 'tabs', url }          → list a sheet's tabs (for the picker)
 */
import { NextRequest, NextResponse } from 'next/server'
import { addSource, listSources, listTabs, parseGoogleUrl, serviceAccountEmail, DEFAULT_LEGEND } from '@/lib/schema-tool/sources'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

let saCache: { at: number; email: string | null } | null = null

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    if (!saCache || Date.now() - saCache.at > 3600_000) saCache = { at: Date.now(), email: await serviceAccountEmail() }
    const sources = listSources().map(s => {
      const rows = s.rows_json ? Object.keys(JSON.parse(s.rows_json)).length : 0
      const { content, rows_json, ...rest } = s
      return { ...rest, row_count: rows, changes: s.changes ? JSON.parse(s.changes) : null }
    })
    return NextResponse.json({ sources, service_account: saCache.email, default_legend: DEFAULT_LEGEND })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { email, error } = await guard(req); if (error) return error
  try {
    const body = await req.json()
    if (body.action === 'tabs') {
      const p = parseGoogleUrl(String(body.url || ''))
      if (!p) return NextResponse.json({ error: 'Paste a Google Sheets or Google Docs link.' }, { status: 400 })
      if (p.doc_type !== 'sheet') return NextResponse.json({ doc_type: 'doc', tabs: [] })
      try { return NextResponse.json({ doc_type: 'sheet', ...(await listTabs(p.doc_id)) }) } catch (e) { return fail(e, 400) }
    }
    const s = await addSource({ url: String(body.url || ''), label: body.label, tab: body.tab, legend: body.legend, by: email })
    return NextResponse.json({ source: { ...s, content: undefined, rows_json: undefined } })
  } catch (e) { return fail(e, 400) }
}
