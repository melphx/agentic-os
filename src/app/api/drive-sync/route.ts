import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDriveSyncConfigs, createDriveSyncConfig, deleteDriveSyncConfig, updateDriveSyncConfig, saveKnowledge, saveCompanyKnowledge } from '@/lib/db'

async function getGoogleToken(sa: Record<string, string>, scope: string): Promise<string> {
  const { createSign } = await import('crypto')
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim  = Buffer.from(JSON.stringify({ iss: sa.client_email, scope, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now })).toString('base64url')
  const sign = createSign('RSA-SHA256'); sign.update(`${header}.${claim}`)
  const jwt = `${header}.${claim}.${sign.sign(sa.private_key, 'base64url')}`
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
        const sa = JSON.parse(cfg.service_account_json)
        const token = await getGoogleToken(sa, 'https://www.googleapis.com/auth/drive.readonly')
        // List files in folder
        const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q='${cfg.folder_id}'+in+parents+and+trashed=false&fields=files(id,name,mimeType,modifiedTime)&pageSize=50`, { headers: { Authorization: `Bearer ${token}` } })
        const listData = await listRes.json() as Record<string, any>
        const files: any[] = listData.files || []
        let synced = 0
        for (const file of files) {
          let content = ''
          // Export based on mime type
          if (file.mimeType === 'application/vnd.google-apps.document') {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } })
            content = await r.text()
          } else if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=text/csv`, { headers: { Authorization: `Bearer ${token}` } })
            content = await r.text()
          } else if (file.mimeType?.startsWith('text/') || file.name?.match(/\.(txt|md|csv|json)$/)) {
            const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } })
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
