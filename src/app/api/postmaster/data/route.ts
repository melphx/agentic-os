import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getGoogleOAuth, getPostmasterOAuth, savePostmasterTokens } from '@/lib/db'

async function getAccessToken(): Promise<string> {
  const pm = getPostmasterOAuth()
  if (!pm?.refresh_token) throw new Error('Postmaster not connected')
  if (pm.access_token && pm.expires_at > Date.now() + 300000) return pm.access_token

  const creds = getGoogleOAuth()
  if (!creds) throw new Error('No Google credentials')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: pm.refresh_token, client_id: creds.client_id, client_secret: creds.client_secret }),
  })
  const data = await res.json() as Record<string, any>
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`)
  savePostmasterTokens(pm.refresh_token, data.access_token, Date.now() + (data.expires_in || 3600) * 1000)
  return data.access_token
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const domain = req.nextUrl.searchParams.get('domain') || process.env.POSTMASTER_DOMAIN || process.env.GHL_DOMAIN || 'l.phxhomeremodeling.com'

  try {
    const token = await getAccessToken()
    const headers = { Authorization: `Bearer ${token}` }

    // First list accessible domains to confirm access
    const domainsRes = await fetch('https://gmailpostmastertools.googleapis.com/v1/domains', { headers, signal: AbortSignal.timeout(10000) })
    const domainsData = await domainsRes.json() as Record<string, any>
    console.log('[Postmaster domains]', JSON.stringify(domainsData).slice(0, 300))

    if (!domainsRes.ok) {
      return NextResponse.json({ error: `Postmaster API error: ${domainsData.error?.message || domainsRes.status}`, domains: null }, { status: 200 })
    }

    // Get last 7 days of traffic stats
    const today = new Date()
    const dates = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today)
      d.setDate(d.getDate() - i - 1)
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    })

    const statsResults = await Promise.all(
      dates.slice(0, 3).map(async date => {
        const res = await fetch(
          `https://gmailpostmastertools.googleapis.com/v1/domains/${encodeURIComponent(domain)}/trafficStats/${date.replace(/-/g,'')}`,
          { headers, signal: AbortSignal.timeout(10000) }
        )
        if (!res.ok) return null
        return res.json()
      })
    )

    const latestStats = statsResults.find(s => s !== null) as Record<string, any> | null

    const result = {
      domain,
      domain_reputation: latestStats?.domainReputation || 'UNKNOWN',
      spam_rate: latestStats?.userReportedSpamRatioHistory?.[0]?.spamRatio
        || latestStats?.spamRateHistory?.[0]?.spamRate || null,
      dkim_success_ratio: latestStats?.dkimSuccessRatio || null,
      spf_success_ratio: latestStats?.spfSuccessRatio || null,
      dmarc_success_ratio: latestStats?.dmarcSuccessRatio || null,
      inbound_encryption_ratio: latestStats?.inboundEncryptionRatio || null,
      delivery_errors: latestStats?.deliveryErrors || [],
      ip_reputations: latestStats?.ipReputations || [],
      data_date: latestStats ? dates[statsResults.indexOf(latestStats)] : null,
      raw: latestStats,
    }

    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
