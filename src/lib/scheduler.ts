import { getSchedules, updateSchedule, saveMcdReport, markMcdReportDelivered } from '@/lib/db'
import { sendMcdEmail } from '@/lib/mcd-email'
import { spawn } from 'child_process'
import { writeFileSync } from 'fs'
import pathModule from 'path'
import osModule from 'os'
import OpenAI from 'openai'

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

  // MCD weekly report: Monday 07:30 America/Phoenix
  // Guard: only active when all required env vars are present and MCD_WEEKLY_ENABLED=true
  const mcdEnabled =
    process.env.MCD_WEEKLY_ENABLED === 'true' &&
    !!(process.env.GHL_API_KEY && process.env.OPENAI_API_KEY && process.env.MCD_GCHAT_WEBHOOK)

  if (mcdEnabled) {
    const c = await getCron()
    c.schedule('30 7 * * 1', () => {
      console.log('[mcd-cron] Starting weekly report...')
      runMcdWeeklyReport().catch((e: any) => console.error('[mcd-cron] Fatal:', e.message))
    }, { timezone: 'America/Phoenix' })
    console.log('[mcd-cron] Weekly report scheduled: Mon 07:30 America/Phoenix')
  } else {
    console.log('[mcd-cron] Weekly report DISABLED (set MCD_WEEKLY_ENABLED=true + MCD env vars)')
  }
}

export function stopCron(id: number) {
  cronJobs.get(id)?.stop()
  cronJobs.delete(id)
}

// ── Event trigger poller ───────────────────────────────────────────────────

export async function pollEventTriggers(baseUrl: string, secret: string) {
  const { getActiveTriggers, updateTrigger, createTask } = await import('./db')
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
          createTask({ agent_id: agent_id || null, title, description, type: 'general', priority: 1, status: 'pending' })
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
          const description = (task_description_template || 'New GHL opportunity: {{name}} - ${{value}}. Analyse and suggest next steps.')
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

// ── Auto-snapshot email stats daily ───────────────────────────────────────

export async function autoSnapshotEmailStats(baseUrl: string, secret: string) {
  const now = new Date()
  const apiKey     = process.env.GHL_API_KEY     || ''
  const locationId = process.env.GHL_LOCATION_ID || ''
  if (!apiKey || !locationId) return
  try {
    await fetch(`${baseUrl}/api/reports/email-snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': secret },
      body: JSON.stringify({ ghl_api_key: apiKey, location_id: locationId }),
    })
    console.log('[auto-snapshot] Email stats snapshot taken for', now.toISOString().slice(0,10))
  } catch (e: any) {
    console.error('[auto-snapshot] Failed:', e.message)
  }
}

// ── MCD Weekly Report Engine ───────────────────────────────────────────────

const MCD_SOUL = `You are the Marketing and Conversions Director.

You are a blunt, direct, data-first operator and coach. You tell Jeremy what the numbers say, what to do about it, and what you would not do. No flattery. No hedging.

You challenge weak plans. Every time you give advice, you name the strongest counterargument to your own advice.

You are skeptical of your own outputs. You never present a guess as a fact. You always show which data you relied on. When you do not know something, you say so plainly.

You write in short sentences. You lead with the answer. You never use em dashes.`

const MCD_AGENTS = `## Remit and Out-of-Scope
Your remit: traffic and demand generation through the full funnel.
Lead, Discovery Call, in-home appointment, close. This includes GHL funnel metrics, paid and organic channels, website conversion, and SEO data.

Out of scope: construction operations, finance, HR, legal.

## Users and Audience
Your users are Jeremy and Mel. Nobody else. Never message employees.

## Phase 1 Constraints
Read-only with respect to PHR source systems. The ONE authorized external action is DELIVERING your finished reports to the private MCD Reports Google Chat space.

## Confidence Protocol
Every recommendation or judgment call ends with:
"Confidence: NN% (BASIS). What would move it: X."
BASIS: Established principle | Your data | My inference

## Data Integrity Rules
- Every cited metric must trace to a connector call. Name the source and date range.
- If a connector fails, report the failure. Never paper over a gap.
- Keyword Hero data lags about 3 days. Label the true data window.
- GSC and GA4 are the source of truth for clicks, impressions, and positions.

## Prioritization Logic
- Maximum 3 recommendations per week. Always state what you deprioritized and why.
- Filter every recommendation against the known bottleneck: mid-funnel conversion.
- DC-to-in-home COMPLETED rate (target 40%, currently below) is the primary bottleneck.

## Brand and Writing Rules
No em dashes. Short sentences. Lead with the answer. Always "Discovery Call", never "consultation".

## Alerting Thresholds
Unscheduled alert when:
- GHL new leads drop more than 40% week over week on a 7-day rolling basis.
- GSC organic clicks drop more than 30% week over week site-wide.
- Any tracked conversion event records zero for 48+ hours.
- DC-to-in-home falls below 25% on a trailing 30 days.`

// Compute last complete Monday-Sunday window (called Monday morning)
function computeWeekWindow() {
  const now = new Date()
  const todayDow = now.getDay() // 0=Sun, 1=Mon...
  const daysSinceSunday = todayDow === 0 ? 0 : todayDow
  const lastSunday  = new Date(now); lastSunday.setDate(now.getDate() - daysSinceSunday)
  const lastMonday  = new Date(lastSunday); lastMonday.setDate(lastSunday.getDate() - 6)
  const prevSunday  = new Date(lastMonday); prevSunday.setDate(lastMonday.getDate() - 1)
  const prevMonday  = new Date(prevSunday); prevMonday.setDate(prevSunday.getDate() - 6)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { monday: fmt(lastMonday), sunday: fmt(lastSunday), prevMonday: fmt(prevMonday), prevSunday: fmt(prevSunday) }
}

// Spawn a Python connector script, return its stdout
function spawnPython(python: string, scriptPath: string, args: string[]): Promise<{ out: string; err: string; ok: boolean }> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  return new Promise((resolve) => {
    let out = '', err = ''
    const proc = spawn(python, [scriptPath, ...args], { env, timeout: 60_000 })
    proc.stdout.on('data', (d: Buffer) => { out += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { err += d.toString() })
    proc.on('close', (code: number | null) => resolve({ out, err, ok: code === 0 }))
    proc.on('error', (e: Error) => resolve({ out: '', err: e.message, ok: false }))
  })
}

async function callMcdConnector(name: string, args: string[]): Promise<string> {
  const SCRIPTS = process.env.MCD_SCRIPTS_DIR || '/root/agentic-os/mcd/scripts'
  const VENV    = process.env.MCD_VENV_PYTHON  || '/root/agentic-os/mcd/venv/bin/python3'

  const map: Record<string, { script: string; venv: boolean }> = {
    ghl:         { script: 'ghl_client.py',         venv: false },
    ga4:         { script: 'ga4_client.py',          venv: true  },
    gsc:         { script: 'gsc_client.py',          venv: true  },
    gtm:         { script: 'gtm_client.py',          venv: true  },
    wp:          { script: 'wp_client.py',           venv: false },
    initiatives: { script: 'initiatives_client.py',  venv: true  },
  }

  const cfg = map[name]
  if (!cfg) return `[${name}] ERROR: unknown connector`

  const python     = cfg.venv ? VENV : 'python3'
  const scriptPath = pathModule.join(SCRIPTS, cfg.script)
  const { out, err, ok } = await spawnPython(python, scriptPath, args)

  if (!ok) return `[${name}] CONNECTOR FAILURE: ${err.slice(0, 400)}`
  return `[${name}]\n${out.trim() || '(empty output)'}`
}

async function deliverToGChat(reportText: string): Promise<void> {
  const GCHAT_SCRIPT = process.env.MCD_GCHAT_SCRIPT || '/root/agentic-os/mcd/bin/post_gchat.py'

  // Write to temp file (post_gchat.py accepts a file path argument)
  const tmpFile = pathModule.join(osModule.tmpdir(), `mcd-weekly-${Date.now()}.md`)
  writeFileSync(tmpFile, reportText, 'utf8')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MCD_GCHAT_WEBHOOK: process.env.MCD_GCHAT_WEBHOOK || '',
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('python3', [GCHAT_SCRIPT, tmpFile], { env, timeout: 120_000 })
    let errBuf = ''
    proc.stdout.on('data', (d: Buffer) => console.log('[mcd-gchat]', d.toString().trim()))
    proc.stderr.on('data', (d: Buffer) => { errBuf += d.toString(); console.error('[mcd-gchat] STDERR:', d.toString().trim()) })
    proc.on('close', (code: number | null) => {
      if (code === 0) resolve()
      else reject(new Error(`post_gchat.py exited ${code}: ${errBuf.slice(0, 400)}`))
    })
    proc.on('error', (e: Error) => reject(e))
  })
}

export async function runMcdWeeklyReport(): Promise<void> {
  const { monday, sunday, prevMonday, prevSunday } = computeWeekWindow()
  console.log(`[mcd-cron] Window: ${monday} to ${sunday} | Prev: ${prevMonday} to ${prevSunday}`)

  const openai = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey:  process.env.OPENAI_API_KEY  || '',
    timeout: 120_000,
  })

  // Pull all connectors — this week and prior week GHL leads in parallel
  console.log('[mcd-cron] Pulling connector data...')
  const [
    ghlLeads, ghlLeadsPrev, ghlPipeline, ghlAppts, ghlOpps,
    ga4Channels, ga4Forms, ga4Conversions,
    gscWow, gscSearch,
    initiativesPrios, wpData,
  ] = await Promise.all([
    callMcdConnector('ghl', ['leads',         '--from', monday,    '--to', sunday]),
    callMcdConnector('ghl', ['leads',         '--from', prevMonday,'--to', prevSunday]),
    callMcdConnector('ghl', ['pipeline',      '--from', monday,    '--to', sunday]),
    callMcdConnector('ghl', ['appointments',  '--from', monday,    '--to', sunday]),
    callMcdConnector('ghl', ['opportunities', '--from', monday,    '--to', sunday]),
    callMcdConnector('ga4', ['channels',      '--from', monday,    '--to', sunday]),
    callMcdConnector('ga4', ['forms',         '--from', monday,    '--to', sunday]),
    callMcdConnector('ga4', ['conversions',   '--from', monday,    '--to', sunday]),
    callMcdConnector('gsc', ['wow',           '--week-ending', sunday]),
    callMcdConnector('gsc', ['search',        '--from', monday,    '--to', sunday]),
    callMcdConnector('initiatives', ['priorities']),
    callMcdConnector('wp', ['summary']),
  ])

  console.log('[mcd-cron] Connectors done. Generating report via OpenAI...')

  const systemPrompt = [
    MCD_SOUL,
    '---',
    MCD_AGENTS,
    '---',
    `## Current Reporting Window`,
    `This week:  ${monday} to ${sunday}`,
    `Prior week: ${prevMonday} to ${prevSunday}`,
    '',
    '## CONNECTOR DATA',
    '',
    '### GHL Leads (this week)',  ghlLeads,
    '### GHL Leads (prior week)', ghlLeadsPrev,
    '### GHL Pipeline',           ghlPipeline,
    '### GHL Appointments',       ghlAppts,
    '### GHL Opportunities',      ghlOpps,
    '### GA4 Channels',           ga4Channels,
    '### GA4 Forms',              ga4Forms,
    '### GA4 Conversions',        ga4Conversions,
    '### GSC Week-over-Week',     gscWow,
    '### GSC Search queries',     gscSearch,
    '### Initiatives priorities', initiativesPrios,
    '### WordPress / RankMath',   wpData,
  ].join('\n')

  const userPrompt = `Produce this week's PHR MCD Weekly Report.
Reporting window: ${monday} (Monday) to ${sunday} (Sunday).
Prior week: ${prevMonday} to ${prevSunday}.

Structure (follow AGENTS.md exactly):
1. Headline: ONE takeaway sentence, then funnel numbers.
2. Lead generation: qualified leads, blank source over QUALIFIED leads only.
3. Funnel (THE FOCUS): Discovery Calls scheduled/completed/cancelled; In-Homes scheduled/completed; same-week ratios vs baselines; current open mid-funnel snapshot.
4. Traffic: total sessions, TOP 5 channels only.
5. Web conversions: confirmed events only (form submits, calls, texts); top 3 landing pages.
6. Organic search: clicks WoW, TOP 5 queries.
7. Recommended this week (MAX 3, ordered by bottleneck relevance; each with counterargument, confidence line, deprioritized note).
8. Gaps.
9. Final overall confidence line.

Voice: blunt, short sentences, lead with the answer. No em dashes. Always "Discovery Call".
Length: skimmable in ~1 minute.`

  let report = ''
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      max_completion_tokens: 3000,
    })
    report = completion.choices[0]?.message?.content || ''
  } catch (e: any) {
    report = `MCD WEEKLY REPORT - GENERATION FAILED\n\nDate: ${new Date().toISOString()}\nError: ${e.message}\n\nConnector data was collected but OpenAI synthesis failed. Check OPENAI_API_KEY and model.`
    console.error('[mcd-cron] OpenAI error:', e.message)
  }

  // Save to DB
  const saved = saveMcdReport({ report_type: 'weekly', period_start: monday, period_end: sunday, content: report })
  console.log(`[mcd-cron] Saved to mcd_reports as #${saved.id}`)

  // Deliver to Google Chat
  if (!process.env.MCD_GCHAT_WEBHOOK) {
    console.warn('[mcd-cron] MCD_GCHAT_WEBHOOK not set — skipping GChat delivery')
  } else {
    try {
      await deliverToGChat(report)
      markMcdReportDelivered(saved.id)
      console.log(`[mcd-cron] Report #${saved.id} delivered to Google Chat`)
    } catch (e: any) {
      console.error(`[mcd-cron] GChat delivery FAILED for report #${saved.id}:`, e.message)
    }
  }

  // Deliver via email (N8N webhook)
  if (!process.env.MCD_N8N_EMAIL_WEBHOOK) {
    console.warn('[mcd-cron] MCD_N8N_EMAIL_WEBHOOK not set — skipping email delivery')
  } else {
    try {
      const emailResult = await sendMcdEmail(saved.id)
      if (emailResult.ok) {
        console.log(`[mcd-cron] Report #${saved.id} sent via email: ${emailResult.subject}`)
      } else {
        console.error(`[mcd-cron] Email delivery FAILED for report #${saved.id}:`, emailResult.error)
      }
    } catch (e: any) {
      console.error(`[mcd-cron] Email delivery FAILED for report #${saved.id}:`, e.message)
    }
  }
}
