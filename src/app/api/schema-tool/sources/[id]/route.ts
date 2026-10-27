/**
 * /api/schema-tool/sources/:id
 * GET                                          → source incl. the text the assistant reads
 * POST { action: 'refresh' }                   → re-read from Google (tracks rows added/changed/removed)
 * POST { label?, tab?, legend?, enabled? }     → update settings
 * DELETE                                       → disconnect
 */
import { NextRequest, NextResponse } from 'next/server'
import { deleteSource, getSource, refreshSource, updateSource } from '@/lib/schema-tool/sources'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const view = (s: any) => s && ({ ...s, rows_json: undefined, row_count: s.rows_json ? Object.keys(JSON.parse(s.rows_json)).length : 0, changes: s.changes ? JSON.parse(s.changes) : null })

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await guard(req); if (error) return error
  const s = getSource(Number(params.id))
  return s ? NextResponse.json({ source: view(s) }) : NextResponse.json({ error: 'Not found' }, { status: 404 })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await guard(req); if (error) return error
  try {
    const id = Number(params.id)
    if (!getSource(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const body = await req.json()
    if (body.action === 'refresh') return NextResponse.json({ source: view(await refreshSource(id)) })
    updateSource(id, {
      label: body.label, legend: body.legend,
      tab: body.tab === undefined ? undefined : (body.tab || null),
      enabled: body.enabled === undefined ? undefined : (body.enabled ? 1 : 0),
    })
    const s = body.tab !== undefined ? await refreshSource(id) : getSource(id)
    return NextResponse.json({ source: view(s) })
  } catch (e) { return fail(e) }
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await guard(req); if (error) return error
  deleteSource(Number(params.id))
  return NextResponse.json({ ok: true })
}
