import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAgents, getMetricHistory } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const agents = getAgents()
  const enriched = agents.map(a => ({
    ...a,
    sparkline: getMetricHistory(a.id, 'tokens', 12),
  }))
  return NextResponse.json(enriched)
}
