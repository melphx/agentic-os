import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { saveEmailSnapshot, getEmailSnapshot, getClosestSnapshot, getLatestSnapshot, ensureEmailSnapshotsTable } from '@/lib/db'

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
  timeout: 120000,
})
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4'

const GHL = (apiKey: string) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
})
const GHL23 = (apiKey: string) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2023-02-21',
})

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  if (searchParams.get('action') === 'status') {
    return NextResponse.json({
      configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
      domain: process.env.GHL_DOMAIN || 'phxhomeremodeling.com',
    })
  }
  return NextResponse.json({
    configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
    domain: process.env.GHL_DOMAIN || 'phxhomeremodeling.com',
  })
}

// ── Tag count query ────────────────────────────────────────────────────────
async function countByTag(apiKey: string, locationId: string, tag: string): Promise<number> {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: { ...GHL(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, pageLimit: 1, filters: [{ field: 'tags', operator: 'contains', value: tag }] }),
      signal: AbortSignal.timeout(10000), cache: 'no-store',
    })
    if (!res.ok) return 0
    const d = await res.json() as Record<string, any>
    return d.total || 0
  } catch { return 0 }
}

async function getTotalContacts(apiKey: string, locationId: string): Promise<number> {
  const res = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`,
    { headers: GHL(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
  )
  if (!res.ok) return 0
  const d = await res.json() as Record<string, any>
  return d.total || d.meta?.total || 0
}

// ── Workflow campaign stats with month filtering ───────────────────────────
async function fetchWorkflowCampaignStats(apiKey: string, locationId: string, startDate: string, endDate: string) {
  const totals = { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
  try {
    // Get all campaigns with pagination
    let allCampaigns: any[] = []
    let page = 1, hasMore = true
    while (hasMore && page <= 20) {
      const res = await fetch(
        `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/workflows?page=${page}&pageSize=20`,
        { headers: GHL23(apiKey), signal: AbortSignal.timeout(15000), cache: 'no-store' }
      )
      if (!res.ok) break
      const d = await res.json() as Record<string, any>
      const batch: any[] = d.campaigns || []
      console.log(`[campaigns page=${page}] fetched=${batch.length} total_so_far=${allCampaigns.length + batch.length} keys=${Object.keys(d).join(',')}`)
      allCampaigns = allCampaigns.concat(batch)
      hasMore = batch.length > 0; page++
    }
    // Deduplicate by sourceId
    const seen = new Set<string>()
    const campaigns = allCampaigns.filter((c: any) => {
      const sid = c.sourceId || c.id
      if (seen.has(sid)) return false; seen.add(sid); return true
    })

    // Fetch stats for each campaign
    const statsResults = await Promise.all(
      campaigns.map(async (c: any) => {
        const sourceId = c.sourceId || c.id
        try {
          const res = await fetch(
            `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/stats/workflow-campaigns/${sourceId}`,
            { headers: GHL23(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
          )
          if (!res.ok) return null
          const d = await res.json() as Record<string, any>
          return { ...d.stats, name: c.name, id: c.id, sourceId, createdAt: c.createdAt, status: c.status }
        } catch { return null }
      })
    )

    // Aggregate stats
    const nonNullStats = statsResults.filter(s => s !== null)
    const nonZeroStats = statsResults.filter((s: any) => s && s.sent > 0)
    console.log(`[campaign stats] total_campaigns=${campaigns.length} stats_fetched=${nonNullStats.length} with_sends=${nonZeroStats.length}`)
    const workflowDetails: any[] = []
    let campaignCount = 0
    for (const s of statsResults) {
      if (!s || s.sent === 0) continue
      campaignCount++
      totals.sent         += s.sent        || 0
      totals.opened       += s.opened      || 0
      totals.clicked      += s.clicked     || 0
      totals.bounced      += s.permanentFail || s.bounced || 0
      totals.complained   += s.complained   || 0
      totals.unsubscribed += s.unsubscribed || 0
      workflowDetails.push({
        name: s.name, sent: s.sent, opened: s.opened, clicked: s.clicked,
        bounced: s.permanentFail || s.bounced || 0, complained: s.complained || 0,
        openRate: s.openRate || (s.sent > 0 ? s.opened/s.sent*100 : 0),
        clickRate: s.clickRate || (s.sent > 0 ? s.clicked/s.sent*100 : 0),
        complaintRate: s.complaintRate || (s.sent > 0 ? s.complained/s.sent*100 : 0),
      })
    }

    // Date-range delta: startDate snapshot as baseline, endDate (or live) as current
    const today = new Date().toISOString().slice(0, 10)
    const isLiveEnd = endDate >= today

    const deltaDetails: any[] = []
    const deltaTotal = { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
    let hasSnapshots = false

    for (let i = 0; i < campaigns.length; i++) {
      const c = campaigns[i]
      const s = statsResults[i]
      if (!s || s.sent === 0) continue

      const sourceId = c.sourceId || c.id

      // Find closest snapshot on or before startDate as baseline
      const startSnap = getClosestSnapshot(startDate, locationId, sourceId)

      // End = live stats if endDate is today/future, else closest snapshot at/before endDate
      let endStats = { sent: s.sent||0, opened: s.opened||0, clicked: s.clicked||0,
        bounced: s.permanentFail||s.bounced||0, complained: s.complained||0, unsubscribed: s.unsubscribed||0 }
      if (!isLiveEnd) {
        const endSnap = getClosestSnapshot(endDate, locationId, sourceId)
        if (endSnap) endStats = { sent: endSnap.sent, opened: endSnap.opened, clicked: endSnap.clicked,
          bounced: endSnap.bounced, complained: endSnap.complained, unsubscribed: endSnap.unsubscribed }
      }

      let delta = { ...endStats }
      if (startSnap) {
        hasSnapshots = true
        delta = {
          sent:         Math.max(0, endStats.sent         - startSnap.sent),
          opened:       Math.max(0, endStats.opened       - startSnap.opened),
          clicked:      Math.max(0, endStats.clicked      - startSnap.clicked),
          bounced:      Math.max(0, endStats.bounced      - startSnap.bounced),
          complained:   Math.max(0, endStats.complained   - startSnap.complained),
          unsubscribed: Math.max(0, endStats.unsubscribed - startSnap.unsubscribed),
        }
      }

      // Auto-save today's live stats as a snapshot for future delta use
      if (isLiveEnd) {
        saveEmailSnapshot({ snapshot_date: today, location_id: locationId, source_id: sourceId,
          campaign_name: c.name || '', sent: s.sent||0, opened: s.opened||0, clicked: s.clicked||0,
          bounced: s.permanentFail||s.bounced||0, complained: s.complained||0, unsubscribed: s.unsubscribed||0 })
      }

      if (delta.sent === 0) continue
      deltaTotal.sent         += delta.sent
      deltaTotal.opened       += delta.opened
      deltaTotal.clicked      += delta.clicked
      deltaTotal.bounced      += delta.bounced
      deltaTotal.complained   += delta.complained
      deltaTotal.unsubscribed += delta.unsubscribed

      deltaDetails.push({
        name: c.name, sent: delta.sent, opened: delta.opened, clicked: delta.clicked,
        bounced: delta.bounced, complained: delta.complained,
        openRate:      delta.sent > 0 ? delta.opened   /delta.sent*100 : (s.openRate||0),
        clickRate:     delta.sent > 0 ? delta.clicked  /delta.sent*100 : (s.clickRate||0),
        complaintRate: delta.sent > 0 ? delta.complained/delta.sent*100 : (s.complaintRate||0),
      })
    }

    // If we have delta data, use it; otherwise fall back to all-time
    const useData  = hasSnapshots && deltaTotal.sent > 0 ? deltaTotal : totals
    const useDetails = hasSnapshots && deltaDetails.length > 0 ? deltaDetails : workflowDetails

    return {
      ...useData, campaigns: hasSnapshots ? deltaDetails.length : campaignCount,
      workflows: useDetails, is_monthly: hasSnapshots,
      openRate:      useData.sent > 0 ? useData.opened      / useData.sent * 100 : 0,
      clickRate:     useData.sent > 0 ? useData.clicked     / useData.sent * 100 : 0,
      bounceRate:    useData.sent > 0 ? useData.bounced     / useData.sent * 100 : 0,
      complaintRate: useData.sent > 0 ? useData.complained  / useData.sent * 100 : 0,
      unsubRate:     useData.sent > 0 ? useData.unsubscribed/ useData.sent * 100 : 0,
    }
  } catch (e: any) {
    console.error('[workflow stats]', e.message)
    return { ...totals, campaigns: 0, workflows: [], openRate: 0, clickRate: 0, bounceRate: 0, complaintRate: 0, unsubRate: 0, is_monthly: false }
  }
}

// ── Score calculation ──────────────────────────────────────────────────────
function calcStrictScore(data: Record<string, number>): number {
  const total = data.total || 1
  let score = 700
  const redPct   = data.red / total * 100
  const greenPct = data.green / total * 100
  const nePct    = data.neverEngaged / total * 100
  const spamPct  = data.spam / total * 100

  if (redPct > 50)    score -= 300
  else if (redPct > 30) score -= 200
  else if (redPct > 15) score -= 100
  else if (redPct > 5)  score -= 50

  if (greenPct > 50)    score += 150
  else if (greenPct > 25) score += 80
  else if (greenPct > 10) score += 20
  else score -= 80

  if (nePct > 40) score -= 150
  else if (nePct > 25) score -= 80
  else if (nePct > 10) score -= 30

  if (spamPct > 5) score -= 150
  else if (spamPct > 2) score -= 80
  else if (spamPct > 0.5) score -= 30

  if ((data.openRate||0) > 50) score += 100
  else if ((data.openRate||0) > 30) score += 50
  else if ((data.openRate||0) > 0) score += 0
  else score -= 50

  if ((data.complaintRate||0) > 0.5) score -= 200
  else if ((data.complaintRate||0) > 0.1) score -= 100

  return Math.max(0, Math.min(999, score))
}

function calcRelaxedScore(data: Record<string, number>): number {
  // Relaxed = less penalty on engagement, more weight on list quality
  const strict = calcStrictScore(data)
  return Math.min(999, Math.round(strict * 1.3))
}

function scoreLabel(n: number) {
  return n >= 800 ? 'Excellent' : n >= 650 ? 'Good' : n >= 500 ? 'Needs Improvement' : n >= 300 ? 'Poor' : n >= 150 ? 'Very Poor' : 'Critical'
}

// ── Main ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const body = await req.json()
  const apiKey     = (body.ghl_api_key  || process.env.GHL_API_KEY     || '').trim()
  const locationId = (body.location_id  || process.env.GHL_LOCATION_ID || '').trim()
  const domain     = (body.domain       || process.env.GHL_DOMAIN       || 'phxhomeremodeling.com').trim()
  const todayStr = new Date().toISOString().slice(0, 10)
  const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)
  const startDate: string = body.startDate ?? firstOfMonth
  const endDate: string   = body.endDate   ?? todayStr

  if (!apiKey || !locationId) return NextResponse.json({ error: 'ghl_api_key and location_id required' }, { status: 400 })

  try {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
    const monthLabel = startDate === endDate ? startDate : `${startDate} → ${endDate}`

    const [
      total, google, microsoft, yahoo, otherProvider,
      newContacts, neverEngaged, neverSent,
      green, red, catchall, suspicious, freeEmail, notFound, bounced, spam,
      campaignStats,
    ] = await Promise.all([
      getTotalContacts(apiKey, locationId),
      countByTag(apiKey, locationId, 'hti email provider check = is google'),
      countByTag(apiKey, locationId, 'hti email provider check = is microsoft'),
      countByTag(apiKey, locationId, 'hti email provider check = is yahoo'),
      countByTag(apiKey, locationId, 'hti email provider check = is other email provider'),
      countByTag(apiKey, locationId, 'hti contact = is new contact'),
      countByTag(apiKey, locationId, 'hti engagement check = never engaged'),
      countByTag(apiKey, locationId, 'hti engagement check = never sent'),
      countByTag(apiKey, locationId, 'hti status = green (send responsibly)'),
      countByTag(apiKey, locationId, 'hti status = red (do not send)'),
      countByTag(apiKey, locationId, 'hti quality check = is catchall domain'),
      countByTag(apiKey, locationId, 'hti quality check = is suspicious'),
      countByTag(apiKey, locationId, 'hti quality check = is free'),
      countByTag(apiKey, locationId, 'hti valid check = not found'),
      countByTag(apiKey, locationId, '01. status -> email engagement manager: email bounced'),
      countByTag(apiKey, locationId, 'spam likely'),
      fetchWorkflowCampaignStats(apiKey, locationId, startDate, endDate),
    ])

    const scannedTotal = google + microsoft + yahoo + otherProvider || total
    const pct = (n: number, d = total) => d > 0 ? (n / d * 100).toFixed(1) : '0'

    // Engagement segments (estimated from tags)
    const active    = green > newContacts ? green - newContacts : Math.round(green * 0.7)
    const warmingUp = Math.max(0, Math.round((total - green - red - neverEngaged - neverSent) * 0.4))
    const cold      = Math.max(0, Math.round((total - green - red - neverEngaged - neverSent) * 0.6))
    const dead      = neverEngaged

    // Opted out estimate
    const optedOut  = Math.round(total * 0.14) // estimated ~14% industry average
    const marketable = total - optedOut

    // New subscriber engagement (estimate from campaign data)
    const newOpened  = campaignStats.openRate  > 0 ? Math.round(newContacts * campaignStats.openRate  / 100) : 0
    const newClicked = campaignStats.clickRate > 0 ? Math.round(newContacts * campaignStats.clickRate / 100) : 0

    // Existing subscriber engagement
    const existingMailed  = Math.max(0, marketable - newContacts)
    const existingOpened  = campaignStats.openRate  > 0 ? Math.round(existingMailed * campaignStats.openRate  / 100) : 0
    const existingClicked = campaignStats.clickRate > 0 ? Math.round(existingMailed * campaignStats.clickRate / 100) : 0

    const scoreData = { total, red, green, neverEngaged, spam, bounced, openRate: campaignStats.openRate, complaintRate: campaignStats.complaintRate }
    const strictScore  = calcStrictScore(scoreData)
    const relaxedScore = calcRelaxedScore(scoreData)

    // Build AI prompt with full context
    const dataCtx = `
Email Health Report for ${domain} — ${monthLabel}

SCORES:
Strict Email Health Score: ${strictScore}/999 (${scoreLabel(strictScore)})
Relaxed Email Health Score: ${relaxedScore}/999

CONTACTS:
Total: ${total.toLocaleString()}
Green/Safe to send: ${green.toLocaleString()} (${pct(green)}%)
Red/Do not send: ${red.toLocaleString()} (${pct(red)}%)
Never engaged (tagged): ${neverEngaged.toLocaleString()} (${pct(neverEngaged)}%)
Never sent to: ${neverSent.toLocaleString()}
Spam risk: ${spam.toLocaleString()}
Bounced: ${bounced.toLocaleString()}
Invalid/Not found: ${notFound.toLocaleString()}
Catchall domains: ${catchall.toLocaleString()}
New contacts: ${newContacts.toLocaleString()}
Estimated opted out: ${optedOut.toLocaleString()}
Marketable: ${marketable.toLocaleString()}

ENGAGEMENT SEGMENTS:
Best Assets (engaged last 30 days): ${active.toLocaleString()} (${pct(active)}%)
Assets (engaged 30-90 days): ${warmingUp.toLocaleString()} (${pct(warmingUp)}%)
Liabilities (90 days-1 year): ${cold.toLocaleString()} (${pct(cold)}%)
Worst Liabilities (1+ year / never): ${dead.toLocaleString()} (${pct(dead)}%)

CAMPAIGN PERFORMANCE (${campaignStats.campaigns} workflows, all-time totals):
Total sent: ${campaignStats.sent.toLocaleString()}
Open rate: ${campaignStats.openRate.toFixed(1)}%
Click rate: ${campaignStats.clickRate.toFixed(1)}%
Bounce rate: ${campaignStats.bounceRate.toFixed(2)}%
Spam complaint rate: ${campaignStats.complaintRate.toFixed(3)}%
Unsub rate: ${campaignStats.unsubRate.toFixed(2)}%

EMAIL PROVIDERS:
Gmail: ${google.toLocaleString()} (${pct(google, scannedTotal)}%)
Yahoo: ${yahoo.toLocaleString()} (${pct(yahoo, scannedTotal)}%)
Microsoft: ${microsoft.toLocaleString()} (${pct(microsoft, scannedTotal)}%)
Other: ${otherProvider.toLocaleString()} (${pct(otherProvider, scannedTotal)}%)

KEY CONCERN: ${pct(red)}% of list is Do Not Send. ${pct(neverEngaged)}% never engaged.
`

    // Generate AI analysis matching HitTheInbox format
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 3000,
      messages: [
        { role: 'system', content: `You are writing a monthly email health report for Phoenix Home Remodeling (home remodeling company, Phoenix AZ). Match the exact tone and format of HitTheInbox reports — direct, business-focused, revenue-impact language. Return valid JSON only.` },
        { role: 'user', content: `Generate the analysis for this email health report. Return JSON with exactly these keys:
- analyst_notes: 2-3 sentence paragraph about the biggest issues this month
- executive_summary_bullets: array of 6-8 strings, each a bullet point about domain/delivery/engagement status (like "68.6% of your subscribers use Google email...")  
- score_explanation_strict: one sentence explaining what the strict score means and its implication
- score_explanation_relaxed: one sentence explaining the relaxed score
- problems: array of objects with {title, count, description} — list specific subscriber problems with counts and business impact (e.g. "${dead.toLocaleString()} subscribers are dead weight - They haven't engaged in over a year...")
- actions_high: array of 3-4 strings, urgent actions with GHL smart list names where applicable
- actions_medium: array of 3-4 strings, important but not urgent actions
- actions_low: array of 2-3 strings, maintenance actions
- best_practices_tip: one paragraph about a relevant email best practice

Data:\n${dataCtx}` }
      ]
    })

    let analysis: Record<string, any> = {}
    try {
      const raw = completion.choices[0].message.content || '{}'
      const match = raw.match(/\{[\s\S]*\}/)
      analysis = match ? JSON.parse(match[0]) : {}
    } catch { analysis = {} }

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      startDate, endDate, domain,
      month_label: monthLabel,

      // Scores
      health_score: strictScore,
      strict_score: strictScore,
      relaxed_score: relaxedScore,
      score_label: scoreLabel(strictScore),
      relaxed_label: scoreLabel(relaxedScore),

      // Subscriber segments
      segments: {
        total, new: newContacts, active, warmingUp, cold, dead,
        neverEngaged, spamRisk: spam, optedOut, marketable,
      },

      // Email quality tags
      quality: { green, red, catchall, suspicious, freeEmail, notFound, bounced, spam },

      // Provider breakdown
      providers: { google, microsoft, yahoo, other: otherProvider, scanned: scannedTotal },

      // Campaign stats
      stats: {
        campaigns_analyzed: campaignStats.campaigns,
        total_sent: campaignStats.sent,
        open_rate:      parseFloat(campaignStats.openRate.toFixed(1)),
        click_rate:     parseFloat(campaignStats.clickRate.toFixed(1)),
        bounce_rate:    parseFloat(campaignStats.bounceRate.toFixed(2)),
        spam_rate:      parseFloat(campaignStats.complaintRate.toFixed(3)),
        unsub_rate:     parseFloat(campaignStats.unsubRate.toFixed(2)),
        engagement_rate: parseFloat(campaignStats.openRate.toFixed(1)),
        note: campaignStats.campaigns === 0 ? 'No workflow campaigns found.' : campaignStats.is_monthly ? `Monthly stats for ${monthLabel} (delta from previous snapshot)` : 'All-time totals — take a snapshot at month end to enable monthly filtering. Go to Reports → Snapshot.',
      },
      workflows: campaignStats.workflows || [],

      // Engagement breakdown table
      engagement_table: {
        existing: { mailed: existingMailed, opened: existingOpened, clicked: existingClicked,
          open_pct: existingMailed > 0 ? parseFloat((existingOpened/existingMailed*100).toFixed(1)) : 0,
          click_pct: existingMailed > 0 ? parseFloat((existingClicked/existingMailed*100).toFixed(1)) : 0,
        },
        new_subs: { mailed: newContacts, opened: newOpened, clicked: newClicked,
          open_pct: newContacts > 0 ? parseFloat((newOpened/newContacts*100).toFixed(1)) : 0,
          click_pct: newContacts > 0 ? parseFloat((newClicked/newContacts*100).toFixed(1)) : 0,
        },
      },

      analysis,
    })
  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
