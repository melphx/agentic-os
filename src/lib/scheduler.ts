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

// ── Event trigger poller ───────────────────────────────────────────────────

export async function pollEventTriggers(baseUrl: string, secret: string) {
  const { getActiveTriggers, updateTrigger, createTask, getDb } = await import('./db')
  const db = getDb()
  const triggers = getActiveTriggers()

  for (const trigger of triggers) {
    try {
      const config = JSON.parse(trigger.config || '{}')

      if (trigger.event_type === 'ghl.contact.created') {
        const { apiKey, locationId, agent_id, task_description_template } = config
        if (!apiKey || !locationId) continue

        const since = trigger.last_check || new Date(Date.now() - 3600000).toISOString()
        const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&startAfter=${encodeURIComponent(since)}&limit=10`
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Version': '2021-07-28' }, signal: AbortSignal.timeout(15000) })
        if (!res.ok) continue

        const data = await res.json() as Record<string, any>
        const contacts: any[] = data.contacts || []

        for (const contact of contacts) {
          const description = (task_description_template || 'New GHL contact: {{name}} ({{email}}, {{phone}}). Research them and draft a personalised follow-up.')
            .replace('{{name}}',  `${contact.firstName || ''} ${contact.lastName || ''}`.trim())
            .replace('{{email}}', contact.email || 'N/A')
            .replace('{{phone}}', contact.phone || 'N/A')
            .replace('{{id}}',    contact.id || '')

          const title = `New Lead: ${contact.firstName || ''} ${contact.lastName || ''}`.trim()
          const task = createTask({ agent_id: agent_id || null, title, description, type: 'general', priority: 1, status: 'pending' })

          await fetch(`${baseUrl}/api/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': secret },
            body: JSON.stringify({ agent_id, title, description, type: 'general', priority: 1 }),
          }).catch(() => {})
        }

        updateTrigger(trigger.id, { last_check: new Date().toISOString() })
      }

      if (trigger.event_type === 'ghl.opportunity.created') {
        const { apiKey, locationId, agent_id, task_description_template } = config
        if (!apiKey || !locationId) continue
        const since = trigger.last_check || new Date(Date.now() - 3600000).toISOString()
        const res = await fetch(`https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&limit=10`, { headers: { 'Authorization': `Bearer ${apiKey}`, 'Version': '2021-07-28' }, signal: AbortSignal.timeout(15000) })
        if (!res.ok) continue
        const data = await res.json() as Record<string, any>
        const opps: any[] = (data.opportunities || []).filter((o: any) => new Date(o.createdAt) > new Date(since))
        for (const opp of opps) {
          const description = (task_description_template || 'New GHL opportunity: {{name}} — ${{value}}. Analyse and suggest next steps.')
            .replace('{{name}}',  opp.name || 'Unknown')
            .replace('{{value}}', opp.monetaryValue || '0')
            .replace('{{stage}}', opp.status || 'Unknown')
          const title = `New Opportunity: ${opp.name || 'Unknown'}`
          await fetch(`${baseUrl}/api/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': secret },
            body: JSON.stringify({ agent_id, title, description, type: 'general', priority: 1 }),
          }).catch(() => {})
        }
        updateTrigger(trigger.id, { last_check: new Date().toISOString() })
      }
    } catch { /* ignore per-trigger errors */ }
  }
}
