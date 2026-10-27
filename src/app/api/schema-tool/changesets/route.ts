/**
 * GET  /api/schema-tool/changesets?limit=50  → history of changesets
 * POST { action: 'apply_many', ids: number[] }  → apply several changesets one after another (oldest first)
 */
import { NextRequest, NextResponse } from 'next/server'
import { listChangesets } from '@/lib/schema-tool/store'
import { isRunning, startApplyMany } from '@/lib/schema-tool/changesets'
import { changesetSummary, fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 50, 200)
    return NextResponse.json({ changesets: listChangesets(limit).map(c => ({ ...c, running: isRunning(c.id) })) })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const body = await req.json()
    if (body.action !== 'apply_many' || !Array.isArray(body.ids)) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    const r = startApplyMany(body.ids.map(Number).filter((n: number) => n > 0).slice(0, 200))
    return NextResponse.json({ ...r, changesets: r.started.map(changesetSummary).filter(Boolean) })
  } catch (e) { return fail(e) }
}
