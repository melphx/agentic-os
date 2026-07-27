import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import {
  getEmailHealthBaseline, getAllEmailHealthBaselines, saveEmailHealthBaseline,
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
    // ── Fetch live list data from GHL ───────────────────────────────────────
    const [
      total,
      green, red, catchall, suspicious, freeEmail, notFound, bouncedTag, spamTag,
      neverEngaged, slipping, neverSent,
      google, microsoft, yahoo, otherProvider,
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
    ])

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
    // Liabilities = slipping tag (from live list — approximation)
    // Worst liabilities = neverEngaged tag
    const liabilities        = Math.min(slipping,     existingMailed)
    const worstLiabilities   = Math.min(neverEngaged, existingMailed)

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
Not engaged in 90+ days: ${notEngaged90d.toLocaleString()}
Liabilities (slipping 90-365d): ${liabilities.toLocaleString()}
Worst Liabilities (never/1yr+): ${worstLiabilities.toLocaleString()}

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
      max_completion_tokens: 3000,
      messages: [
        {
          role: 'system',
          content: `You are writing a monthly email health report for Phoenix Home Remodeling (home remodeling, Phoenix AZ). Match the exact tone and format of HitTheInbox reports — direct, business-focused, specific numbers, revenue-impact language. Return valid JSON only.`,
        },
        {
          role: 'user',
          content: `Generate the email health analysis. Return JSON with exactly these keys:
- executive_summary: 3-4 sentence paragraph matching HTI style. Start with "Your Email Health Score is X/999...". Mention the relaxed score, score change vs prior month, and one key positive and one key concern.
- good_news: array of 3-5 strings — positive findings (like domain not on blocklists, DMARC compliance, high relaxed score, etc.)
- problems: array of objects {title, count, description} — specific issues with exact subscriber counts and business impact
- actions_new_contacts: array of 3-4 specific action strings for new contacts who didn't engage
- actions_existing_contacts: array of 4-5 specific action strings for existing contact segments (drive the click, re-engagement, opt-out)
- actions_maintenance: array of 2-3 strings — ongoing best practices
- analyst_note: 1-2 sentences of the single most important insight from this month's data

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

    return NextResponse.json({
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
        engaged_90d,
        not_engaged_90d: notEngaged90d,
        liabilities,
        worst_liabilities: worstLiabilities,
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

      // List health (live snapshot)
      list: {
        total, marketable,
        green, red,
        slipping, never_engaged: neverEngaged, never_sent: neverSent,
        catchall, suspicious, free_email: freeEmail, not_found: notFound,
        bounced_tag: bouncedTag, spam_tag: spamTag,
      },

      // Providers (live snapshot)
      providers: { google, microsoft, yahoo, other: otherProvider, scanned },

      analysis,
    })

  } catch (err: any) {
    console.error('[email-health]', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
