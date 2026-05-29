import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getSchedules, createSchedule, updateSchedule, getDb } from '@/lib/db'
import { registerCron, stopCron } from '@/lib/scheduler'
import cron from 'node-cron'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getSchedules())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json()
  if (!cron.validate(body.cron))
    return NextResponse.json({ error: 'Invalid cron expression' }, { status: 400 })

  const schedule = createSchedule({
    agent_id: body.agent_id,
    title: body.title,
    description: body.description,
    type: body.type || 'general',
    cron: body.cron,
    enabled: 1,
  })

  await registerCron(schedule.id, schedule.cron, schedule.agent_id, schedule.title, schedule.description, schedule.type)
  return NextResponse.json(schedule, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const { id, enabled } = await req.json()
  updateSchedule(id, { enabled: enabled ? 1 : 0 })

  if (!enabled) {
    stopCron(id)
  } else {
    const s = getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id) as any
    if (s) await registerCron(s.id, s.cron, s.agent_id, s.title, s.description, s.type)
  }

  return NextResponse.json({ ok: true })
}
