import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getTasks, createTask } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const { searchParams } = new URL(req.url)
  const agent_id = searchParams.get('agent_id') || undefined
  const status   = searchParams.get('status')   || undefined
  const limit    = parseInt(searchParams.get('limit') || '50')

  return NextResponse.json(getTasks({ agent_id, status, limit }))
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json()
  const task = createTask({
    agent_id:    body.agent_id    || null,
    title:       body.title,
    description: body.description || null,
    type:        body.type        || 'general',
    priority:    body.priority    || 2,
    status:      'pending',
  })
  return NextResponse.json(task, { status: 201 })
}
