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

// ── Date-range contact count (uses GET /contacts?startDate/endDate — filters by dateAdded) ──
// NOTE: GHL requires BOTH startDate and endDate to be set — omitting either causes the filter to be ignored.
async function countByDateRange(apiKey: string, locationId: string, fromDate: string, toDate: string): Promise<number> {
  try {
    const url = `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1&startDate=${fromDate}&endDate=${toDate}`
    const res = await fetch(url, { headers: GHL(apiKey), signal: AbortSignal.timeout(12000), cache: 'no-store' })
    if (!res.ok) return 0
    const d = await res.json() as Record<string, any>
    return d.meta?.total || d.total || 0
  } catch { return 0 }
}

// Subtract N days from a YYYY-MM-DD string, return YYYY-MM-DD
function subtractDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

// ── Workflow campaign stats with month filtering ───────────────────────────
async function fetchWorkflowCampaignStats(apiKey: string, locationId: string, startDate: string, endDate: string) {
  const totals = { sent: 0, opened: 0, clicked: 0, bounced: 0, complained: 0, unsubscribed: 0 }
  try {
    // Fetch campaigns from BOTH endpoints: workflow campaigns + regular/nurture campaigns
    const fetchCampaignPage = async (endpoint: string, offset: number, limit = 20): Promise<{campaigns: any[], total: number}> => {
      const res = await fetch(
        `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/${endpoint}?limit=${limit}&offset=${offset}`,
        { headers: GHL23(apiKey), signal: AbortSignal.timeout(15000), cache: 'no-store' }
      )
      if (!res.ok) return { campaigns: [], total: 0 }
      const d = await res.json() as Record<string, any>
      return { campaigns: d.campaigns || [], total: typeof d.total === 'number' ? d.total : 0 }
    }

    // Paginate workflow campaigns
    let allCampaigns: any[] = []
    let offset = 0, totalFromApi = Infinity
    while (allCampaigns.length < totalFromApi) {
      const { campaigns: batch, total } = await fetchCampaignPage('campaigns/workflows', offset)
      if (total > 0) totalFromApi = total
      if (!batch.length) break
      allCampaigns = allCampaigns.concat(batch)
      offset += batch.length
    }

    console.log(`[campaigns] total=${totalFromApi} fetched=${allCampaigns.length}`)

    // Deduplicate by sourceId
    const seen = new Set<string>()
    const campaigns = allCampaigns.filter((c: any) => {
      const sid = c.sourceId || c.id
      if (seen.has(sid)) return false; seen.add(sid); return true
    })

    // Fetch stats for workflow campaigns
    const statsResults = await Promise.all(
      campaigns.map(async (c: any) => {
        const sourceId = c.sourceId || c.id
        for (const statsPath of ['workflow-campaigns', 'campaigns']) {
          try {
            const res = await fetch(
              `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/stats/${statsPath}/${sourceId}`,
              { headers: GHL23(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
            )
            if (!res.ok) continue
            const d = await res.json() as Record<string, any>
            const s = d.stats || d
            // If this path returned real data, use it
            if (s && (s.sent > 0 || s.opened > 0)) {
              return { ...s, name: c.name, id: c.id, sourceId, createdAt: c.createdAt, status: c.status, _path: statsPath }
            }
          } catch { continue }
        }
        return null
      })
    )

    // Aggregate stats
    const nonNullStats = statsResults.filter(s => s !== null)
    const nonZeroStats = statsResults.filter((s: any) => s && s.sent > 0)
    const pathBreakdown = nonZeroStats.reduce((acc: any, s: any) => { acc[s._path||'unknown'] = (acc[s._path||'unknown']||0)+1; return acc }, {})
    console.log(`[campaign stats] total_campaigns=${campaigns.length} stats_fetched=${nonNullStats.length} with_sends=${nonZeroStats.length} paths=${JSON.stringify(pathBreakdown)}`)
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

// NOTE: calcStrictScore / calcRelaxedScore removed — replaced by HTI formula (openRate × 10)

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
  // Clamp dates to today — future dates have no data
  const startDate: string = (body.startDate ?? firstOfMonth) > todayStr ? todayStr : (body.startDate ?? firstOfMonth)
  const endDate: string   = (body.endDate   ?? todayStr)     > todayStr ? todayStr : (body.endDate   ?? todayStr)

  if (!apiKey || !locationId) return NextResponse.json({ error: 'ghl_api_key and location_id required' }, { status: 400 })

  try {
    const monthLabel = startDate === endDate ? startDate : `${startDate} → ${endDate}`

    // Date boundaries for Existing List vs New Leads split
    // Existing = added more than 30 days before endDate
    // New Leads = added within last 30 days of endDate
    const cutoffDate = subtractDays(endDate, 30)

    const [
      total, google, microsoft, yahoo, otherProvider,
      green, red, catchall, suspicious, freeEmail, notFound, bounced, spam,
      neverEngaged, slipping, neverSent,
      // New leads: contacts added within last 30 days of endDate
      newLeadsTotal,
      campaignStats,
    ] = await Promise.all([
      getTotalContacts(apiKey, locationId),
      countByTag(apiKey, locationId, 'hti email provider check = is google'),
      countByTag(apiKey, locationId, 'hti email provider check = is microsoft'),
      countByTag(apiKey, locationId, 'hti email provider check = is yahoo'),
      countByTag(apiKey, locationId, 'hti email provider check = is other email provider'),
      // HTI engagement state tags (updated on every HTI scan)
      countByTag(apiKey, locationId, 'hti status = green (send responsibly)'),    // Best Assets + Neutral combined
      countByTag(apiKey, locationId, 'hti status = red (do not send)'),            // opted out / blocked / non-sendable
      countByTag(apiKey, locationId, 'hti quality check = is catchall domain'),
      countByTag(apiKey, locationId, 'hti quality check = is suspicious'),
      countByTag(apiKey, locationId, 'hti quality check = is free'),
      countByTag(apiKey, locationId, 'hti valid check = not found'),
      countByTag(apiKey, locationId, '01. status -> email engagement manager: email bounced'),
      countByTag(apiKey, locationId, 'spam likely'),
      countByTag(apiKey, locationId, 'hti engagement check = never engaged'),      // Worst Liabilities — never opened
      countByTag(apiKey, locationId, 'hti engagement check = slipping'),           // Liabilities — opened 91-365 days ago
      countByTag(apiKey, locationId, 'hti engagement check = never sent'),
      // New leads: dateAdded within last 30 days of endDate (GHL requires both params)
      countByDateRange(apiKey, locationId, subtractDays(endDate, 29), endDate),
      fetchWorkflowCampaignStats(apiKey, locationId, startDate, endDate),
    ])

    // ── Engagement Segments (HTI methodology) ─────────────────────────────
    // HTI score is calculated on contacts emailed at least once in the period,
    // excluding contacts added in the last 30 days (new leads).
    // Score formula (verified from Jan 2026 report): score = openRate% × 10
    //
    // Segment mapping from HTI tags:
    //   green  = Best Assets (opened 0-30d) + Neutral (opened 30-90d)
    //   slipping = Liabilities (opened 91-365 days ago, engagement declining)
    //   neverEngaged = Worst Liabilities (never opened, or opened >1 year ago)
    //
    // existingMailed ≈ campaignStats.sent (unique contacts not available from GHL API)
    const existingMailed = campaignStats.sent > 0 ? campaignStats.sent : green + slipping + neverEngaged

    // Best Assets = contacts who opened during this period
    const bestAssets_f = Math.round(existingMailed * campaignStats.openRate / 100)
    // Neutral = green contacts who did NOT open this period (still engaged from 30-90 days ago)
    const neutral_f    = Math.max(0, green - bestAssets_f)
    // Liabilities = slipping tag (91-365 days without engagement)
    const liabilities_f = slipping
    // Worst Liabilities = never engaged tag
    const worstLiabilities_f = neverEngaged

    // Audience Analysis (list-wide, separate from health score)
    const optedOut  = red   // HTI "do not send" = opted out / suppressed contacts
    const marketable = Math.max(0, total - optedOut)

    // Engagement counts for the period (from campaign stats, which are date-scoped)
    const existingOpened  = bestAssets_f  // contacts who opened = Best Assets
    const existingClicked = existingMailed > 0 ? Math.round(existingMailed * campaignStats.clickRate / 100) : 0

    // New leads engagement (applying same period rates — approximation since GHL doesn't separate rates)
    const newMailed  = newLeadsTotal
    const newOpened  = newMailed > 0 ? Math.round(newMailed * campaignStats.openRate  / 100) : 0
    const newClicked = newMailed > 0 ? Math.round(newMailed * campaignStats.clickRate / 100) : 0

    // Existing list size (total minus new leads added in last 30 days)
    const existingTotal = Math.max(0, total - newLeadsTotal)
    const scannedTotal = google + microsoft + yahoo + otherProvider || total
    const pct   = (n: number, d = total)  => d > 0 ? (n / d * 100).toFixed(1) : '0'
    const pctOf = (n: number, d: number)  => d > 0 ? (n / d * 100).toFixed(1) : '0'

    // ── Score (HTI formula) ────────────────────────────────────────────────
    // Verified from Jan 2026 HTI report: score = (% opened) × 10
    // Strict = open rate of contacts emailed in period (existing only)
    // Relaxed = (Best Assets + Neutral) / existingMailed × 100 × 10
    //         = % who engaged at least once in last 90 days × 10
    const strictScore  = Math.round(Math.min(999, campaignStats.openRate * 10))
    const relaxedPct   = existingMailed > 0 ? (bestAssets_f + neutral_f) / existingMailed * 100 : 0
    const relaxedScore = Math.round(Math.min(999, relaxedPct * 10))

    // Build AI prompt — window-scoped framing
    const dataCtx = `
Email Health Report for ${domain} — ${monthLabel}
Analysis period: ${startDate} to ${endDate}

SCORES:
Strict Email Health Score: ${strictScore}/999 (${scoreLabel(strictScore)})
Relaxed Email Health Score: ${relaxedScore}/999

EXISTING LIST (added before ${cutoffDate} — contacts who were on the list before the last 30 days):
Total existing subscribers: ${existingTotal.toLocaleString()}
Mailed in period: ${existingMailed.toLocaleString()}
Opened: ${existingOpened.toLocaleString()} (${pctOf(existingOpened, existingMailed)}%)
Clicked: ${existingClicked.toLocaleString()} (${pctOf(existingClicked, existingMailed)}%)
Never clicked: ${existingMailed > 0 ? (existingMailed - existingClicked).toLocaleString() : 0} (${pctOf(existingMailed - existingClicked, existingMailed)}%)

EXISTING LIST ENGAGEMENT SEGMENTS (as % of mailed):
Best Assets (opened 0-30 days): ${bestAssets_f.toLocaleString()} (${pctOf(bestAssets_f, existingMailed)}%)
Neutral (opened 31-90 days): ${neutral_f.toLocaleString()} (${pctOf(neutral_f, existingMailed)}%)
Liabilities (opened 91-365 days): ${liabilities_f.toLocaleString()} (${pctOf(liabilities_f, existingMailed)}%)
Worst Liabilities (>1 year or never engaged): ${worstLiabilities_f.toLocaleString()} (${pctOf(worstLiabilities_f, existingMailed)}%)

NEW LEADS (added in last 30 days, since ${cutoffDate}):
Total added: ${newLeadsTotal.toLocaleString()}
Mailed in period: ${newMailed.toLocaleString()}
Opened: ${newOpened.toLocaleString()} (${pctOf(newOpened, newMailed)}%)
Clicked: ${newClicked.toLocaleString()} (${pctOf(newClicked, newMailed)}%)

FULL LIST OVERVIEW:
Total contacts: ${total.toLocaleString()}
Green/Safe to send: ${green.toLocaleString()} (${pct(green)}%)
Red/Do not send: ${red.toLocaleString()} (${pct(red)}%)
Opted out: ${optedOut.toLocaleString()} | Marketable: ${marketable.toLocaleString()}
Spam risk: ${spam.toLocaleString()} | Bounced: ${bounced.toLocaleString()} | Invalid: ${notFound.toLocaleString()}
Catchall: ${catchall.toLocaleString()} | Suspicious: ${suspicious.toLocaleString()}

CAMPAIGN PERFORMANCE (${campaignStats.campaigns} workflows, period stats):
Total sent: ${campaignStats.sent.toLocaleString()}
Open rate: ${campaignStats.openRate.toFixed(1)}%
Click rate: ${campaignStats.clickRate.toFixed(1)}%
Bounce rate: ${campaignStats.bounceRate.toFixed(2)}%
Spam complaint rate: ${campaignStats.complaintRate.toFixed(3)}%
Unsub rate: ${campaignStats.unsubRate.toFixed(2)}%

EMAIL PROVIDERS (full list):
Gmail: ${google.toLocaleString()} (${pct(google, scannedTotal)}%)
Yahoo: ${yahoo.toLocaleString()} (${pct(yahoo, scannedTotal)}%)
Microsoft: ${microsoft.toLocaleString()} (${pct(microsoft, scannedTotal)}%)
Other: ${otherProvider.toLocaleString()} (${pct(otherProvider, scannedTotal)}%)
`

    // Generate AI analysis matching HitTheInbox format
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 3000,
      messages: [
        { role: 'system', content: `You are writing a monthly email health report for Phoenix Home Remodeling (home remodeling company, Phoenix AZ). Match the exact tone and format of HitTheInbox reports — direct, business-focused, revenue-impact language. Return valid JSON only.` },
        { role: 'user', content: `Generate the analysis for this email health report. The data is scoped to contacts emailed during the selected period. Return JSON with exactly these keys:
- analyst_notes: 2-3 sentence paragraph about the biggest issues this period
- executive_summary_bullets: array of 6-8 strings, each a bullet point about domain/delivery/engagement status (like "68.6% of your subscribers use Google email...")
- score_explanation_strict: one sentence explaining what the strict score means and its implication
- score_explanation_relaxed: one sentence explaining the relaxed score
- problems: array of objects with {title, count, description} — list specific subscriber problems with counts and business impact (e.g. "${worstLiabilities_f.toLocaleString()} existing subscribers haven't engaged in over a year...")
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

      // Subscriber segments (backward-compatible field names)
      segments: {
        total,
        new: newLeadsTotal,
        active: bestAssets_f,
        warmingUp: neutral_f,
        cold: liabilities_f,
        dead: worstLiabilities_f,
        spamRisk: spam,
        optedOut,
        marketable,
      },

      // Existing list breakdown (Hit The Inbox methodology)
      existing_list: {
        total: existingTotal,
        cutoff_date: cutoffDate,
        mailed: existingMailed,
        opened: existingOpened,
        clicked: existingClicked,
        open_pct:          existingMailed > 0 ? parseFloat(pctOf(existingOpened,                       existingMailed)) : 0,
        click_pct:         existingMailed > 0 ? parseFloat(pctOf(existingClicked,                      existingMailed)) : 0,
        never_clicked_pct: existingMailed > 0 ? parseFloat(pctOf(existingMailed - existingClicked,     existingMailed)) : 100,
        best_assets:      bestAssets_f,
        neutral:          neutral_f,
        liabilities:      liabilities_f,
        worst_liabilities: worstLiabilities_f,
      },

      // New leads breakdown
      new_leads: {
        total: newLeadsTotal,
        mailed: newMailed,
        opened: newOpened,
        clicked: newClicked,
        open_pct:  newMailed > 0 ? parseFloat(pctOf(newOpened,  newMailed)) : 0,
        click_pct: newMailed > 0 ? parseFloat(pctOf(newClicked, newMailed)) : 0,
      },

      // Email quality tags (list-wide)
      quality: { green, red, catchall, suspicious, freeEmail, notFound, bounced, spam },

      // Provider breakdown (list-wide)
      providers: { google, microsoft, yahoo, other: otherProvider, scanned: scannedTotal },

      // Campaign stats
      stats: {
        campaigns_analyzed: campaignStats.campaigns,
        total_sent: campaignStats.sent,
        open_rate:       parseFloat(campaignStats.openRate.toFixed(1)),
        click_rate:      parseFloat(campaignStats.clickRate.toFixed(1)),
        bounce_rate:     parseFloat(campaignStats.bounceRate.toFixed(2)),
        spam_rate:       parseFloat(campaignStats.complaintRate.toFixed(3)),
        unsub_rate:      parseFloat(campaignStats.unsubRate.toFixed(2)),
        engagement_rate: parseFloat(campaignStats.openRate.toFixed(1)),
        note: campaignStats.campaigns === 0
          ? 'No workflow campaigns found.'
          : campaignStats.is_monthly
            ? `Period stats for ${monthLabel} (delta from previous snapshot)`
            : 'All-time totals — take a snapshot at month end to enable period filtering. Go to Reports → Snapshot.',
      },
      workflows: campaignStats.workflows || [],

      // Engagement table (backward compatible + updated values)
      engagement_table: {
        existing: {
          mailed: existingMailed, opened: existingOpened, clicked: existingClicked,
          open_pct:  existingMailed > 0 ? parseFloat(pctOf(existingOpened,  existingMailed)) : 0,
          click_pct: existingMailed > 0 ? parseFloat(pctOf(existingClicked, existingMailed)) : 0,
        },
        new_subs: {
          mailed: newMailed, opened: newOpened, clicked: newClicked,
          open_pct:  newMailed > 0 ? parseFloat(pctOf(newOpened,  newMailed)) : 0,
          click_pct: newMailed > 0 ? parseFloat(pctOf(newClicked, newMailed)) : 0,
        },
      },

      analysis,
    })
  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
