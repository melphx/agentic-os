import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import {
  getEmailHealthBaseline, getAllEmailHealthBaselines, saveEmailHealthBaseline,
  saveEmailHealthReport, getEmailHealthReport, getClosestSnapshot, getAllSnapshots,
} from '@/lib/db'

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

async function fetchWorkflowCampaigns(apiKey: string, locationId: string) {
  // Note: GHL workflow stats endpoint returns all-time cumulative only — date params are ignored
  try {
    let all: any[] = []
    let offset = 0, total = Infinity
    while (all.length < total) {
      const res = await fetch(
        `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/workflows?limit=20&offset=${offset}`,
        { headers: GHL23(apiKey), signal: AbortSignal.timeout(15000), cache: 'no-store' }
      )
      if (!res.ok) break
      const d = await res.json() as Record<string, any>
      if (typeof d.total === 'number') total = d.total
      const batch: any[] = d.campaigns || []
      if (!batch.length) break
      all = all.concat(batch)
      offset += batch.length
    }
    const seen = new Set<string>()
    const campaigns = all.filter((c: any) => { const id = c.sourceId || c.id; if (seen.has(id)) return false; seen.add(id); return true })
    const results = await Promise.all(campaigns.map(async (c: any) => {
      try {
        const sourceId = c.sourceId || c.id
        const res = await fetch(
          `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/stats/workflow-campaigns/${sourceId}`,
          { headers: GHL23(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
        )
        if (!res.ok) return null
        const d = await res.json() as Record<string, any>
        const s = d.stats || {}
        if (!s.sent || s.sent === 0) return null
        return {
          sourceId,
          name:      c.name || sourceId,
          sent:      s.sent          || 0,
          opened:    s.opened        || 0,
          clicked:   s.clicked       || 0,
          bounced:   s.permanentFail || s.bounced || 0,
          openRate:  parseFloat((s.openRate  || 0).toFixed(1)),
          clickRate: parseFloat((s.clickRate || 0).toFixed(1)),
        }
      } catch { return null }
    }))
    return results.filter(Boolean)
  } catch { return [] }
}

// ── Tag count ──────────────────────────────────────────────────────────────
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

// Count contacts that have ALL of the given tags (AND logic)
async function countByAllTags(apiKey: string, locationId: string, ...tags: string[]): Promise<number> {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: { ...GHL(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, pageLimit: 1, filters: tags.map(tag => ({ field: 'tags', operator: 'contains', value: tag })) }),
      signal: AbortSignal.timeout(10000), cache: 'no-store',
    })
    if (!res.ok) return 0
    const d = await res.json() as Record<string, any>
    return d.total || 0
  } catch { return 0 }
}

async function getTotalContacts(apiKey: string, locationId: string): Promise<number> {
  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`,
      { headers: GHL(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
    )
    if (!res.ok) return 0
    const d = await res.json() as Record<string, any>
    return d.meta?.total || d.total || 0
  } catch { return 0 }
}

function scoreLabel(n: number) {
  return n >= 800 ? 'Excellent' : n >= 650 ? 'Good' : n >= 500 ? 'Needs Improvement' : n >= 300 ? 'Poor' : n >= 150 ? 'Very Poor' : 'Critical'
}

function monthLabel(month: string) {
  const [y, m] = month.split('-')
  return new Date(parseInt(y), parseInt(m) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// ── GET — status / baselines list ─────────────────────────────────────────
export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get('action')

  if (action === 'status') {
    return NextResponse.json({
      configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
      domain: process.env.GHL_DOMAIN || 'phxhomeremodeling.com',
    })
  }

  if (action === 'baselines') {
    const baselines = getAllEmailHealthBaselines()
    return NextResponse.json({ baselines })
  }

  if (action === 'baseline') {
    const month = req.nextUrl.searchParams.get('month')
    if (!month) return NextResponse.json({ error: 'month required' }, { status: 400 })
    const baseline = getEmailHealthBaseline(month)
    return NextResponse.json({ baseline })
  }

  if (action === 'report') {
    const month = req.nextUrl.searchParams.get('month')
    if (!month) return NextResponse.json({ error: 'month required' }, { status: 400 })
    const cached = getEmailHealthReport(month)
    if (!cached) return NextResponse.json({ cached: null })
    return NextResponse.json({ cached: JSON.parse(cached.report_json), generated_at: cached.generated_at })
  }

  return NextResponse.json({
    configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
    domain: process.env.GHL_DOMAIN || 'phxhomeremodeling.com',
  })
}

// ── PUT — save baseline ────────────────────────────────────────────────────
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json()
    const { month, existing_mailed, new_mailed, open_rate, delivered,
            total_opened, total_clicked, bounced, spam, unsub, engaged_90d } = body

    if (!month || !existing_mailed || !open_rate) {
      return NextResponse.json({ error: 'month, existing_mailed, and open_rate are required' }, { status: 400 })
    }

    const click_rate = delivered > 0 ? (total_clicked / delivered) * 100 : 0
    const strict_score  = Math.min(999, Math.round(open_rate * 10))
    const relaxed_score = existing_mailed > 0
      ? Math.min(999, Math.round((engaged_90d / existing_mailed) * 100 * 10))
      : 0

    saveEmailHealthBaseline({
      month, existing_mailed, new_mailed: new_mailed || 0,
      open_rate, click_rate, delivered: delivered || 0,
      total_opened: total_opened || 0, total_clicked: total_clicked || 0,
      bounced: bounced || 0, spam: spam || 0, unsub: unsub || 0,
      engaged_90d: engaged_90d || 0,
      strict_score, relaxed_score,
    })

    return NextResponse.json({ ok: true, month, strict_score, relaxed_score })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// ── POST — generate report ─────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const body         = await req.json()
  const apiKey       = (body.ghl_api_key  || process.env.GHL_API_KEY     || '').trim()
  const locationId   = (body.location_id  || process.env.GHL_LOCATION_ID || '').trim()
  const domain       = (body.domain       || process.env.GHL_DOMAIN      || 'phxhomeremodeling.com').trim()
  const month: string = body.month || new Date().toISOString().slice(0, 7)  // 'YYYY-MM'

  if (!apiKey || !locationId) return NextResponse.json({ error: 'ghl_api_key and location_id required' }, { status: 400 })

  // Current month — report not ready yet
  const currentMonth = new Date().toISOString().slice(0, 7)
  if (month >= currentMonth) {
    return NextResponse.json({
      in_progress: true,
      month,
      message: `${monthLabel(month)} is still in progress. The report will be available on ${new Date(parseInt(month.slice(0,4)), parseInt(month.slice(5,7)), 1).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`,
    })
  }

  // Load stored baseline
  const baseline = getEmailHealthBaseline(month)
  if (!baseline) {
    return NextResponse.json({
      no_baseline: true,
      month,
      message: `No baseline data for ${monthLabel(month)}. Go to Settings → Email Health to enter the monthly numbers.`,
    })
  }

  // Load previous month baseline for score delta
  const [prevY, prevM] = month.split('-').map(Number)
  const prevDate = new Date(prevY, prevM - 2, 1)
  const prevMonth = prevDate.toISOString().slice(0, 7)
  const prevBaseline = getEmailHealthBaseline(prevMonth)

  try {
    // ── Fetch live list data + workflow campaigns from GHL ──────────────────
    const [
      total,
      green, red, catchall, suspicious, freeEmail, notFound, bouncedTag, spamTag,
      neverEngaged, slipping, neverSent,
      google, microsoft, yahoo, otherProvider,
      workflows,
      greenAndSlipping, greenAndNeverEngaged, slippingAndNeverEngaged,
    ] = await Promise.all([
      getTotalContacts(apiKey, locationId),
      countByTag(apiKey, locationId, 'hti status = green (send responsibly)'),
      countByTag(apiKey, locationId, 'hti status = red (do not send)'),
      countByTag(apiKey, locationId, 'hti quality check = is catchall domain'),
      countByTag(apiKey, locationId, 'hti quality check = is suspicious'),
      countByTag(apiKey, locationId, 'hti quality check = is free'),
      countByTag(apiKey, locationId, 'hti valid check = not found'),
      countByTag(apiKey, locationId, '01. status -> email engagement manager: email bounced'),
      countByTag(apiKey, locationId, 'spam likely'),
      countByTag(apiKey, locationId, 'hti engagement check = never engaged'),
      countByTag(apiKey, locationId, 'hti engagement check = slipping'),
      countByTag(apiKey, locationId, 'hti engagement check = never sent'),
      countByTag(apiKey, locationId, 'hti email provider check = is google'),
      countByTag(apiKey, locationId, 'hti email provider check = is microsoft'),
      countByTag(apiKey, locationId, 'hti email provider check = is yahoo'),
      countByTag(apiKey, locationId, 'hti email provider check = is other email provider'),
      fetchWorkflowCampaigns(apiKey, locationId),
      countByAllTags(apiKey, locationId, 'hti status = green (send responsibly)',      'hti engagement check = slipping'),
      countByAllTags(apiKey, locationId, 'hti status = green (send responsibly)',      'hti engagement check = never engaged'),
      countByAllTags(apiKey, locationId, 'hti engagement check = slipping',            'hti engagement check = never engaged'),
    ])

    // Deduplicate engagement segments using priority: neverEngaged > slipping > green
    // A contact with a stale "green" tag who is now slipping or never-engaged belongs in the worse bucket
    const trueGreen       = Math.max(0, green    - greenAndSlipping    - greenAndNeverEngaged)
    const trueSlipping    = Math.max(0, slipping - slippingAndNeverEngaged)
    const trueNeverEngaged = neverEngaged  // top priority — no deduction
    const trueNeverSent   = neverSent      // separate dimension — not engagement-based

    // ── Scores ─────────────────────────────────────────────────────────────
    const strictScore  = baseline.strict_score
    const relaxedScore = baseline.relaxed_score
    const scoreDelta   = prevBaseline ? strictScore - prevBaseline.strict_score : null

    // ── Engagement metrics from baseline ───────────────────────────────────
    const existingMailed  = baseline.existing_mailed
    const newMailed       = baseline.new_mailed
    const existingOpened  = Math.round(existingMailed * baseline.open_rate / 100)
    const existingClicked = Math.round(existingMailed * baseline.click_rate / 100)
    const existingNotOpen = existingMailed - existingOpened
    const existingNotClick= existingMailed - existingClicked
    const newOpened       = Math.round(newMailed * baseline.open_rate / 100)
    const newClicked      = Math.round(newMailed * baseline.click_rate / 100)
    const newNotOpen      = newMailed - newOpened
    const newNotClick     = newMailed - newClicked

    // ── Segment counts (of existing mailed) ────────────────────────────────
    // Engaged in last 90 days = baseline.engaged_90d
    // Not engaged in 90d = existing_mailed - engaged_90d
    const engaged90d         = baseline.engaged_90d
    const notEngaged90d      = existingMailed - engaged90d
    // Liabilities = mailed contacts not engaged in last 90 days (accurate: from baseline engaged_90d)
    // We cannot compute worst-liabilities (never/1yr+) for the mailed subset without per-contact data
    const liabilities        = notEngaged90d  // existingMailed - engaged_90d

    // ── List health ────────────────────────────────────────────────────────
    const marketable   = Math.max(0, total - red)
    const scanned      = google + microsoft + yahoo + otherProvider || total

    const pctOf = (n: number, d: number) => d > 0 ? (n / d * 100).toFixed(1) : '0'
    const pct   = (n: number, d = total) => d > 0 ? (n / d * 100).toFixed(1) : '0'

    // ── Score delta text ────────────────────────────────────────────────────
    const deltaText = scoreDelta !== null
      ? scoreDelta > 0 ? `improved by ${scoreDelta} points since ${monthLabel(prevMonth)}`
        : scoreDelta < 0 ? `declined by ${Math.abs(scoreDelta)} points since ${monthLabel(prevMonth)}`
        : `unchanged from ${monthLabel(prevMonth)}`
      : 'no prior month comparison available'

    // ── AI prompt ──────────────────────────────────────────────────────────
    const dataCtx = `
Email Health Report — ${monthLabel(month)} (${month})
Domain: ${domain}

SCORES:
Strict Score: ${strictScore}/999 (${scoreLabel(strictScore)}) — ${deltaText}
Relaxed Score: ${relaxedScore}/999 (${scoreLabel(relaxedScore)})

EXISTING CONTACTS MAILED: ${existingMailed.toLocaleString()}
Opened: ${existingOpened.toLocaleString()} (${pctOf(existingOpened, existingMailed)}%)
Did not open: ${existingNotOpen.toLocaleString()}
Clicked: ${existingClicked.toLocaleString()} (${pctOf(existingClicked, existingMailed)}%)
Did not click: ${existingNotClick.toLocaleString()} (${pctOf(existingNotClick, existingMailed)}%)
Engaged in last 90 days (relaxed): ${engaged90d.toLocaleString()} (${pctOf(engaged90d, existingMailed)}%)
Not engaged / at-risk (90d+): ${liabilities.toLocaleString()} (${pctOf(liabilities, existingMailed)}%)

NEW CONTACTS MAILED: ${newMailed.toLocaleString()}
Opened: ${newOpened.toLocaleString()} (${pctOf(newOpened, newMailed)}%)
Did not open: ${newNotOpen.toLocaleString()}
Clicked: ${newClicked.toLocaleString()} (${pctOf(newClicked, newMailed)}%)
Did not click: ${newNotClick.toLocaleString()}

CAMPAIGN PERFORMANCE (${monthLabel(month)}):
Emails Delivered: ${baseline.delivered.toLocaleString()}
Open Rate: ${baseline.open_rate.toFixed(2)}%
Click Rate: ${baseline.click_rate.toFixed(2)}%
Bounce Rate: ${baseline.delivered > 0 ? (baseline.bounced / baseline.delivered * 100).toFixed(3) : 0}%
Spam Complaints: ${baseline.spam} (${baseline.delivered > 0 ? (baseline.spam / baseline.delivered * 100).toFixed(4) : 0}%)
Unsubscribed: ${baseline.unsub}

FULL LIST SNAPSHOT (current):
Total contacts: ${total.toLocaleString()}
Green/Safe to send: ${green.toLocaleString()} (${pct(green)}%)
Red/Do not send: ${red.toLocaleString()} (${pct(red)}%)
Marketable: ${marketable.toLocaleString()}
Never sent: ${neverSent.toLocaleString()} | Never engaged: ${neverEngaged.toLocaleString()}

EMAIL PROVIDERS:
Gmail: ${google.toLocaleString()} (${pct(google, scanned)}%)
Yahoo: ${yahoo.toLocaleString()} (${pct(yahoo, scanned)}%)
Microsoft: ${microsoft.toLocaleString()} (${pct(microsoft, scanned)}%)
Other: ${otherProvider.toLocaleString()} (${pct(otherProvider, scanned)}%)

QUALITY FLAGS:
Catchall: ${catchall.toLocaleString()} | Suspicious: ${suspicious.toLocaleString()} | Free email: ${freeEmail.toLocaleString()}
Invalid/Not found: ${notFound.toLocaleString()} | Bounced: ${bouncedTag.toLocaleString()} | Spam risk: ${spamTag.toLocaleString()}
`

    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 5000,
      messages: [
        {
          role: 'system',
          content: `You are writing a monthly email health report for Phoenix Home Remodeling (home remodeling, Phoenix AZ).

TONE & FORMAT: Match HitTheInbox (HTI) exactly — direct, revenue-focused, confident, specific numbers. No fluff. Every sentence earns its place.

CRITICAL RULES:
- The ONLY contacts that matter for revenue analysis are the ones actually MAILED (existing_mailed + new_leads_mailed). Do NOT frame total database size, red/DND counts, never-engaged, or never-sent totals as revenue problems — those contacts are already suppressed and have zero effect on deliverability or revenue.
- Problems must only come from mailed contacts: open rate, click rate, bounce rate, spam complaints, or deliverability signals for the actual sends that happened.
- Never cite the total contact count or red/DND population as a problem. List hygiene metrics (never-engaged, red, never-sent) belong only in the List Health section, not in problems.

Return valid JSON only.`,
        },
        {
          role: 'user',
          content: `Generate the email health analysis for ${monthLabel(month)}. Return JSON with exactly these keys:

- executive_summary: A comprehensive 3-paragraph executive summary in HTI style.
  Paragraph 1 (2-3 sentences): Open with "Your Email Health Score for ${monthLabel(month)} is ${strictScore}/999 (${scoreLabel(strictScore)})." State the score change vs prior month. One sentence framing the overall picture for the ${(existingMailed + newMailed).toLocaleString()} contacts mailed this month.
  Paragraph 2 — Good news (start with "Good news that works in your favor:"): 4-6 sentences each on its own line. Cover: relaxed score of ${relaxedScore}, score change, new contact clicks (${newClicked} of ${newMailed}), domain/blocklist status, DMARC compliance, open rate, low bounce/spam. Use exact numbers from data.
  Paragraph 3 — Issues (start with "Lack of engagement can damage your sending reputation:"): 4-6 sentences each on its own line covering ONLY mailed-contact issues with exact counts: existing contacts who didn't open, who didn't click, ${liabilities} at-risk contacts (not engaged in 90d+) in the mailed pool, new contacts who didn't engage. No DND/red/never-sent totals.

- good_news: array of 5-7 strings — each citing specific numbers. Cover: relaxed score, score improvement, new contact open/click rates, domain health, DMARC, bounce rate, spam rate, any positive trend vs prior month.

- problems: array of {title, description} objects — 3-4 items. ONLY from mailed contacts. Include exact counts. Examples: "${existingNotClick.toLocaleString()} existing contacts didn't click", "${liabilities.toLocaleString()} mailed contacts haven't engaged in 90+ days", new contacts who didn't open/click.

- actions_new_contacts: array of 5-7 detailed action strings. Be specific with counts from the data (${newNotOpen} didn't open, ${newNotClick} didn't click). Mirror HTI style: reach out to the X who didn't open, verify emails, drive clicks, weekly cadence, content tips, thank-you page instructions.

- actions_existing_contacts: array of 6-8 detailed action strings. Be specific with counts. Mirror HTI style: DRIVE THE CLICK campaign for ${existingNotClick.toLocaleString()} who haven't clicked, IS THIS GOOD-BYE re-engagement campaign for ${liabilities.toLocaleString()} contacts not engaged in 90+ days, weekly email cadence, content strategies.

- actions_maintenance: array of 2-3 ongoing best practice strings.
- analyst_note: 1-2 sentences — the single most important insight from this month's actual sends.

Data:\n${dataCtx}`,
        },
      ],
    })

    let analysis: Record<string, any> = {}
    try {
      const raw = completion.choices[0].message.content || '{}'
      const match = raw.match(/\{[\s\S]*\}/)
      analysis = match ? JSON.parse(match[0]) : {}
    } catch { analysis = {} }

    // ── Workflow monthly deltas via snapshots ──────────────────────────────
    // End of report month and end of previous month
    const [wy, wm] = month.split('-').map(Number)
    const endOfMonth    = `${month}-${String(new Date(wy, wm, 0).getDate()).padStart(2, '0')}`
    const prevMonthEnd  = new Date(wy, wm - 2, 1)
    const prevMonthEndStr = `${prevMonthEnd.getFullYear()}-${String(prevMonthEnd.getMonth() + 1).padStart(2, '0')}-${String(new Date(prevMonthEnd.getFullYear(), prevMonthEnd.getMonth() + 1, 0).getDate()).padStart(2, '0')}`

    let workflowsWithDeltas: any[] = (workflows as any[])
    let workflowsAreMonthly = false
    const workflowsComputed = (workflows as any[]).map((w: any) => {
      const snapEnd   = getClosestSnapshot(endOfMonth,     locationId, w.sourceId)
      const snapStart = getClosestSnapshot(prevMonthEndStr, locationId, w.sourceId)
      if (snapEnd && snapStart) {
        workflowsAreMonthly = true
        const sent    = Math.max(0, snapEnd.sent    - snapStart.sent)
        const opened  = Math.max(0, snapEnd.opened  - snapStart.opened)
        const clicked = Math.max(0, snapEnd.clicked - snapStart.clicked)
        const bounced = Math.max(0, snapEnd.bounced - snapStart.bounced)
        if (sent === 0) return null
        return { ...w, sent, opened, clicked, bounced,
          openRate:  parseFloat((opened  / sent * 100).toFixed(1)),
          clickRate: parseFloat((clicked / sent * 100).toFixed(1)),
          is_monthly: true }
      }
      return { ...w, is_monthly: false }
    }).filter(Boolean)
    // When monthly mode is active, drop campaigns without snapshot data (all-time fallbacks)
    workflowsWithDeltas = workflowsAreMonthly
      ? workflowsComputed.filter((w: any) => w.is_monthly)
      : workflowsComputed

    // ── 12-month workflow history ──────────────────────────────────────────
    // Load all snapshots once, then compute monthly totals in memory
    const allSnaps = getAllSnapshots(locationId)
    // Build per-sourceId map: sourceId → snapshots sorted ascending by date
    const snapsBySource: Record<string, Array<{snapshot_date:string,sent:number,opened:number,clicked:number,bounced:number}>> = {}
    for (const s of allSnaps as any[]) {
      if (!snapsBySource[s.source_id]) snapsBySource[s.source_id] = []
      snapsBySource[s.source_id].push(s)
    }
    for (const k of Object.keys(snapsBySource)) {
      snapsBySource[k].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
    }
    // Helper: find closest snapshot on or before targetDate for a sourceId
    const closestInMem = (sid: string, targetDate: string) => {
      const snaps = snapsBySource[sid] || []
      let result: typeof snaps[0] | null = null
      for (const s of snaps) { if (s.snapshot_date <= targetDate) result = s; else break }
      return result
    }
    // Build last 12 months list (oldest → newest)
    const now12 = new Date()
    const last12Months: string[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now12.getFullYear(), now12.getMonth() - i, 1)
      last12Months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)
    }
    const workflowHistory = last12Months.map(m => {
      const [hy, hmo] = m.split('-').map(Number)
      const hEnd      = `${m}-${String(new Date(hy, hmo, 0).getDate()).padStart(2,'0')}`
      const hPrevM    = new Date(hy, hmo - 2, 1)
      const hPrevEnd  = `${hPrevM.getFullYear()}-${String(hPrevM.getMonth()+1).padStart(2,'0')}-${String(new Date(hPrevM.getFullYear(), hPrevM.getMonth()+1, 0).getDate()).padStart(2,'0')}`
      let sent = 0, opened = 0, clicked = 0, hasData = false
      for (const w of workflows as any[]) {
        const sid = w.sourceId
        const se = closestInMem(sid, hEnd)
        const ss = closestInMem(sid, hPrevEnd)
        if (se && ss) {
          sent    += Math.max(0, se.sent    - ss.sent)
          opened  += Math.max(0, se.opened  - ss.opened)
          clicked += Math.max(0, se.clicked - ss.clicked)
          hasData = true
        }
      }
      const label = new Date(m + '-15').toLocaleString('default', { month:'short', year:'2-digit' })
      return { month: m, label, sent, opened, clicked, has_data: hasData }
    })

    const reportPayload = {
      generated_at: new Date().toISOString(),
      month,
      month_label: monthLabel(month),
      domain,

      // Scores
      strict_score: strictScore,
      relaxed_score: relaxedScore,
      score_label: scoreLabel(strictScore),
      relaxed_label: scoreLabel(relaxedScore),
      score_delta: scoreDelta,
      score_delta_text: deltaText,
      prev_month: prevMonth,
      prev_score: prevBaseline?.strict_score ?? null,

      // Existing contacts
      existing: {
        mailed:      existingMailed,
        opened:      existingOpened,
        not_opened:  existingNotOpen,
        clicked:     existingClicked,
        not_clicked: existingNotClick,
        open_pct:    parseFloat(pctOf(existingOpened,   existingMailed)),
        click_pct:   parseFloat(pctOf(existingClicked,  existingMailed)),
        engaged_90d: engaged90d,
        not_engaged_90d: notEngaged90d,
        liabilities,
      },

      // New contacts
      new_leads: {
        mailed:      newMailed,
        opened:      newOpened,
        not_opened:  newNotOpen,
        clicked:     newClicked,
        not_clicked: newNotClick,
        open_pct:    parseFloat(pctOf(newOpened,  newMailed)),
        click_pct:   parseFloat(pctOf(newClicked, newMailed)),
      },

      // Campaign stats from baseline
      stats: {
        delivered:   baseline.delivered,
        open_rate:   baseline.open_rate,
        click_rate:  parseFloat(baseline.click_rate.toFixed(2)),
        bounce_rate: baseline.delivered > 0 ? parseFloat((baseline.bounced / baseline.delivered * 100).toFixed(3)) : 0,
        spam_rate:   baseline.delivered > 0 ? parseFloat((baseline.spam    / baseline.delivered * 100).toFixed(4)) : 0,
        unsub_rate:  baseline.delivered > 0 ? parseFloat((baseline.unsub   / baseline.delivered * 100).toFixed(3)) : 0,
        bounced:     baseline.bounced,
        spam:        baseline.spam,
        unsub:       baseline.unsub,
      },

      // List health (deduplicated by priority: neverEngaged > slipping > green)
      list: {
        total, marketable,
        green: trueGreen,
        red,
        slipping: trueSlipping, never_engaged: trueNeverEngaged, never_sent: trueNeverSent,
        catchall, suspicious, free_email: freeEmail, not_found: notFound,
        bounced_tag: bouncedTag, spam_tag: spamTag,
      },

      // Providers (live snapshot)
      providers: { google, microsoft, yahoo, other: otherProvider, scanned },

      // Workflow campaign details
      workflows: workflowsWithDeltas,
      workflows_are_monthly: workflowsAreMonthly,
      workflow_history: workflowHistory,

      analysis,
    }

    // Cache report to DB for instant reloading
    try { saveEmailHealthReport(month, JSON.stringify(reportPayload)) } catch {}

    return NextResponse.json(reportPayload)

  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
