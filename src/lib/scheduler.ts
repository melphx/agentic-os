import { getSchedules, createSchedule, updateSchedule, getDb } from '@/lib/db'
import type { Schedule } from '@/lib/db'

// Lazy-load node-cron only on server
let cron: typeof import('node-cron') | null = null

async function getCron() {
  if (!cron) cron = await import('node-cron')
  return cron
}

const cronJobs = new Map<number, any>()

export async function registerCron(id: number, cronExpr: string, agentId: string, title: string, description: string, type: string) {
  const c = await getCron()
  const existing = cronJobs.get(id)
  if (existing) existing.stop()

  const task = c.schedule(cronExpr, async () => {
    updateSchedule(id, { last_run: new Date().toISOString() })
    console.log(`[scheduler] Running schedule #${id}: ${title}`)
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

export async function initScheduler() {
  const schedules = getSchedules()
  for (const s of schedules) {
    const c = await getCron()
    if (s.enabled && c.validate(s.cron)) {
      await registerCron(s.id, s.cron, s.agent_id, s.title, s.description, s.type)
    }
  }
  console.log(`[scheduler] Loaded ${schedules.length} schedules`)
}

export function stopCron(id: number) {
  cronJobs.get(id)?.stop()
  cronJobs.delete(id)
}
