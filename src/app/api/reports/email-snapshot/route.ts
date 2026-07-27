import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { saveEmailSnapshot, getAllSnapshots, ensureEmailSnapshotsTable, getDb } from '@/lib/db'

const GHL23 = (apiKey: string) => ({
  'Authorization': `Bearer ${apiKey}`,
  'Version': '2023-02-21',
})

// Take a snapshot of all workflow campaign stats right now
async function takeSnapshot(apiKey: string, locationId: string, snapshotDate: string) {
  // Get all campaigns with pagination
  let allCampaigns: any[] = []
  let offset = 0, totalFromApi = Infinity
  while (allCampaigns.length < totalFromApi) {
    const res = await fetch(
      `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/workflows?limit=20&offset=${offset}`,
      { headers: GHL23(apiKey), signal: AbortSignal.timeout(15000), cache: 'no-store' }
    )
    if (!res.ok) break
    const d = await res.json() as Record<string, any>
    if (typeof d.total === 'number') totalFromApi = d.total
    const batch: any[] = d.campaigns || []
    if (!batch.length) break
    allCampaigns = allCampaigns.concat(batch)
    offset += batch.length
  }

  // Deduplicate by sourceId
  const seen = new Set<string>()
  const campaigns = allCampaigns.filter((c: any) => {
    const sid = c.sourceId || c.id
    if (seen.has(sid)) return false; seen.add(sid); return true
  })

  let saved = 0
  const errors: string[] = []

  await Promise.all(campaigns.map(async (c: any) => {
    const sourceId = c.sourceId || c.id
    try {
      const res = await fetch(
        `https://services.leadconnectorhq.com/emails/public/v2/locations/${locationId}/campaigns/stats/workflow-campaigns/${sourceId}`,
        { headers: GHL23(apiKey), signal: AbortSignal.timeout(10000), cache: 'no-store' }
      )
      if (!res.ok) return
      const d = await res.json() as Record<string, any>
      const s = d.stats || {}
      if (!s.sent || s.sent === 0) return

      saveEmailSnapshot({
        snapshot_date: snapshotDate,
        location_id: locationId,
        source_id: sourceId,
        campaign_name: c.name || '',
        sent:         s.sent        || 0,
        opened:       s.opened      || 0,
        clicked:      s.clicked     || 0,
        bounced:      s.permanentFail || s.bounced || 0,
        complained:   s.complained   || 0,
        unsubscribed: s.unsubscribed || 0,
      })
      saved++
    } catch (e: any) {
      errors.push(`${c.name}: ${e.message}`)
    }
  }))

  return { campaigns: campaigns.length, saved, errors }
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  ensureEmailSnapshotsTable()
  const locationId = process.env.GHL_LOCATION_ID || ''
  const snapshots = getAllSnapshots(locationId)
  // Summarize available snapshots
  const dates = Array.from(new Set(snapshots.map((s: any) => s.snapshot_date as string))).sort()
  return NextResponse.json({ snapshot_dates: dates, total_records: snapshots.length })
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const locationId = (body.location_id  || process.env.GHL_LOCATION_ID || '').trim()
  const now = new Date()
  const defaultDate = now.toISOString().slice(0, 10)
  const snapshotDate = body.snapshot_date || defaultDate

  // Manual injection mode: caller provides pre-aggregated campaign data
  if (Array.isArray(body.manual_campaigns)) {
    if (!locationId) return NextResponse.json({ error: 'location_id required' }, { status: 400 })
    ensureEmailSnapshotsTable()
    let saved = 0
    for (const c of body.manual_campaigns as any[]) {
      if (!c.source_id) continue
      saveEmailSnapshot({
        snapshot_date: snapshotDate,
        location_id:   locationId,
        source_id:     c.source_id,
        campaign_name: c.name || '',
        sent:          c.sent          || 0,
        opened:        c.opened        || 0,
        clicked:       c.clicked       || 0,
        bounced:       c.bounced       || 0,
        complained:    c.complained    || 0,
        unsubscribed:  c.unsubscribed  || 0,
      })
      saved++
    }
    return NextResponse.json({ ok: true, snapshot_date: snapshotDate, saved, mode: 'manual' })
  }

  const apiKey = (body.ghl_api_key || process.env.GHL_API_KEY || '').trim()
  if (!apiKey || !locationId) return NextResponse.json({ error: 'credentials required' }, { status: 400 })

  try {
    const result = await takeSnapshot(apiKey, locationId, snapshotDate)
    return NextResponse.json({ ok: true, snapshot_date: snapshotDate, ...result })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const date = req.nextUrl.searchParams.get('date')
  const locationId = process.env.GHL_LOCATION_ID || req.nextUrl.searchParams.get('location_id') || ''
  if (!date) return NextResponse.json({ error: 'date required' }, { status: 400 })
  ensureEmailSnapshotsTable()
  const db = getDb()
  const result = db.prepare('DELETE FROM email_snapshots WHERE snapshot_date = ? AND location_id = ?').run(date, locationId)
  return NextResponse.json({ ok: true, deleted: result.changes })
}
