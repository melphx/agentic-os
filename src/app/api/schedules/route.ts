import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getSchedules, createSchedule, updateSchedule, getDb } from '@/lib/db'
import cron from 'node-cron'

// In-memory cron registry (persists as long as the server is up)
const cronJobs = new Map<number, cron.ScheduledTask>()

export function initScheduler() {
  const schedules = getSchedules()
  for (const s of schedules) {
    if (s.enabled && cron.validate(s.cron)) {
      registerCron(s.id, s.cron, s.agent_id, s.title, s.description, s.type)
    }
  }
  console.log(`[scheduler] Loaded ${schedules.length} schedules`)
}

function registerCron(id: number, cronExpr: string, agentId: string, title: string, description: string, type: string) {
  const existing = cronJobs.get(id)
  if (existing) existing.stop()

  const task = cron.schedule(cronExpr, async () => {
    updateSchedule(id, { last_run: new Date().toISOString() })
    console.log(`[scheduler] Running schedule #${id}: ${title}`)

    // Fire the run endpoint internally
    try {
      await fetch(`${process.env.INTERNAL_URL || 'http://localhost:3000'}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': process.env.JWT_SECRET || '' },
        body: JSON.stringify({ agent_id: agentId, title, description, type: type || 'general', priority: 2 }),
      })
    } catch (e: any) {
      console.error(`[scheduler] Failed to run schedule #${id}:`, e.message)
    }
  })

  cronJobs.set(id, task)
}

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

  registerCron(schedule.id, schedule.cron, schedule.agent_id, schedule.title, schedule.description, schedule.type)
  return NextResponse.json(schedule, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const { id, enabled } = await req.json()
  updateSchedule(id, { enabled: enabled ? 1 : 0 })

  if (!enabled) {
    cronJobs.get(id)?.stop()
    cronJobs.delete(id)
  } else {
    const s = getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(id) as any
    if (s) registerCron(s.id, s.cron, s.agent_id, s.title, s.description, s.type)
  }

  return NextResponse.json({ ok: true })
}
