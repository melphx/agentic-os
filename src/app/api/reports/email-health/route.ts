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

// ── Server-side HTML builder for email delivery ───────────────────────────
function buildReportHTML(r: any): string {
  const sc = r.strict_score >= 800 ? '#10b981' : r.strict_score >= 650 ? '#06b6d4' : r.strict_score >= 500 ? '#f59e0b' : r.strict_score >= 300 ? '#f43f5e' : '#dc2626'
  const pct = (n: number, d: number) => d > 0 ? (n/d*100).toFixed(1)+'%' : '0%'
  const lst = r.list || {}
  const ex  = r.existing || {}
  const nl  = r.new_leads || {}
  const wf  = Array.isArray(r.workflows) ? [...r.workflows].sort((a:any,b:any)=>b.sent-a.sent) : []
  const awf = Array.isArray(r.workflow_history_campaigns) ? r.workflow_history_campaigns : []

  const workflowTable = (rows: any[], label: string, badge: string) => rows.length === 0 ? '' : `
<div style="background:rgba(15,20,35,.9);border:1px solid rgba(99,102,241,.15);border-radius:14px;padding:20px;margin:14px 0">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <span style="color:#a5b4fc;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${label}</span>
    <span style="font-size:10px;color:#10b981;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.2);padding:2px 8px;border-radius:4px">${badge}</span>
  </div>
  <table style="width:100%;border-collapse:collapse">
    <tr><th style="color:rgba(148,163,184,.4);font-size:10px;font-weight:600;text-transform:uppercase;padding:6px 10px;text-align:left;border-bottom:1px solid rgba(99,102,241,.1)">Workflow</th><th style="color:rgba(148,163,184,.4);font-size:10px;font-weight:600;text-transform:uppercase;padding:6px 10px;text-align:left;border-bottom:1px solid rgba(99,102,241,.1)">Sent</th><th style="color:rgba(148,163,184,.4);font-size:10px;font-weight:600;text-transform:uppercase;padding:6px 10px;text-align:left;border-bottom:1px solid rgba(99,102,241,.1)">Open %</th><th style="color:rgba(148,163,184,.4);font-size:10px;font-weight:600;text-transform:uppercase;padding:6px 10px;text-align:left;border-bottom:1px solid rgba(99,102,241,.1)">Click %</th><th style="color:rgba(148,163,184,.4);font-size:10px;font-weight:600;text-transform:uppercase;padding:6px 10px;text-align:left;border-bottom:1px solid rgba(99,102,241,.1)">Bounce %</th></tr>
    ${rows.map((w:any)=>`<tr><td style="padding:8px 10px;border-bottom:1px solid rgba(99,102,241,.06);font-size:12px;color:rgba(148,163,184,.8);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${w.name}</td><td style="padding:8px 10px;border-bottom:1px solid rgba(99,102,241,.06);font-size:12px;color:white;font-weight:600">${(w.sent||0).toLocaleString()}</td><td style="padding:8px 10px;border-bottom:1px solid rgba(99,102,241,.06);font-size:12px;color:${(w.openRate??0)>=25?'#10b981':'#f59e0b'};font-weight:600">${(w.openRate??0).toFixed(1)}%</td><td style="padding:8px 10px;border-bottom:1px solid rgba(99,102,241,.06);font-size:12px;color:${(w.clickRate??0)>=3?'#10b981':'#f59e0b'};font-weight:600">${(w.clickRate??0).toFixed(1)}%</td><td style="padding:8px 10px;border-bottom:1px solid rgba(99,102,241,.06);font-size:12px;color:${w.sent>0&&(w.bounced/w.sent*100)<2?'#10b981':'#f43f5e'};font-weight:600">${w.sent>0?((w.bounced/w.sent)*100).toFixed(2):'0.00'}%</td></tr>`).join('')}
  </table>
</div>`

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Email Health Report - ${r.month_label}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#080c14;color:#e2e8f0;font-family:Inter,system-ui,sans-serif;padding:32px;max-width:1200px;margin:0 auto}.card{background:rgba(15,20,35,.9);border:1px solid rgba(99,102,241,.15);border-radius:14px;padding:20px;margin:14px 0}.title{color:#a5b4fc;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:12px}p{color:rgba(148,163,184,.7);line-height:1.7;margin-bottom:8px}.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(99,102,241,.06)}</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px">
  <div>
    <div style="font-size:64px;font-weight:900;color:${sc};line-height:1">${r.strict_score}</div>
    <div style="font-size:22px;font-weight:800;color:${sc};margin-top:2px">${r.score_label}</div>
    <div style="color:rgba(148,163,184,.4);font-size:11px;margin-top:6px">Strict Email Health Score · ${r.month_label} · via HighLevel</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:20px;font-weight:700;color:white">Phoenix Home Remodeling</div>
    <div style="color:rgba(148,163,184,.4);font-size:13px;margin-top:4px">${r.domain}</div>
  </div>
</div>
<div class="card"><div class="title">Analyst Notes</div><p>${r.analysis?.analyst_note||''}</p></div>
<div class="card"><div class="title">Executive Summary</div><p>${r.analysis?.executive_summary||''}</p></div>
${Array.isArray(r.analysis?.problems)&&r.analysis.problems.length?`<div class="card" style="border-color:rgba(244,63,94,.2)"><div class="title" style="color:#f43f5e">⚠️ Problems Costing You Revenue</div>${r.analysis.problems.map((p:any)=>`<div style="padding:10px 0;border-bottom:1px solid rgba(244,63,94,.08)"><strong style="color:white">${p.title}</strong><p style="margin-top:4px">${p.description}</p></div>`).join('')}</div>`:''}
${r.stats?.campaigns_analyzed>0?`<div class="card"><div class="title">Email Performance — ${r.stats.campaigns_analyzed} Workflows</div><div style="display:flex;margin-bottom:8px">${[['Open Rate',r.stats.open_rate+'%'],['Click Rate',r.stats.click_rate+'%'],['Bounce Rate',r.stats.bounce_rate+'%'],['Delivered',(r.stats.delivered||0).toLocaleString()],['Unsubs',(r.stats.unsub||0).toLocaleString()]].map(([l,v])=>`<div style="flex:1;text-align:center;padding:8px 4px"><div style="font-size:20px;font-weight:700;color:${sc}">${v}</div><div style="font-size:9px;color:rgba(148,163,184,.4);text-transform:uppercase;margin-top:2px">${l}</div></div>`).join('')}</div></div>`:''}
${lst.total?`<div class="card"><div class="title">List Health</div>${[{label:'Best Assets',count:lst.green,color:'#10b981'},{label:'Liabilities',count:lst.slipping,color:'#f59e0b'},{label:'Never Engaged',count:lst.never_engaged,color:'#f43f5e'},{label:'Never Sent',count:lst.never_sent,color:'rgba(99,102,241,.6)'}].map(s=>`<div class="row"><span style="color:white">${s.label}</span><span style="color:${s.color};font-weight:700">${((s.count||0) as number).toLocaleString()} (${pct((s.count||0) as number,lst.total)})</span></div>`).join('')}</div>`:''}
${workflowTable(wf, 'Workflow Campaign Details', r.workflows_are_monthly ? `📅 ${r.month_label}` : 'All-time')}
${workflowTable(awf, 'Workflow Campaign Details', `📅 ${r.workflow_history_label||'Annual'}`)}
<p style="color:rgba(148,163,184,.2);font-size:11px;text-align:center;padding:24px 0">Generated ${new Date(r.generated_at).toLocaleString()} · ${r.domain} · Phoenix Home Remodeling</p>
</body></html>`
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

  if (action === 'send') {
    const month = req.nextUrl.searchParams.get('month')
    if (!month) return NextResponse.json({ error: 'month required' }, { status: 400 })
    const webhook = process.env.EMAIL_HEALTH_N8N_WEBHOOK
    if (!webhook) return NextResponse.json({ error: 'EMAIL_HEALTH_N8N_WEBHOOK not configured in .env.local' }, { status: 500 })
    const cached = getEmailHealthReport(month)
    if (!cached) return NextResponse.json({ error: 'No report found for this month — generate it first' }, { status: 404 })
    const report = JSON.parse(cached.report_json)
    const subject = `Email Health Report — ${report.month_label || month}`
    const html = buildReportHTML(report)
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:          'mel@phxhomeremodeling.com',
          subject,
          html,
          month,
          month_label: report.month_label || month,
          generated_at: cached.generated_at,
        }),
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) return NextResponse.json({ error: `N8N returned ${res.status}` }, { status: 502 })
      return NextResponse.json({ ok: true, to: 'mel@phxhomeremodeling.com', subject })
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 })
    }
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
    // Build campaign name map from current workflows + all snapshot campaign_name fields
    const nameMap: Record<string, string> = {}
    for (const w of workflows as any[]) nameMap[w.sourceId] = w.name
    for (const s of allSnaps as any[]) {
      if (!nameMap[s.source_id] && s.campaign_name) nameMap[s.source_id] = s.campaign_name
    }
    // All source_ids that have any snapshot data (includes historical campaigns no longer active)
    const allSourceIds = Object.keys(snapsBySource)
    // Helper: find closest END-OF-MONTH snapshot on or before targetDate.
    // End-of-month = snapshot_date is the last calendar day of its month.
    // This excludes live mid-month GHL snapshots (e.g. stored as 2026-07-28)
    // so they never contaminate the history deltas.
    const isEndOfMonth = (date: string) => {
      const [ey, em] = date.slice(0,7).split('-').map(Number)
      return parseInt(date.slice(8)) === new Date(ey, em, 0).getDate()
    }
    const closestEOMInMem = (sid: string, targetDate: string) => {
      const snaps = snapsBySource[sid] || []
      let result: typeof snaps[0] | null = null
      for (const s of snaps) {
        if (s.snapshot_date <= targetDate && isEndOfMonth(s.snapshot_date)) result = s
        else if (s.snapshot_date > targetDate) break
      }
      return result
    }
    // Build 12-month list ending at the REPORT month (fiscal year Jul→Jun aligns naturally)
    const [rYear, rMo] = month.split('-').map(Number)
    const last12Months: string[] = []
    for (let i = 11; i >= 0; i--) {
      const d = new Date(rYear, rMo - 1 - i, 1)
      last12Months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`)
    }
    const workflowHistory = last12Months.map(hm => {
      const label = new Date(hm + '-15').toLocaleString('default', { month:'short', year:'2-digit' })

      // Current report month: use workflowsWithDeltas (already correctly computed above)
      if (hm === month) {
        let sent = 0, opened = 0, clicked = 0
        const monthCampaigns: any[] = []
        for (const w of workflowsWithDeltas as any[]) {
          const wSent    = w.sent    || 0
          const wOpened  = w.opened  || 0
          const wClicked = w.clicked || 0
          const wBounced = w.bounced || 0
          if (wSent > 0) {
            sent += wSent; opened += wOpened; clicked += wClicked
            monthCampaigns.push({
              name: w.name, sent: wSent, opened: wOpened, clicked: wClicked, bounced: wBounced,
              openRate:  parseFloat((wOpened  / wSent * 100).toFixed(1)),
              clickRate: parseFloat((wClicked / wSent * 100).toFixed(1)),
            })
          }
        }
        monthCampaigns.sort((a: any, b: any) => b.sent - a.sent)
        return {
          month: hm, label, sent, opened, clicked, has_data: sent > 0,
          openRate:  sent > 0 ? parseFloat((opened  / sent * 100).toFixed(1)) : 0,
          clickRate: sent > 0 ? parseFloat((clicked / sent * 100).toFixed(1)) : 0,
          campaigns: monthCampaigns,
        }
      }

      // Historical months: use YYYY-MM-01 direct snapshots (from WorkflowHistoryPanel),
      // with EOM delta fallback (for live GHL cumulative snapshots)
      const [hy, hmo] = hm.split('-').map(Number)
      const hEnd       = `${hm}-${String(new Date(hy, hmo, 0).getDate()).padStart(2,'0')}`
      const hPrevM     = new Date(hy, hmo - 2, 1)
      const hPrevEnd   = `${hPrevM.getFullYear()}-${String(hPrevM.getMonth()+1).padStart(2,'0')}-${String(new Date(hPrevM.getFullYear(), hPrevM.getMonth()+1, 0).getDate()).padStart(2,'0')}`
      const firstOfMonth = `${hm}-01`
      let sent = 0, opened = 0, clicked = 0, hasData = false
      const monthCampaigns: any[] = []

      for (const sid of allSourceIds) {
        // Primary: direct monthly snapshot saved as YYYY-MM-01 by WorkflowHistoryPanel
        const directSnap = (snapsBySource[sid] || []).find(s => s.snapshot_date === firstOfMonth)
        let wSent = 0, wOpened = 0, wClicked = 0, wBounced = 0

        if (directSnap) {
          wSent    = directSnap.sent    || 0
          wOpened  = directSnap.opened  || 0
          wClicked = directSnap.clicked || 0
          wBounced = directSnap.bounced || 0
        } else {
          // Fallback: EOM delta (live GHL cumulative snapshots)
          const se = closestEOMInMem(sid, hEnd)
          const ss = closestEOMInMem(sid, hPrevEnd)
          if (se) {
            wSent    = Math.max(0, se.sent    - (ss ? ss.sent    : 0))
            wOpened  = Math.max(0, se.opened  - (ss ? ss.opened  : 0))
            wClicked = Math.max(0, se.clicked - (ss ? ss.clicked : 0))
            wBounced = Math.max(0, se.bounced - (ss ? ss.bounced : 0))
          }
        }

        if (wSent > 0) {
          sent += wSent; opened += wOpened; clicked += wClicked
          hasData = true
          monthCampaigns.push({
            name:      nameMap[sid] || sid,
            sent:      wSent,
            opened:    wOpened,
            clicked:   wClicked,
            bounced:   wBounced,
            openRate:  parseFloat((wOpened  / wSent * 100).toFixed(1)),
            clickRate: parseFloat((wClicked / wSent * 100).toFixed(1)),
          })
        }
      }

      monthCampaigns.sort((a: any, b: any) => b.sent - a.sent)
      return {
        month: hm, label, sent, opened, clicked, has_data: hasData,
        openRate:  sent > 0 ? parseFloat((opened  / sent * 100).toFixed(1)) : 0,
        clickRate: sent > 0 ? parseFloat((clicked / sent * 100).toFixed(1)) : 0,
        campaigns: monthCampaigns,
      }
    })

    // ── Flat annual campaign totals (sum across all 12 months per campaign) ──
    const annualMap: Record<string, any> = {}
    for (const hEntry of workflowHistory) {
      for (const c of hEntry.campaigns as any[]) {
        if (!annualMap[c.name]) annualMap[c.name] = { name: c.name, sent:0, opened:0, clicked:0, bounced:0 }
        annualMap[c.name].sent    += c.sent
        annualMap[c.name].opened  += c.opened
        annualMap[c.name].clicked += c.clicked
        annualMap[c.name].bounced += c.bounced
      }
    }
    const workflowHistoryCampaigns = (Object.values(annualMap) as any[])
      .map((c: any) => ({
        ...c,
        openRate:  c.sent > 0 ? parseFloat((c.opened  / c.sent * 100).toFixed(1)) : 0,
        clickRate: c.sent > 0 ? parseFloat((c.clicked / c.sent * 100).toFixed(1)) : 0,
      }))
      .sort((a: any, b: any) => b.sent - a.sent)
    const historyLabel = last12Months.length === 12
      ? `${new Date(last12Months[0]+'-15').toLocaleString('default',{month:'short',year:'numeric'})} – ${new Date(last12Months[11]+'-15').toLocaleString('default',{month:'short',year:'numeric'})}`
      : ''

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
      workflow_history_campaigns: workflowHistoryCampaigns,
      workflow_history_label: historyLabel,

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
