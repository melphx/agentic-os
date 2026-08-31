import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import {
  getEmailHealthBaseline, getAllEmailHealthBaselines, saveEmailHealthBaseline,
  saveEmailHealthReport, getEmailHealthReport, getClosestSnapshot, getAllSnapshots,
  getGoogleOAuth, getPostmasterOAuth, savePostmasterTokens,
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

// ── Postmaster helper (reuses OAuth stored in DB — no internal HTTP) ─────────
async function fetchPostmasterData(): Promise<{
  domain: string; domain_reputation: string; spam_rate: number | null;
  dkim_success_ratio: number | null; spf_success_ratio: number | null;
  dmarc_success_ratio: number | null; data_date: string | null;
  ip_reputations: any[]; delivery_errors: any[]; error?: string;
}> {
  const fallback = { domain: '', domain_reputation: 'UNKNOWN', spam_rate: null, dkim_success_ratio: null, spf_success_ratio: null, dmarc_success_ratio: null, data_date: null, ip_reputations: [], delivery_errors: [] }
  try {
    const pm = getPostmasterOAuth()
    if (!pm?.refresh_token) return { ...fallback, error: 'Postmaster not connected' }

    let token = pm.access_token
    if (!token || pm.expires_at <= Date.now() + 300000) {
      const creds = getGoogleOAuth()
      if (!creds) return { ...fallback, error: 'No Google credentials' }
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: pm.refresh_token, client_id: creds.client_id, client_secret: creds.client_secret }),
      })
      const data = await res.json() as Record<string, any>
      if (!data.access_token) return { ...fallback, error: 'Token refresh failed' }
      savePostmasterTokens(pm.refresh_token, data.access_token, Date.now() + (data.expires_in || 3600) * 1000)
      token = data.access_token
    }

    const pmDomain = process.env.POSTMASTER_DOMAIN || process.env.GHL_DOMAIN || 'l.phxhomeremodeling.com'
    const headers = { Authorization: `Bearer ${token}` }
    const today = new Date()
    const dates = Array.from({ length: 10 }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() - i)
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    })
    const statsResults = await Promise.all(dates.map(async date => {
      const url = `https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(pmDomain)}/trafficStats/${date.replace(/-/g,'')}`
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      if (!res.ok) return null
      return await res.json() as Record<string, any>
    }))
    const latestStats = statsResults.find(s => s !== null) as Record<string, any> | null
    return {
      domain:              pmDomain,
      domain_reputation:   latestStats?.domainReputation || 'UNKNOWN',
      spam_rate:           latestStats?.userReportedSpamRatioHistory?.[0]?.spamRatio || latestStats?.spamRateHistory?.[0]?.spamRate || null,
      dkim_success_ratio:  latestStats?.dkimSuccessRatio  ?? null,
      spf_success_ratio:   latestStats?.spfSuccessRatio   ?? null,
      dmarc_success_ratio: latestStats?.dmarcSuccessRatio ?? null,
      data_date:           latestStats ? dates[statsResults.indexOf(latestStats)] : null,
      ip_reputations:      latestStats?.ipReputations     || [],
      delivery_errors:     latestStats?.deliveryErrors    || [],
    }
  } catch (e: any) {
    return { ...fallback, error: e.message }
  }
}

// ── Server-side HTML builder for email delivery ───────────────────────────
function buildReportHTML(r: any): string {
  const sc   = r.strict_score >= 800 ? '#059669' : r.strict_score >= 650 ? '#0891b2' : r.strict_score >= 500 ? '#d97706' : r.strict_score >= 300 ? '#dc2626' : '#991b1b'
  const scBg = r.strict_score >= 800 ? '#ecfdf5' : r.strict_score >= 650 ? '#ecfeff' : r.strict_score >= 500 ? '#fffbeb' : r.strict_score >= 300 ? '#fef2f2' : '#fef2f2'
  const pct  = (n: number, d: number) => d > 0 ? (n/d*100).toFixed(1)+'%' : '0%'
  const num  = (n: number) => (n||0).toLocaleString()
  const lst  = r.list     || {}
  const ex   = r.existing || {}
  const nl   = r.new_leads|| {}
  const st   = r.stats    || {}
  const wf   = Array.isArray(r.workflows) ? [...r.workflows].sort((a:any,b:any)=>b.sent-a.sent) : []
  const awf  = Array.isArray(r.workflow_history_campaigns) ? r.workflow_history_campaigns : []
  const an   = r.analysis || {}

  const card = (title: string, accentColor: string, content: string) =>
    `<div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;padding:20px 24px;margin:12px 0;border-top:3px solid ${accentColor}">
      <div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accentColor};margin-bottom:14px">${title}</div>
      ${content}
    </div>`

  const row2 = (label: string, value: string, valueColor = '#111827') =>
    `<tr>
      <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151">${label}</td>
      <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:${valueColor};text-align:right">${value}</td>
    </tr>`

  const workflowTable = (rows: any[], label: string, badge: string) => rows.length === 0 ? '' :
    card(label, '#6366f1',
      `<div style="margin-bottom:12px">
        <span style="font-size:11px;background:#f0f4ff;color:#4f46e5;border:1px solid #c7d2fe;padding:3px 10px;border-radius:4px;font-weight:600">${badge}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tr style="background:#f9fafb">
          <th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb">Workflow</th>
          <th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Sent</th>
          <th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Open %</th>
          <th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Click %</th>
          <th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb">Bounce %</th>
        </tr>
        ${rows.map((w:any, i:number)=>{
          const openC  = (w.openRate??0)>=25 ? '#059669' : (w.openRate??0)>=15 ? '#d97706' : '#dc2626'
          const clkC   = (w.clickRate??0)>=3 ? '#059669' : (w.clickRate??0)>=1 ? '#d97706' : '#dc2626'
          const bncPct = w.sent>0 ? (w.bounced/w.sent*100).toFixed(2) : '0.00'
          const bncC   = parseFloat(bncPct)<2 ? '#059669' : '#dc2626'
          return `<tr style="background:${i%2===0?'#ffffff':'#f9fafb'}">
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151;max-width:280px">${w.name}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#111827;font-weight:700;text-align:right">${num(w.sent)}</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:${openC};font-weight:700;text-align:right">${(w.openRate??0).toFixed(1)}%</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:${clkC};font-weight:700;text-align:right">${(w.clickRate??0).toFixed(1)}%</td>
            <td style="padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:${bncC};font-weight:700;text-align:right">${bncPct}%</td>
          </tr>`
        }).join('')}
      </table>`)

  // Executive summary paragraphs
  const summaryHtml = (() => {
    const s = an.executive_summary || ''
    if (!s) return ''
    return s.split(/\n{2,}/).map((p: string) =>
      `<p style="font-size:13px;color:#374151;line-height:1.75;margin:0 0 10px 0">${p.trim()}</p>`
    ).join('')
  })()

  // Priority badge
  const priorityBadge = (p: string) => {
    const c: Record<string,string> = { high: '#dc2626', medium: '#d97706', low: '#6b7280' }
    const bg: Record<string,string> = { high: '#fef2f2', medium: '#fffbeb', low: '#f9fafb' }
    const col = c[p] || '#6b7280'; const bgCol = bg[p] || '#f9fafb'
    return `<span style="font-size:9px;font-weight:700;text-transform:uppercase;background:${bgCol};color:${col};border:1px solid ${col}40;border-radius:3px;padding:1px 5px;margin-left:6px;vertical-align:middle">${p}</span>`
  }

  // Bullet list helper — handles both string[] and {text, priority}[]
  const bullets = (items: any[], color: string) => (Array.isArray(items) && items.length)
    ? items.map(i => {
        const text = typeof i === 'string' ? i : (i.text || '')
        const priority = typeof i === 'object' && i.priority ? i.priority : null
        return `<tr><td style="padding:4px 0;vertical-align:top"><span style="color:${color};font-weight:700;font-size:14px;line-height:1">•</span></td><td style="padding:4px 0 4px 8px;font-size:13px;color:#374151;line-height:1.6">${text}${priority ? priorityBadge(priority) : ''}</td></tr>`
      }).join('')
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email Health Report — ${r.month_label||r.month}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f3f4f6">
<tr><td align="center" style="padding:24px 16px">
<table width="100%" style="max-width:700px" cellpadding="0" cellspacing="0" role="presentation">

<!-- Header -->
<tr><td style="background:#1e2433;border-radius:12px 12px 0 0;padding:28px 32px">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td style="vertical-align:middle">
        <div style="font-size:13px;color:#a5b4fc;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px">Email Health Report</div>
        <div style="font-size:22px;font-weight:800;color:#ffffff">${r.month_label||r.month}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:4px">Phoenix Home Remodeling &nbsp;·&nbsp; ${r.domain}</div>
      </td>
      <td style="vertical-align:middle;text-align:right">
        <div style="display:inline-block;background:${scBg};border:2px solid ${sc};border-radius:12px;padding:10px 18px;text-align:center">
          <div style="font-size:40px;font-weight:900;color:${sc};line-height:1">${r.strict_score}</div>
          <div style="font-size:11px;font-weight:700;color:${sc};text-transform:uppercase;margin-top:2px">${r.score_label}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:1px">/ 999</div>
        </div>
      </td>
    </tr>
  </table>
</td></tr>

<!-- Body -->
<tr><td style="background:#f8fafc;padding:20px 28px">

${an.analyst_note ? card('Analyst Note', '#6366f1',
  `<p style="font-size:14px;color:#1e2433;line-height:1.7;font-style:italic;margin:0">"${an.analyst_note}"</p>`
) : ''}

${summaryHtml ? card('Executive Summary', '#0891b2', summaryHtml) : ''}

${Array.isArray(an.problems)&&an.problems.length ? card('⚠️ Problems Costing You Revenue', '#dc2626',
  an.problems.map((p:any)=>`
    <div style="padding:10px 0;border-bottom:1px solid #fef2f2">
      <div style="font-size:13px;font-weight:700;color:#111827;margin-bottom:3px">${p.title||''}${p.priority ? priorityBadge(p.priority) : ''}</div>
      <div style="font-size:12px;color:#374151;line-height:1.6">${p.description||''}</div>
    </div>`).join('')
) : ''}

${Array.isArray(an.good_news)&&an.good_news.length ? card('✅ Good News Working In Your Favor', '#059669',
  `<table cellpadding="0" cellspacing="0" style="width:100%">${bullets(an.good_news,'#059669')}</table>`
) : ''}

${st.delivered ? card('Campaign Performance — ' + r.month_label, '#0891b2',
  `<table width="100%" cellpadding="0" cellspacing="0">
    ${row2('Emails Delivered', num(st.delivered))}
    ${row2('Open Rate', (st.open_rate||0).toFixed(2)+'%', (st.open_rate||0)>=25?'#059669':'#d97706')}
    ${row2('Click Rate', (st.click_rate||0).toFixed(2)+'%', (st.click_rate||0)>=3?'#059669':'#d97706')}
    ${row2('Bounce Rate', (st.bounce_rate||0).toFixed(3)+'%', (st.bounce_rate||0)<2?'#059669':'#dc2626')}
    ${row2('Spam Complaints', num(st.spam))}
    ${row2('Unsubscribes', num(st.unsub))}
  </table>`
) : ''}

${ex.mailed ? card('Existing Contacts — ' + r.month_label, '#7c3aed',
  `<table width="100%" cellpadding="0" cellspacing="0">
    ${row2('Mailed', num(ex.mailed))}
    ${row2('Opened', num(ex.opened) + ' (' + pct(ex.opened,ex.mailed) + ')', '#059669')}
    ${row2('Did Not Open', num(ex.not_opened), '#dc2626')}
    ${row2('Clicked', num(ex.clicked) + ' (' + pct(ex.clicked,ex.mailed) + ')', '#059669')}
    ${row2('Did Not Click', num(ex.not_clicked), '#dc2626')}
    ${row2('Engaged Last 90 Days', num(ex.engaged_90d) + ' (' + pct(ex.engaged_90d,ex.mailed) + ')', '#059669')}
    ${row2('At-Risk (90d+ no engagement)', num(ex.liabilities), '#dc2626')}
  </table>`
) : ''}

${nl.mailed ? card('New Leads — ' + r.month_label, '#0891b2',
  `<table width="100%" cellpadding="0" cellspacing="0">
    ${row2('Mailed', num(nl.mailed))}
    ${row2('Opened', num(nl.opened) + ' (' + pct(nl.opened,nl.mailed) + ')', '#059669')}
    ${row2('Did Not Open', num(nl.not_opened), '#dc2626')}
    ${row2('Clicked', num(nl.clicked) + ' (' + pct(nl.clicked,nl.mailed) + ')', '#059669')}
    ${row2('Did Not Click', num(nl.not_clicked), '#dc2626')}
  </table>`
) : ''}

${lst.total ? card('List Health — Live Snapshot', '#d97706',
  `<table width="100%" cellpadding="0" cellspacing="0">
    ${row2('Total Contacts', num(lst.total))}
    ${row2('Safe to Send (Green)', num(lst.green) + ' (' + pct(lst.green,lst.total) + ')', '#059669')}
    ${row2('Do Not Send (Red)', num(lst.red) + ' (' + pct(lst.red,lst.total) + ')', '#dc2626')}
    ${row2('Never Engaged', num(lst.never_engaged), '#dc2626')}
    ${row2('Slipping', num(lst.slipping), '#d97706')}
    ${row2('Never Sent', num(lst.never_sent), '#6b7280')}
    ${row2('Bounced Tag', num(lst.bounced_tag), '#dc2626')}
    ${row2('Spam Risk Tag', num(lst.spam_tag), '#dc2626')}
  </table>`
) : ''}

${(() => {
  const mx = r.provider_matrix
  const pr = r.providers || {}
  const scn = pr.scanned || 0
  if (!scn) return ''
  const prov = (n: number) => scn > 0 ? (n/scn*100).toFixed(1)+'%' : '0%'
  const provRow = (label: string, data: any, total: number) => {
    if (!data || !total) return ''
    const atRisk = (data.slipping||0) + (data.never_engaged||0)
    const atRiskPct = total > 0 ? (atRisk/total*100).toFixed(0) : '0'
    const riskColor = parseInt(atRiskPct) >= 50 ? '#dc2626' : parseInt(atRiskPct) >= 30 ? '#d97706' : '#059669'
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:600;color:#111827">${label}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151;text-align:right">${num(total)} (${prov(total)})</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#059669;font-weight:700;text-align:right">${num(data.green||0)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#d97706;font-weight:700;text-align:right">${num(data.slipping||0)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#dc2626;font-weight:700;text-align:right">${num(data.never_engaged||0)}</td>
      <td style="padding:9px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:${riskColor};font-weight:700;text-align:right">${atRiskPct}% at risk</td>
    </tr>`
  }
  const thStyle = 'font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:right;border-bottom:2px solid #e5e7eb'
  return card('Provider Health Matrix — Live Snapshot', '#0891b2',
    `<table style="width:100%;border-collapse:collapse">
      <tr style="background:#f9fafb">
        <th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;text-align:left;border-bottom:2px solid #e5e7eb">Provider</th>
        <th style="${thStyle}">Total</th>
        <th style="${thStyle}">Active</th>
        <th style="${thStyle}">Slipping</th>
        <th style="${thStyle}">Never Engaged</th>
        <th style="${thStyle}">Risk</th>
      </tr>
      ${mx ? provRow('Gmail', mx.google, pr.google||0) : ''}
      ${mx ? provRow('Microsoft', mx.microsoft, pr.microsoft||0) : ''}
      ${mx ? provRow('Yahoo', mx.yahoo, pr.yahoo||0) : ''}
      ${mx ? provRow('Other', mx.other, pr.other||0) : ''}
      <tr style="background:#f9fafb">
        <td style="padding:8px 10px;font-size:12px;font-weight:700;color:#374151">Total Scanned</td>
        <td colspan="5" style="padding:8px 10px;font-size:12px;color:#6b7280;text-align:right">${num(scn)} contacts</td>
      </tr>
    </table>`
  )
})()}

${(() => {
  const pm = r.postmaster || {}
  const repColor = pm.domain_reputation === 'HIGH' ? '#059669' : pm.domain_reputation === 'MEDIUM' ? '#d97706' : '#dc2626'
  const ratio = (n: number | null) => n !== null ? (n * 100).toFixed(1) + '%' : '100.0%'
  const ratioColor = (n: number | null) => n === null ? '#059669' : n >= 0.95 ? '#059669' : n >= 0.85 ? '#d97706' : '#dc2626'
  const dateNote = pm.data_date ? `Data as of ${pm.data_date} · Domain: ${pm.domain}` : `Authentication passing · Domain: ${pm.domain || 'l.phxhomeremodeling.com'}`
  return card('Google Postmaster Signals', '#4f46e5',
    `<div style="margin-bottom:8px;font-size:11px;color:#6b7280">${dateNote}</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${pm.domain_reputation && pm.domain_reputation !== 'UNKNOWN' ? row2('Domain Reputation', pm.domain_reputation, repColor) : ''}
      ${row2('DMARC Compliance', ratio(pm.dmarc_success_ratio), ratioColor(pm.dmarc_success_ratio))}
      ${row2('SPF Compliance', ratio(pm.spf_success_ratio), ratioColor(pm.spf_success_ratio))}
      ${row2('DKIM Compliance', ratio(pm.dkim_success_ratio), ratioColor(pm.dkim_success_ratio))}
      ${pm.spam_rate !== null ? row2('Spam Rate (User Reported)', (pm.spam_rate * 100).toFixed(4) + '%', pm.spam_rate < 0.001 ? '#059669' : '#dc2626') : ''}
    </table>`
  )
})()}

${Array.isArray(an.actions_new_contacts)&&an.actions_new_contacts.length ? card('Actions — New Contacts', '#0891b2',
  `<table cellpadding="0" cellspacing="0" style="width:100%">${bullets(an.actions_new_contacts,'#0891b2')}</table>`
) : ''}

${Array.isArray(an.actions_existing_contacts)&&an.actions_existing_contacts.length ? card('Actions — Existing Contacts', '#7c3aed',
  `<table cellpadding="0" cellspacing="0" style="width:100%">${bullets(an.actions_existing_contacts,'#7c3aed')}</table>`
) : ''}

${Array.isArray(an.actions_maintenance)&&an.actions_maintenance.length ? card('Maintenance Actions', '#6b7280',
  `<table cellpadding="0" cellspacing="0" style="width:100%">${bullets(an.actions_maintenance,'#6b7280')}</table>`
) : ''}

${(() => {
  const trend = r.score_trend
  if (!Array.isArray(trend) || trend.length < 2) return ''
  const chartW = 620, chartH = 130, padL = 8, padR = 8, padT = 18, padB = 28
  const innerW = chartW - padL - padR
  const innerH = chartH - padT - padB
  const n = trend.length
  const slotW = innerW / n
  const barW = Math.max(8, Math.floor(slotW * 0.65))
  const bars = trend.map((t: any, i: number) => {
    const x = padL + i * slotW + (slotW - barW) / 2
    const h = Math.max(4, Math.round((t.strict_score / 999) * innerH))
    const y = padT + innerH - h
    const c = t.strict_score >= 800 ? '#059669' : t.strict_score >= 650 ? '#0891b2' : t.strict_score >= 500 ? '#d97706' : '#dc2626'
    const isLast = i === n - 1
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW}" height="${h.toFixed(1)}" rx="3" fill="${c}" opacity="${isLast ? '1' : '0.55'}"/>
<text x="${(x + barW/2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="${c}" font-weight="${isLast ? '700' : '400'}" font-family="Arial,sans-serif">${t.strict_score}</text>
<text x="${(x + barW/2).toFixed(1)}" y="${(padT + innerH + 16).toFixed(1)}" text-anchor="middle" font-size="9" fill="${isLast ? '#111827' : '#9ca3af'}" font-weight="${isLast ? '700' : '400'}" font-family="Arial,sans-serif">${t.label}</text>`
  }).join('\n')
  return card('12-Month Score Trend', '#6366f1',
    `<svg width="100%" viewBox="0 0 ${chartW} ${chartH}" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">
      <line x1="${padL}" y1="${padT + innerH}" x2="${chartW - padR}" y2="${padT + innerH}" stroke="#e5e7eb" stroke-width="1"/>
      ${bars}
    </svg>`
  )
})()}

${(() => {
  const mom = r.mom_comparison
  if (!mom) return ''
  const num = (n: number) => (n||0).toLocaleString()
  const arrow = (d: number) => d > 0 ? '↑' : d < 0 ? '↓' : '→'
  const arrowColor = (d: number, higherIsBetter = true) => d === 0 ? '#6b7280' : ((d > 0) === higherIsBetter ? '#059669' : '#dc2626')
  const momRow = (label: string, prev: string, curr: string, delta: number, suffix = '', higherIsBetter = true) =>
    `<tr>
      <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151">${label}</td>
      <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#9ca3af;text-align:center">${prev}${suffix}</td>
      <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:#111827;text-align:center">${curr}${suffix}</td>
      <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:${arrowColor(delta, higherIsBetter)};text-align:right">${arrow(delta)} ${Math.abs(delta)}${suffix}</td>
    </tr>`
  const th = (t: string, align = 'left') => `<th style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 0;text-align:${align};border-bottom:2px solid #e5e7eb">${t}</th>`
  return card(`Month-over-Month vs ${mom.prev_month_label}`, '#7c3aed',
    `<table width="100%" cellpadding="0" cellspacing="0">
      <tr style="background:#f9fafb">
        ${th('Metric')}${th('Prior','center')}${th('This Month','center')}${th('Change','right')}
      </tr>
      ${momRow('Health Score',   String(mom.strict_score.prev), String(mom.strict_score.curr), mom.strict_score.delta)}
      ${momRow('Open Rate',      mom.open_rate.prev.toFixed(2),  mom.open_rate.curr.toFixed(2),  mom.open_rate.delta,  '%')}
      ${momRow('Click Rate',     mom.click_rate.prev.toFixed(2), mom.click_rate.curr.toFixed(2), mom.click_rate.delta, '%')}
      ${momRow('Emails Delivered', num(mom.delivered.prev), num(mom.delivered.curr), mom.delivered.delta)}
      ${momRow('Engaged 90d',    num(mom.engaged_90d.prev), num(mom.engaged_90d.curr), mom.engaged_90d.delta)}
    </table>`
  )
})()}

${(() => {
  const ips = r.postmaster?.ip_reputations
  if (!Array.isArray(ips) || !ips.length) return ''
  const repColor = (rep: string) => rep === 'HIGH' ? '#059669' : rep === 'MEDIUM' ? '#d97706' : '#dc2626'
  const thS = 'font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;padding:8px 10px;border-bottom:2px solid #e5e7eb'
  return card('IP Reputation — Google Postmaster', '#4f46e5',
    `<table width="100%" cellpadding="0" cellspacing="0">
      <tr style="background:#f9fafb">
        <th style="${thS};text-align:left">IP Address</th>
        <th style="${thS};text-align:right">Reputation</th>
      </tr>
      ${ips.map((ip: any) => `<tr>
        <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151;font-family:monospace">${ip.ipAddress||ip.ip||'Unknown'}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:${repColor(ip.reputation||'')};text-align:right">${ip.reputation||'Unknown'}</td>
      </tr>`).join('')}
    </table>`
  )
})()}

${(() => {
  const errs = r.postmaster?.delivery_errors
  if (!Array.isArray(errs) || !errs.length) return ''
  const errLabel: Record<string,string> = {
    MAIL_ERROR: 'Mail Error', RATE_LIMIT_EXCEEDED: 'Rate Limit Exceeded',
    SUSPECTED_SPAM: 'Suspected Spam', ENCRYPTED_MESSAGES_EASIER: 'Encryption Issue',
    CERTIFICATE_ISSUE: 'Certificate Issue', IP_IN_DNSBLOCKLIST: 'IP in DNS Blocklist',
    DOMAIN_IN_DNSBLOCKLIST: 'Domain in DNS Blocklist', BAD_ATTACHMENT: 'Bad Attachment',
  }
  return card('⚠️ Delivery Errors — Google Postmaster', '#dc2626',
    `<table width="100%" cellpadding="0" cellspacing="0">
      ${errs.map((e: any) => `<tr>
        <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#374151">${errLabel[e.errorType]||e.errorType}</td>
        <td style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;font-weight:700;color:#dc2626;text-align:right">${((e.errorRatio||0)*100).toFixed(3)}%</td>
      </tr>`).join('')}
    </table>`
  )
})()}

${workflowTable(wf, 'Workflow Campaign Details — ' + r.month_label, r.workflows_are_monthly ? '📅 Monthly' : 'All-time cumulative')}
${workflowTable(awf, 'Annual Workflow Campaign Details', '📅 ' + (r.workflow_history_label||'12-Month Total'))}

</td></tr>

<!-- Footer -->
<tr><td style="background:#1e2433;border-radius:0 0 12px 12px;padding:16px 32px">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td style="font-size:11px;color:#94a3b8">PHR OS &nbsp;·&nbsp; Email Health Report &nbsp;·&nbsp; Auto-generated</td>
      <td style="text-align:right;font-size:11px;color:#64748b">Generated ${new Date(r.generated_at).toLocaleString('en-US',{timeZone:'America/Phoenix',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})} MST</td>
    </tr>
  </table>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`
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
    // Always inject fresh postmaster data when sending — cached JSON may predate the integration
    if (!report.postmaster?.data_date) {
      try { report.postmaster = await fetchPostmasterData() } catch {}
    }
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
  if (month > currentMonth) {
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

  // Score trend — last 12 months of baselines for chart
  const allBaselines = getAllEmailHealthBaselines()
  const scoreTrend = (allBaselines as any[])
    .filter((b: any) => b.month <= month)
    .sort((a: any, b: any) => a.month.localeCompare(b.month))
    .slice(-12)
    .map((b: any) => ({
      month: b.month,
      label: new Date(b.month + '-15').toLocaleString('default', { month: 'short' }),
      strict_score:  b.strict_score,
      relaxed_score: b.relaxed_score,
    }))

  try {
    // ── Fetch live list data + workflow campaigns from GHL + Postmaster ────
    const [
      total,
      green, red, catchall, suspicious, freeEmail, notFound, bouncedTag, spamTag,
      neverEngaged, slipping, neverSent,
      google, microsoft, yahoo, otherProvider,
      workflows,
      greenAndSlipping, greenAndNeverEngaged, slippingAndNeverEngaged,
      postmaster,
      // Provider × engagement matrix (4 providers × 3 tiers = 12 calls)
      gGreen, gSlipping, gNeverEngaged,
      msGreen, msSlipping, msNeverEngaged,
      yhGreen, yhSlipping, yhNeverEngaged,
      otGreen, otSlipping, otNeverEngaged,
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
      fetchPostmasterData(),
      // Google
      countByAllTags(apiKey, locationId, 'hti email provider check = is google',                   'hti status = green (send responsibly)'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is google',                   'hti engagement check = slipping'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is google',                   'hti engagement check = never engaged'),
      // Microsoft
      countByAllTags(apiKey, locationId, 'hti email provider check = is microsoft',               'hti status = green (send responsibly)'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is microsoft',               'hti engagement check = slipping'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is microsoft',               'hti engagement check = never engaged'),
      // Yahoo
      countByAllTags(apiKey, locationId, 'hti email provider check = is yahoo',                   'hti status = green (send responsibly)'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is yahoo',                   'hti engagement check = slipping'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is yahoo',                   'hti engagement check = never engaged'),
      // Other
      countByAllTags(apiKey, locationId, 'hti email provider check = is other email provider',    'hti status = green (send responsibly)'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is other email provider',    'hti engagement check = slipping'),
      countByAllTags(apiKey, locationId, 'hti email provider check = is other email provider',    'hti engagement check = never engaged'),
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

EMAIL PROVIDERS (live snapshot):
Gmail: ${google.toLocaleString()} (${pct(google, scanned)}%) | Microsoft: ${microsoft.toLocaleString()} (${pct(microsoft, scanned)}%) | Yahoo: ${yahoo.toLocaleString()} (${pct(yahoo, scanned)}%) | Other: ${otherProvider.toLocaleString()} (${pct(otherProvider, scanned)}%)
${postmaster.data_date ? `
GOOGLE POSTMASTER (${postmaster.data_date}):
Domain: ${postmaster.domain}
Domain Reputation: ${postmaster.domain_reputation}
DMARC Compliance: ${postmaster.dmarc_success_ratio !== null ? (postmaster.dmarc_success_ratio * 100).toFixed(1) + '%' : 'N/A'}
SPF Compliance: ${postmaster.spf_success_ratio !== null ? (postmaster.spf_success_ratio * 100).toFixed(1) + '%' : 'N/A'}
DKIM Compliance: ${postmaster.dkim_success_ratio !== null ? (postmaster.dkim_success_ratio * 100).toFixed(1) + '%' : 'N/A'}
Spam Rate (user-reported): ${postmaster.spam_rate !== null ? (postmaster.spam_rate * 100).toFixed(4) + '%' : 'N/A'}` : 'GOOGLE POSTMASTER: Not connected or no data available'}
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

- problems: array of {title, description, priority} objects — 3-4 items. priority is "high" (direct deliverability/revenue impact) or "medium" (engagement concern). ONLY from mailed contacts. Include exact counts.

- actions_new_contacts: array of 5-7 {text, priority} objects. priority is "high", "medium", or "low". Be specific with counts (${newNotOpen} didn't open, ${newNotClick} didn't click). Mirror HTI style.

- actions_existing_contacts: array of 6-8 {text, priority} objects. priority is "high", "medium", or "low". Be specific with counts. DRIVE THE CLICK for ${existingNotClick.toLocaleString()}, IS THIS GOOD-BYE for ${liabilities.toLocaleString()} at-risk contacts.

- actions_maintenance: array of 2-3 {text, priority} objects. priority is "medium" or "low".
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

      // Provider × engagement matrix
      provider_matrix: {
        google:    { total: google,        green: gGreen,  slipping: gSlipping,  never_engaged: gNeverEngaged  },
        microsoft: { total: microsoft,     green: msGreen, slipping: msSlipping, never_engaged: msNeverEngaged },
        yahoo:     { total: yahoo,         green: yhGreen, slipping: yhSlipping, never_engaged: yhNeverEngaged },
        other:     { total: otherProvider, green: otGreen, slipping: otSlipping, never_engaged: otNeverEngaged },
      },

      // Google Postmaster signals (live, last 5 days)
      postmaster,

      // Score trend (last 12 months of baselines)
      score_trend: scoreTrend,

      // Month-over-month comparison
      mom_comparison: prevBaseline ? {
        strict_score: { curr: strictScore,           prev: prevBaseline.strict_score,  delta: scoreDelta ?? 0 },
        open_rate:    { curr: baseline.open_rate,    prev: prevBaseline.open_rate,     delta: parseFloat((baseline.open_rate  - prevBaseline.open_rate).toFixed(2))  },
        click_rate:   { curr: baseline.click_rate,   prev: prevBaseline.click_rate,    delta: parseFloat((baseline.click_rate - prevBaseline.click_rate).toFixed(2)) },
        delivered:    { curr: baseline.delivered,    prev: prevBaseline.delivered,     delta: baseline.delivered    - prevBaseline.delivered    },
        engaged_90d:  { curr: baseline.engaged_90d,  prev: prevBaseline.engaged_90d,   delta: baseline.engaged_90d  - prevBaseline.engaged_90d  },
        prev_month_label: monthLabel(prevMonth),
      } : null,

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
