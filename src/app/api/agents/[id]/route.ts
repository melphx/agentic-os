import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAgent, updateAgent, getTasks, getMetricHistory } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const agent = getAgent(params.id)
  if (!agent) return NextResponse.json({ error: 'Agent not found' }, { status: 404 })

  const tasks = getTasks({ agent_id: params.id, limit: 20 })
  const sparkline = getMetricHistory(params.id, 'tokens', 12)

  return NextResponse.json({ ...agent, tasks, sparkline })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json()
  updateAgent(params.id, body)
  return NextResponse.json({ ok: true })
}
