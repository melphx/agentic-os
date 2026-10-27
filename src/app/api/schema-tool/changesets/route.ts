/**
 * /api/schema-tool/changesets?limit=50  → history of changesets
 */
import { NextRequest, NextResponse } from 'next/server'
import { listChangesets } from '@/lib/schema-tool/store'
import { isRunning } from '@/lib/schema-tool/changesets'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const limit = Math.min(Number(new URL(req.url).searchParams.get('limit')) || 50, 200)
    return NextResponse.json({ changesets: listChangesets(limit).map(c => ({ ...c, running: isRunning(c.id) })) })
  } catch (e) { return fail(e) }
}
