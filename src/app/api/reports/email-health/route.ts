import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
  timeout: 120000,
})
const MODEL = process.env.OPENAI_MODEL || 'gpt-5.4'

const GHL_HEADERS_V2 = (apiKey: string) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2021-07-28',
  // No Content-Type on GET requests — GHL v2 rejects it
})
const GHL_HEADERS_V1 = (apiKey: string) => ({
  'Authorization': `Bearer ${apiKey}`,
})

// ── GHL data fetchers — tries v2 first, falls back to v1 ──────────────────

async function fetchContacts(apiKey: string, locationId: string, limit = 100) {
  // GHL v2 max is 100 per page — enforce it
  const pageSize = Math.min(limit, 100)
  // Try v2 first
  const v2 = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=${pageSize}`,
    { headers: GHL_HEADERS_V2(apiKey), signal: AbortSignal.timeout(20000), cache: 'no-store' }
  )
  if (v2.ok) {
    const data = await v2.json() as Record<string, any>
    return data.contacts || []
  }
  // Log v2 failure for debugging
  const v2Err = await v2.text().catch(() => '')
  console.error('[GHL v2 contacts]', v2.status, v2Err.slice(0, 200))
  // Do NOT fall back to v1 for PIT tokens (pit-...) — they only work on v2
  if (apiKey.startsWith('pit-')) {
    throw new Error(`GHL contacts error: ${v2.status} — ${v2Err.slice(0, 200)}. Your PIT token may need 'contacts.readonly' scope. Go to GHL Settings → Integrations → Private Integrations → edit your integration → enable Contacts scope.`)
  }
  // Fall back to v1 for legacy API keys
  const v1 = await fetch(
    `https://rest.gohighlevel.com/v1/contacts/?locationId=${locationId}&limit=${limit}`,
    { headers: GHL_HEADERS_V1(apiKey), signal: AbortSignal.timeout(20000), cache: 'no-store' }
  )
  if (!v1.ok) {
    const errText = await v1.text().catch(() => '')
    throw new Error(`GHL contacts error: ${v1.status} — ${errText.slice(0, 200)}`)
  }
  const data = await v1.json() as Record<string, any>
  return data.contacts || []
}

async function fetchEmailCampaigns(apiKey: string, locationId: string) {
  try {
    // Try v2
    const v2 = await fetch(
      `https://services.leadconnectorhq.com/emails/builder/campaigns?location_id=${locationId}&limit=50`,
      { headers: GHL_HEADERS_V2(apiKey), signal: AbortSignal.timeout(20000) }
    )
    if (v2.ok) { const d = await v2.json() as Record<string,any>; return d.campaigns || d.data || [] }
    // Try v1
    const v1 = await fetch(
      `https://rest.gohighlevel.com/v1/campaigns/?locationId=${locationId}`,
      { headers: GHL_HEADERS_V1(apiKey), signal: AbortSignal.timeout(20000) }
    )
    if (v1.ok) { const d = await v1.json() as Record<string,any>; return d.campaigns || [] }
    return []
  } catch { return [] }
}

async function fetchDomainReputation(domain: string) {
  // Check basic DNS/blocklist via public APIs
  try {
    const res = await fetch(`https://dns.google/resolve?name=${domain}&type=MX`, { signal: AbortSignal.timeout(8000) })
    const data = await res.json() as Record<string, any>
    return { hasMX: (data.Answer?.length || 0) > 0, status: data.Status === 0 ? 'ok' : 'error' }
  } catch { return { hasMX: false, status: 'unknown' } }
}

// ── Score calculation ──────────────────────────────────────────────────────

function calculateHealthScore(stats: Record<string, any>): number {
  let score = 500 // base
  const { openRate, clickRate, bounceRate, spamRate, coldPct, newEngagePct } = stats

  // Open rate scoring (industry avg ~25%)
  if (openRate >= 30) score += 100
  else if (openRate >= 20) score += 50
  else if (openRate >= 10) score += 0
  else score -= 100

  // Click rate (industry avg ~3%)
  if (clickRate >= 5) score += 80
  else if (clickRate >= 2) score += 30
  else score -= 50

  // Bounce rate (should be <2%)
  if (bounceRate < 1) score += 50
  else if (bounceRate < 2) score += 20
  else score -= 100

  // Spam rate (must be <0.1%)
  if (spamRate < 0.05) score += 80
  else if (spamRate < 0.1) score += 20
  else score -= 200

  // Cold subscribers
  if (coldPct < 10) score += 50
  else if (coldPct < 25) score += 0
  else score -= 80

  // New subscriber engagement
  if (newEngagePct > 70) score += 80
  else if (newEngagePct > 50) score += 30
  else score -= 50

  return Math.max(0, Math.min(999, score))
}

function getScoreLabel(score: number) {
  if (score >= 800) return 'Excellent'
  if (score >= 650) return 'Good'
  if (score >= 500) return 'Needs Improvement'
  if (score >= 300) return 'Poor'
  return 'Critical'
}

function segmentContacts(contacts: any[], days30: number = 30) {
  const now = Date.now()
  const day = 86400000
  const segments = {
    total: contacts.length,
    new: 0,           // added in last 30 days
    active: 0,        // engaged in last 30 days
    warmingUp: 0,     // engaged 30-90 days ago
    cold: 0,          // engaged 90 days - 1 year ago
    dead: 0,          // no engagement > 1 year or never
    neverOpened: 0,
  }

  for (const c of contacts) {
    const addedDaysAgo = c.dateAdded ? (now - new Date(c.dateAdded).getTime()) / day : 999
    const lastActivityDaysAgo = c.lastActivity ? (now - new Date(c.lastActivity).getTime()) / day : 999

    if (addedDaysAgo <= 30) segments.new++
    if (lastActivityDaysAgo <= 30) segments.active++
    else if (lastActivityDaysAgo <= 90) segments.warmingUp++
    else if (lastActivityDaysAgo <= 365) segments.cold++
    else segments.dead++

    if (!c.lastActivity && addedDaysAgo > 7) segments.neverOpened++
  }

  return segments
}

// ── Main report generator ──────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json()
  const ghl_api_key = (body.ghl_api_key || '').trim()
  const location_id = (body.location_id || '').trim()
  const domain = (body.domain || 'phxhomeremodeling.com').trim()
  console.log('[email-health] token prefix:', ghl_api_key.slice(0, 15), 'location:', location_id)
  if (!ghl_api_key || !location_id) {
    return NextResponse.json({ error: 'ghl_api_key and location_id required' }, { status: 400 })
  }

  try {
    // 1. Fetch data
    const [contacts, campaigns, domainInfo] = await Promise.all([
      fetchContacts(ghl_api_key, location_id, 100),
      fetchEmailCampaigns(ghl_api_key, location_id),
      fetchDomainReputation(domain),
    ])

    // 2. Segment contacts
    const segments = segmentContacts(contacts)

    // 3. Calculate campaign stats from available data
    let totalSent = 0, totalOpened = 0, totalClicked = 0, totalBounced = 0, totalSpam = 0
    for (const c of campaigns) {
      totalSent    += c.sentCount || c.stats?.sent || 0
      totalOpened  += c.openCount || c.stats?.opened || 0
      totalClicked += c.clickCount || c.stats?.clicked || 0
      totalBounced += c.bounceCount || c.stats?.bounced || 0
      totalSpam    += c.spamCount || c.stats?.spam || 0
    }

    const openRate   = totalSent > 0 ? (totalOpened  / totalSent * 100) : 0
    const clickRate  = totalSent > 0 ? (totalClicked / totalSent * 100) : 0
    const bounceRate = totalSent > 0 ? (totalBounced / totalSent * 100) : 0
    const spamRate   = totalSent > 0 ? (totalSpam    / totalSent * 100) : 0
    const coldPct    = segments.total > 0 ? ((segments.cold + segments.dead) / segments.total * 100) : 0
    const newEngagePct = segments.new > 0 ? (segments.active / segments.new * 100) : 50

    const statsPayload = { openRate, clickRate, bounceRate, spamRate, coldPct, newEngagePct }
    const healthScore  = calculateHealthScore(statsPayload)
    const scoreLabel   = getScoreLabel(healthScore)

    // 4. AI-generated analysis
    const dataContext = `
Email Health Report Data for ${domain}:

SUBSCRIBER SEGMENTS:
- Total contacts: ${segments.total}
- New subscribers (last 30 days): ${segments.new}
- Active subscribers (engaged last 30 days): ${segments.active}
- Warming up (engaged 30-90 days ago): ${segments.warmingUp}
- Cold subscribers (90 days - 1 year no engagement): ${segments.cold}
- Dead/inactive (over 1 year or never opened): ${segments.dead}
- Never opened: ${segments.neverOpened}

CAMPAIGN PERFORMANCE (last ${campaigns.length} campaigns):
- Total emails sent: ${totalSent}
- Open rate: ${openRate.toFixed(1)}%
- Click rate: ${clickRate.toFixed(1)}%
- Bounce rate: ${bounceRate.toFixed(2)}%
- Spam complaint rate: ${spamRate.toFixed(3)}%

DOMAIN:
- Domain: ${domain}
- MX records: ${domainInfo.hasMX ? 'Present' : 'Missing'}

CALCULATED SCORE: ${healthScore}/999 (${scoreLabel})
`

    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2000,
      messages: [{
        role: 'system',
        content: `You are an email deliverability expert writing a monthly health report for a home remodeling business. 
Write in a direct, business-focused tone. Be specific about numbers. Give clear, prioritized action items.
Structure your response as JSON with these keys: executive_summary, analyst_notes, top_priority, actions_urgent, actions_medium, score_explanation`
      }, {
        role: 'user',
        content: `Write the analysis section for this email health report:\n\n${dataContext}`
      }]
    })

    let analysis: Record<string, any> = {}
    try {
      const raw = completion.choices[0].message.content || '{}'
      const match = raw.match(/\{[\s\S]*\}/)
      analysis = match ? JSON.parse(match[0]) : { executive_summary: raw }
    } catch {
      analysis = { executive_summary: completion.choices[0].message.content || '' }
    }

    const report = {
      generated_at: new Date().toISOString(),
      domain,
      health_score: healthScore,
      score_label: scoreLabel,
      segments,
      stats: {
        campaigns_analyzed: campaigns.length,
        total_sent: totalSent,
        open_rate: parseFloat(openRate.toFixed(1)),
        click_rate: parseFloat(clickRate.toFixed(1)),
        bounce_rate: parseFloat(bounceRate.toFixed(2)),
        spam_rate: parseFloat(spamRate.toFixed(3)),
      },
      domain_info: domainInfo,
      analysis,
    }

    return NextResponse.json(report)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
