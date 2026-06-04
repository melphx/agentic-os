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

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json({
    configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
    domain: process.env.GHL_DOMAIN || 'phxhomeremodeling.com',
  })
}

// ── Tag-based count query (accurate, no full contact pull needed) ──────────

async function countByTag(apiKey: string, locationId: string, tag: string): Promise<number> {
  try {
    const res = await fetch('https://services.leadconnectorhq.com/contacts/search', {
      method: 'POST',
      headers: { ...GHL(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId, pageLimit: 1, filters: [{ field: 'tags', operator: 'contains', value: tag }] }),
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
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

// ── Score calculation ──────────────────────────────────────────────────────

function calcScore(data: Record<string, number>): number {
  const total = data.total || 1
  const redPct       = data.red / total * 100
  const greenPct     = data.green / total * 100
  const neverEngPct  = data.neverEngaged / total * 100
  const spamPct      = data.spam / total * 100
  const bouncePct    = data.bounced / total * 100

  let score = 700

  // Red contacts (do not send) — huge penalty
  if (redPct > 50)      score -= 300
  else if (redPct > 30) score -= 200
  else if (redPct > 15) score -= 100
  else if (redPct > 5)  score -= 50

  // Green contacts — reward
  if (greenPct > 50)    score += 150
  else if (greenPct > 25) score += 80
  else if (greenPct > 10) score += 20
  else                  score -= 80

  // Never engaged
  if (neverEngPct > 40) score -= 150
  else if (neverEngPct > 25) score -= 80
  else if (neverEngPct > 10) score -= 30

  // Spam risk (industry threshold: <0.1%)
  if (spamPct > 5)  score -= 150
  else if (spamPct > 2) score -= 80
  else if (spamPct > 0.5) score -= 30

  // Bounces
  if (bouncePct > 5)  score -= 100
  else if (bouncePct > 2) score -= 50

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
  const apiKey     = (body.ghl_api_key  || process.env.GHL_API_KEY     || '').trim()
  const locationId = (body.location_id  || process.env.GHL_LOCATION_ID || '').trim()
  const domain     = (body.domain       || process.env.GHL_DOMAIN       || 'phxhomeremodeling.com').trim()

  if (!apiKey || !locationId) return NextResponse.json({ error: 'ghl_api_key and location_id required' }, { status: 400 })

  try {
    // Run all tag queries in parallel — fast, no full contact pull needed
    const [
      total,
      google, microsoft, yahoo, otherProvider,
      newContacts, neverEngaged, neverSent,
      green, red, catchall, suspicious, freeEmail, notFound, bounced, spam,
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
    ])

    const scannedTotal = google + microsoft + yahoo + otherProvider || total
    const pct = (n: number, d = total) => d > 0 ? (n / d * 100).toFixed(1) : '0'

    const data = { total, red, green, neverEngaged, spam, bounced }
    const healthScore = calcScore(data)

    const active = Math.max(0, green - newContacts)
    const cold   = Math.max(0, total - green - red - neverEngaged - neverSent)

    const dataCtx = `
Email Health Report for ${domain} — ${new Date().toLocaleDateString('en-US', { month:'long', year:'numeric' })}

SUBSCRIBER DATABASE: ${total.toLocaleString()} total contacts
HitTheInbox scan data:

SEND STATUS:
- Green (safe to send): ${green.toLocaleString()} (${pct(green)}%)
- Red (do not send): ${red.toLocaleString()} (${pct(red)}%) ← CRITICAL
- New contacts: ${newContacts.toLocaleString()}

ENGAGEMENT:
- Never engaged: ${neverEngaged.toLocaleString()} (${pct(neverEngaged)}%)
- Never even sent to: ${neverSent.toLocaleString()} (${pct(neverSent)}%)

EMAIL QUALITY:
- Invalid/not found: ${notFound.toLocaleString()}
- Bounced: ${bounced.toLocaleString()} (${pct(bounced)}%)
- Spam risk: ${spam.toLocaleString()} (${pct(spam)}%)
- Catchall domains: ${catchall.toLocaleString()}
- Suspicious addresses: ${suspicious.toLocaleString()}

EMAIL PROVIDERS (of ${scannedTotal.toLocaleString()} scanned):
- Google: ${google.toLocaleString()} (${pct(google, scannedTotal)}%)
- Yahoo: ${yahoo.toLocaleString()} (${pct(yahoo, scannedTotal)}%)
- Microsoft: ${microsoft.toLocaleString()} (${pct(microsoft, scannedTotal)}%)
- Other: ${otherProvider.toLocaleString()} (${pct(otherProvider, scannedTotal)}%)

HEALTH SCORE: ${healthScore}/999 (${scoreLabel(healthScore)})
KEY CONCERN: ${pct(red)}% of your list is tagged "do not send" by HitTheInbox.
`

    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2000,
      messages: [
        { role: 'system', content: 'You are an email deliverability expert writing a monthly health report for Phoenix Home Remodeling (home remodeling company in Phoenix, AZ). Be direct, specific with numbers, business-focused. This data comes from HitTheInbox tags applied to contacts in GoHighLevel CRM. Return valid JSON only.' },
        { role: 'user', content: `Write analysis for this email health report. Return JSON with: analyst_notes (2-3 sentences with specific numbers), top_priority (one urgent action), actions_urgent (array of 3 strings), actions_medium (array of 3 strings), score_explanation (one sentence).

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
      segments: { total, new: newContacts, active, warmingUp: 0, cold, dead: neverEngaged, neverEngaged, spamRisk: spam },
      quality: { green, red, catchall, suspicious, freeEmail, notFound, bounced, spam },
      providers: { google, microsoft, yahoo, other: otherProvider, scanned: scannedTotal },
      stats: { campaigns_analyzed: campaignStats.campaigns, total_sent: campaignStats.sent, open_rate: parseFloat(campaignStats.openRate.toFixed(1)), click_rate: parseFloat(campaignStats.clickRate.toFixed(1)), bounce_rate: parseFloat(campaignStats.bounceRate.toFixed(2)), spam_rate: parseFloat(campaignStats.complaintRate.toFixed(3)), unsub_rate: parseFloat(campaignStats.unsubRate.toFixed(2)), note: campaignStats.campaigns === 0 ? 'No workflow campaigns found for this period.' : null },
      analysis,
    })
  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
