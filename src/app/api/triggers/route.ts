import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getTriggers, createTrigger, updateTrigger, deleteTrigger } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getTriggers())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  const t = createTrigger({ name: b.name, event_type: b.event_type, config: JSON.stringify(b.config || {}), action_type: b.action_type || 'task', action_id: b.action_id || null, enabled: 1 })
  return NextResponse.json(t, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  updateTrigger(b.id, b)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  deleteTrigger(id)
  return NextResponse.json({ ok: true })
}
