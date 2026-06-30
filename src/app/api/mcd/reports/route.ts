/**
 * /api/mcd/reports — read MCD reports from SQLite, trigger manual runs
 *
 * GET ?limit=N          returns the N most recent reports (default 20)
 * GET ?id=N             returns a single report by id
 * POST { action: 'run' } triggers a manual MCD report immediately (queued async)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getMcdReports, getLatestMcdReport } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const id    = searchParams.get('id')
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)
    const type  = searchParams.get('type') as any | undefined

    if (id) {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const report = db.prepare('SELECT * FROM mcd_reports WHERE id = ?').get(parseInt(id, 10))
      if (!report) return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ report })
    }

    const reports = getMcdReports(limit)
    const latest  = getLatestMcdReport(type)

    return NextResponse.json({ reports, latest })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { action } = body as { action: string }

    if (action === 'run') {
      // Fire MCD report in background — don't await (it takes minutes)
      const { runMcdWeeklyReport } = await import('@/lib/scheduler')
      runMcdWeeklyReport().catch((e: any) => console.error('[mcd/reports] Manual run failed:', e.message))
      return NextResponse.json({ ok: true, message: 'MCD report queued — will appear in Reports view when complete (takes 1-3 min)' })
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
