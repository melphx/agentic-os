export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json({
    configured: !!(process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID),
    domain: process.env.GHL_DOMAIN || 'phxhomeremodeling.com',
  })
}

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

// ── Fetch contacts with pagination (max 300 for performance) ──────────────

async function fetchContactSample(apiKey: string, locationId: string) {
  let allContacts: any[] = []
  let totalCount = 0

  // First get the total count
  const countRes = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=1`,
    { headers: GHL(apiKey), signal: AbortSignal.timeout(15000), cache: 'no-store' }
  )
  if (!countRes.ok) throw new Error(`GHL contacts error: ${countRes.status}`)
  const countData = await countRes.json() as Record<string, any>
  totalCount = countData.total || countData.meta?.total || 0

  // Fetch a sample of 100 for segmentation analysis
  const sampleRes = await fetch(
    `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=100`,
    { headers: GHL(apiKey), signal: AbortSignal.timeout(20000), cache: 'no-store' }
  )
  if (sampleRes.ok) {
    const d = await sampleRes.json() as Record<string, any>
    allContacts = d.contacts || []
  }

  return { contacts: allContacts, total: totalCount }
}

// ── Segment contacts using dateAdded, dateUpdated, and tags ───────────────

function segmentContacts(contacts: any[], total: number) {
  const now = Date.now()
  const day = 86400000
  const counts = { new30d: 0, active30d: 0, warmingUp: 0, cold: 0, dead: 0, neverEngaged: 0, spamRisk: 0 }

  for (const c of contacts) {
    const tags: string[] = (c.tags || []).map((t: string) => t.toLowerCase())
    const addedDays   = c.dateAdded   ? (now - new Date(c.dateAdded).getTime())   / day : 999
    const updatedDays = c.dateUpdated ? (now - new Date(c.dateUpdated).getTime()) / day : 999

    // Tag-based detection (highest accuracy)
    const neverEngaged = tags.some(t => t.includes('never engaged') || t.includes('never sent'))
    const recentlyEngaged = tags.some(t => t.includes('engaged') && !t.includes('never'))
    const spamFlag = tags.some(t => t.includes('spam') || t.includes('unsubscribed'))

    if (spamFlag) counts.spamRisk++
    if (neverEngaged) { counts.neverEngaged++; counts.dead++ }
    else if (addedDays <= 30) counts.new30d++
    else if (recentlyEngaged || updatedDays <= 30) counts.active30d++
    else if (updatedDays <= 90) counts.warmingUp++
    else if (updatedDays <= 365) counts.cold++
    else counts.dead++
  }

  // Scale from sample to full list
  const scale = contacts.length > 0 ? total / contacts.length : 1
  return {
    total,
    new: Math.round(counts.new30d   * scale),
    active: Math.round(counts.active30d * scale),
    warmingUp: Math.round(counts.warmingUp * scale),
    cold: Math.round(counts.cold    * scale),
    dead: Math.round(counts.dead    * scale),
    neverEngaged: Math.round(counts.neverEngaged * scale),
    spamRisk: Math.round(counts.spamRisk * scale),
  }
}

// ── Score calculation ──────────────────────────────────────────────────────

function calcScore(segments: ReturnType<typeof segmentContacts>, hasCampaignData: boolean): number {
  let score = 600
  const coldPct = segments.total > 0 ? (segments.cold + segments.dead) / segments.total * 100 : 0
  const activePct = segments.total > 0 ? segments.active / segments.total * 100 : 0
  const spamPct = segments.total > 0 ? segments.spamRisk / segments.total * 100 : 0

  // Active engagement
  if (activePct >= 50) score += 150
  else if (activePct >= 30) score += 80
  else if (activePct >= 15) score += 20
  else score -= 100

  // Cold/dead weight
  if (coldPct < 10) score += 100
  else if (coldPct < 25) score += 30
  else if (coldPct < 40) score -= 50
  else score -= 150

  // Spam risk contacts
  if (spamPct > 5) score -= 100
  else if (spamPct > 2) score -= 50

  // Penalise if no campaign data (can't fully assess)
  if (!hasCampaignData) score -= 70

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
  // Use provided values, fall back to env vars
  const apiKey     = (body.ghl_api_key  || process.env.GHL_API_KEY     || '').trim()
  const locationId = (body.location_id  || process.env.GHL_LOCATION_ID || '').trim()
  const domain     = (body.domain       || process.env.GHL_DOMAIN       || 'phxhomeremodeling.com').trim()

  if (!apiKey || !locationId) return NextResponse.json({ error: 'ghl_api_key and location_id required. Set GHL_API_KEY and GHL_LOCATION_ID in .env.local or enter them in the form.' }, { status: 400 })

  try {
    const { contacts, total } = await fetchContactSample(apiKey, locationId)
    const segments = segmentContacts(contacts, total)
    const hasCampaignData = false // Campaign stats require additional GHL API scope
    const healthScore = calcScore(segments, hasCampaignData)

    const coldPct   = segments.total > 0 ? ((segments.cold + segments.dead) / segments.total * 100).toFixed(0) : '0'
    const activePct = segments.total > 0 ? (segments.active / segments.total * 100).toFixed(0) : '0'
    const newPct    = segments.total > 0 ? (segments.new    / segments.total * 100).toFixed(0) : '0'

    const dataCtx = `
Email Health Report for ${domain} — ${new Date().toLocaleDateString('en-US', { month:'long', year:'numeric' })}

SUBSCRIBER DATABASE: ${total.toLocaleString()} total contacts
- New subscribers (added last 30 days): ~${segments.new} (${newPct}%)
- Active (recently engaged): ~${segments.active} (${activePct}%)
- Warming up (30-90 days): ~${segments.warmingUp}
- Cold (90 days - 1 year no activity): ~${segments.cold}
- Dead weight / never engaged: ~${segments.dead}
- Spam risk contacts: ~${segments.spamRisk}
- Cold + dead %: ${coldPct}% of total list

NOTES:
- Segmentation based on contact activity dates and engagement tags from GHL
- Email campaign statistics unavailable (requires campaign API scope)
- Sample: 100 contacts analysed, scaled to full list of ${total.toLocaleString()}

HEALTH SCORE: ${healthScore}/999 (${scoreLabel(healthScore)})
`

    const completion = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 1800,
      messages: [
        { role: 'system', content: 'You are an email deliverability expert writing a monthly health report for Phoenix Home Remodeling (home remodeling company in Phoenix, AZ). Be direct, specific with numbers, business-focused. Return valid JSON only, no markdown.' },
        { role: 'user', content: `Analyse this subscriber health data and return a JSON object with exactly these keys: analyst_notes (2-3 sentences), top_priority (one clear action sentence), actions_urgent (array of exactly 3 action strings), actions_medium (array of exactly 3 action strings), score_explanation (one sentence explaining the score).

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
        total: segments.total,
        new: segments.new,
        active: segments.active,
        warmingUp: segments.warmingUp,
        cold: segments.cold,
        dead: segments.dead,
        neverEngaged: segments.neverEngaged,
        spamRisk: segments.spamRisk,
      },
      stats: {
        campaigns_analyzed: 0,
        note: 'Campaign open/click stats require email campaign API scope. Contact your GHL admin to enable it on your Private Integration.',
        total_sent: 0,
        open_rate: 0,
        click_rate: 0,
        bounce_rate: 0,
        spam_rate: 0,
        unsub_rate: 0,
      },
      analysis,
    })
  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
