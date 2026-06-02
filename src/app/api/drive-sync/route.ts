import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDriveSyncConfigs, createDriveSyncConfig, deleteDriveSyncConfig, updateDriveSyncConfig, saveKnowledge, saveCompanyKnowledge, getGoogleOAuth, updateGoogleTokens } from '@/lib/db'

// Get token using OAuth refresh token (for org-managed accounts without service account)
async function getOAuthAccessToken(): Promise<string> {
  const oauth = getGoogleOAuth()
  if (!oauth?.refresh_token) throw new Error('Google Drive not connected. Go to Settings → Google Drive and connect your account.')
  // Return cached token if still valid (5 min buffer)
  if (oauth.access_token && oauth.expires_at > Date.now() + 300000) return oauth.access_token
  // Refresh it
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: oauth.refresh_token, client_id: oauth.client_id, client_secret: oauth.client_secret }),
  })
  const data = await res.json() as Record<string, any>
  if (!data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`)
  updateGoogleTokens(oauth.refresh_token, data.access_token, Date.now() + (data.expires_in || 3600) * 1000)
  return data.access_token
}

async function getGoogleToken(sa: Record<string, string>, scope: string): Promise<string> {
  const { createSign } = await import('crypto')
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim  = Buffer.from(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })).toString('base64url')
  // Unescape newlines — service account keys stored in DB often have literal \\n instead of real newlines
  const privateKey = (sa.private_key || '').replace(/\\n/g, '\n')
  if (!privateKey) throw new Error('No private_key found in service account JSON')
  const sign = createSign('RSA-SHA256'); sign.update(`${header}.${claim}`)
  const jwt = `${header}.${claim}.${sign.sign(privateKey, 'base64url')}`
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) })
  const d = await res.json() as Record<string, string>
  if (!d.access_token) throw new Error(`Auth failed: ${JSON.stringify(d)}`)
  return d.access_token
}

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getDriveSyncConfigs().map(c => ({ ...c, service_account_json: '***' })))
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()

  if (b.action === 'sync') {
    // Trigger immediate sync for a config
    const configs = getDriveSyncConfigs().filter(c => !b.id || c.id === b.id)
    const results: string[] = []
    for (const cfg of configs) {
      try {
        // Use OAuth token if service account not configured
        // Use OAuth if no valid service account JSON stored
        const saRaw = cfg.service_account_json
        const useOAuth = !saRaw || saRaw === '***' || saRaw === 'oauth'
        const token = useOAuth
          ? await getOAuthAccessToken()
          : await getGoogleToken(JSON.parse(saRaw), 'https://www.googleapis.com/auth/drive.readonly')
        // List files in folder
        // supportsAllDrives + includeItemsFromAllDrives enables Shared Drive support
        const listParams = new URLSearchParams({
          q: `'${cfg.folder_id}' in parents and trashed=false`,
          fields: 'files(id,name,mimeType,modifiedTime)',
          pageSize: '100',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        })
        const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams}`, { headers: { Authorization: `Bearer ${token}` } })
        const listData = await listRes.json() as Record<string, any>
        const files: any[] = listData.files || []
        let synced = 0
        for (const file of files) {
          let content = ''
          // Export based on mime type
          if (file.mimeType === 'application/vnd.google-apps.document') {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
            content = await r.text()
          } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
            content = await r.text()
          } else if (file.mimeType?.startsWith('text/') || file.name?.match(/\.(txt|md|csv|json)$/)) {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } })
            content = await r.text()
          }
          if (content.trim().length > 50) {
            if (cfg.agent_id) {
              saveKnowledge(cfg.agent_id, `[Drive] ${file.name}`, 'text', content.length, content.slice(0, 100000))
            } else {
              saveCompanyKnowledge(`[Drive] ${file.name}`, 'text', content.length, content.slice(0, 100000))
            }
            synced++
          }
        }
        updateDriveSyncConfig(cfg.id, { last_synced: new Date().toISOString() })
        results.push(`${cfg.name}: synced ${synced}/${files.length} files`)
      } catch (e: any) {
        results.push(`${cfg.name}: ERROR — ${e.message}`)
      }
    }
    return NextResponse.json({ ok: true, results })
  }

  // Create new config
  const cfg = createDriveSyncConfig({ agent_id: b.agent_id || null, name: b.name, folder_id: b.folder_id, service_account_json: b.service_account_json, enabled: 1 })
  return NextResponse.json({ ...cfg, service_account_json: '***' }, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  deleteDriveSyncConfig(parseInt(req.nextUrl.searchParams.get('id') || '0'))
  return NextResponse.json({ ok: true })
}
