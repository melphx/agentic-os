import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import OpenAI from 'openai'

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

// ── Fetch email campaign stats ─────────────────────────────────────────────

async function fetchCampaignStats(apiKey: string, locationId: string) {
  const campaigns: any[] = []

  // Try v2 email campaigns endpoint
  const endpoints = [
    `https://services.leadconnectorhq.com/emails/builder/campaigns?location_id=${locationId}&limit=50&status=sent`,
    `https://services.leadconnectorhq.com/emails/builder/campaigns?location_id=${locationId}&limit=50`,
  ]

  for (const url of endpoints) {
    const res = await fetch(url, { headers: GHL(apiKey), signal: AbortSignal.timeout(20000), cache: 'no-store' })
    if (res.ok) {
      const d = await res.json() as Record<string, any>
      const items = d.campaigns || d.data || d.list || []
      if (items.length > 0) { campaigns.push(...items); break }
    }
  }

  // Aggregate stats across all campaigns
  let totalSent = 0, totalOpened = 0, totalClicked = 0, totalBounced = 0, totalSpam = 0, totalUnsubscribed = 0

  for (const c of campaigns) {
    // Handle different stat shapes GHL returns
    const s = c.stats || c.statistics || c
    totalSent        += s.sentCount   || s.sent        || s.total     || 0
    totalOpened      += s.openCount   || s.opened      || s.opens     || 0
    totalClicked     += s.clickCount  || s.clicked     || s.clicks    || 0
    totalBounced     += s.bounceCount || s.bounced     || s.bounces   || 0
    totalSpam        += s.spamCount   || s.spam        || s.complaints|| 0
    totalUnsubscribed+= s.unsubCount  || s.unsubscribed|| 0
  }

  return { campaigns: campaigns.length, totalSent, totalOpened, totalClicked, totalBounced, totalSpam, totalUnsubscribed }
}

// ── Fetch contact engagement summary (aggregate, not full contact list) ────

async function fetchContactSummary(apiKey: string, locationId: string) {
  // Use search endpoint with engagement filters to get counts — much more efficient
  const summary = { total: 0, active30d: 0, cold90d: 0, dead1yr: 0, new30d: 0 }

  try {
    // Get total contacts count
    const totalRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`,
      { headers: GHL(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
    )
    if (totalRes.ok) {
      const d = await totalRes.json() as Record<string, any>
      summary.total = d.total || d.meta?.total || d.contacts?.length || 0
    }

    // Get a sample of recent contacts for engagement analysis
    const sampleRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100&sortBy=dateAdded&sortOrder=desc`,
      { headers: GHL(apiKey), signal: AbortSignal.timeout(15000), cache: 'no-store' }
    )
    if (sampleRes.ok) {
      const d = await sampleRes.json() as Record<string, any>
      const contacts = d.contacts || []
      const now = Date.now()
      const day = 86400000
      for (const c of contacts) {
        const lastActivity = c.lastActivity ? (now - new Date(c.lastActivity).getTime()) / day : 999
        const addedDaysAgo  = c.dateAdded   ? (now - new Date(c.dateAdded).getTime())    / day : 999
        if (addedDaysAgo <= 30)    summary.new30d++
        if (lastActivity <= 30)    summary.active30d++
        if (lastActivity > 90 && lastActivity <= 365) summary.cold90d++
        if (lastActivity > 365)    summary.dead1yr++
      }
      // Scale estimates if we only have a sample
      if (summary.total > 100) {
        const scale = summary.total / contacts.length
        summary.new30d    = Math.round(summary.new30d    * scale)
        summary.active30d = Math.round(summary.active30d * scale)
        summary.cold90d   = Math.round(summary.cold90d   * scale)
        summary.dead1yr   = Math.round(summary.dead1yr   * scale)
      }
    }
  } catch (e) { console.error('[contact summary]', e) }

  return summary
}

// ── Score ──────────────────────────────────────────────────────────────────

function calcScore(r: number, c: number, b: number, s: number, coldPct: number): number {
  let score = 500
  score += r >= 30 ? 100 : r >= 20 ? 50 : r >= 10 ? 0 : -100
  score += c >= 5  ? 80  : c >= 2  ? 30 : -50
  score += b < 1   ? 50  : b < 2   ? 20 : -100
  score += s < 0.05 ? 80 : s < 0.1 ? 20 : -200
  score += coldPct < 10 ? 50 : coldPct < 25 ? 0 : -80
  return Math.max(0, Math.min(999, score))
}

function scoreLabel(n: number) {
  return n >= 800 ? 'Excellent' : n >= 650 ? 'Good' : n >= 500 ? 'Needs Improvement' : n >= 300 ? 'Poor' : 'Critical'
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json()
  const apiKey     = (body.ghl_api_key  || '').trim()
  const locationId = (body.location_id  || '').trim()
  const domain     = (body.domain       || 'phxhomeremodeling.com').trim()

  if (!apiKey || !locationId) return NextResponse.json({ error: 'ghl_api_key and location_id required' }, { status: 400 })

  try {
    const [campaignData, contacts] = await Promise.all([
      fetchCampaignStats(apiKey, locationId),
      fetchContactSummary(apiKey, locationId),
    ])

    const { totalSent, totalOpened, totalClicked, totalBounced, totalSpam, totalUnsubscribed, campaigns } = campaignData
    const openRate        = totalSent > 0 ? totalOpened   / totalSent * 100 : 0
    const clickRate       = totalSent > 0 ? totalClicked  / totalSent * 100 : 0
    const bounceRate      = totalSent > 0 ? totalBounced  / totalSent * 100 : 0
    const spamRate        = totalSent > 0 ? totalSpam     / totalSent * 100 : 0
    const unsubRate       = totalSent > 0 ? totalUnsubscribed / totalSent * 100 : 0
    const coldPct         = contacts.total > 0 ? (contacts.cold90d + contacts.dead1yr) / contacts.total * 100 : 0
    const healthScore     = calcScore(openRate, clickRate, bounceRate, spamRate, coldPct)

    const dataCtx = `
Email Health Report for ${domain} (${new Date().toLocaleDateString('en-US', { month:'long', year:'numeric' })})

CAMPAIGN PERFORMANCE (${campaigns} campaigns analysed):
- Emails sent: ${totalSent.toLocaleString()}
- Open rate: ${openRate.toFixed(1)}% (industry avg ~25%)
- Click rate: ${clickRate.toFixed(1)}% (industry avg ~3%)
- Bounce rate: ${bounceRate.toFixed(2)}% (acceptable: <2%)
- Spam complaint rate: ${spamRate.toFixed(3)}% (Google limit: 0.10%)
- Unsubscribe rate: ${unsubRate.toFixed(2)}%

SUBSCRIBER HEALTH (${contacts.total.toLocaleString()} total contacts):
- New in last 30 days: ~${contacts.new30d}
- Active (engaged last 30 days): ~${contacts.active30d}
- Cold (90 days – 1 year no engagement): ~${contacts.cold90d}
- Dead weight (over 1 year / never engaged): ~${contacts.dead1yr}
- Cold subscriber %: ${coldPct.toFixed(0)}%

HEALTH SCORE: ${healthScore}/999 (${scoreLabel(healthScore)})
`

    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: 'You are an email deliverability expert writing a monthly health report for Phoenix Home Remodeling. Be direct, specific with numbers, and business-focused. Return valid JSON only.' },
        { role: 'user', content: `Analyse this data and return a JSON object with these exact keys: analyst_notes (2-3 sentences), top_priority (one sentence), actions_urgent (array of 3 strings), actions_medium (array of 3 strings), score_explanation (one sentence).

${dataCtx}` }
      ]
    })

    let analysis: Record<string, any> = {}
    try {
      const raw = completion.choices[0].message.content || '{}'
      const match = raw.match(/\{[\s\S]*\}/)
      analysis = match ? JSON.parse(match[0]) : { analyst_notes: raw }
    } catch { analysis = { analyst_notes: completion.choices[0].message.content || '' } }

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      domain,
      health_score: healthScore,
      score_label: scoreLabel(healthScore),
      segments: {
        total: contacts.total,
        new: contacts.new30d,
        active: contacts.active30d,
        cold: contacts.cold90d,
        dead: contacts.dead1yr,
        warmingUp: 0,
        neverOpened: contacts.dead1yr,
      },
      stats: {
        campaigns_analyzed: campaigns,
        total_sent: totalSent,
        open_rate: parseFloat(openRate.toFixed(1)),
        click_rate: parseFloat(clickRate.toFixed(1)),
        bounce_rate: parseFloat(bounceRate.toFixed(2)),
        spam_rate: parseFloat(spamRate.toFixed(3)),
        unsub_rate: parseFloat(unsubRate.toFixed(2)),
      },
      analysis,
    })
  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
