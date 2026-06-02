import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getGoogleOAuth, saveGoogleOAuth, updateGoogleTokens, clearGoogleOAuth } from '@/lib/db'

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly'

function getRedirectUri(req: NextRequest) {
  const host = req.headers.get('host') || 'localhost:3000'
  const proto = host.includes('localhost') ? 'http' : 'https'
  return `${proto}://${host}/api/drive-sync/oauth`
}

// GET /api/drive-sync/oauth?action=start — begin OAuth flow
// GET /api/drive-sync/oauth?code=... — OAuth callback
// GET /api/drive-sync/oauth?action=status — check connection status
// GET /api/drive-sync/oauth?action=disconnect — remove tokens
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const action = searchParams.get('action')
  const code   = searchParams.get('code')

  // OAuth callback from Google
  if (code) {
    const oauth = getGoogleOAuth()
    if (!oauth) return NextResponse.redirect(new URL('/settings?error=no_client', req.url))
    const redirectUri = getRedirectUri(req)
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: oauth.client_id,
        client_secret: oauth.client_secret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })
    const data = await res.json() as Record<string, any>
    if (!data.refresh_token) {
      const errorUrl = new URL('/', req.url)
      errorUrl.searchParams.set('gdrive_error', data.error_description || 'No refresh token returned. Make sure prompt=consent is set.')
      return NextResponse.redirect(errorUrl)
    }
    const expiresAt = Date.now() + (data.expires_in || 3600) * 1000
    updateGoogleTokens(data.refresh_token, data.access_token || '', expiresAt)
    // Redirect back to app with success
    return NextResponse.redirect(new URL('/?gdrive_connected=1', req.url))
  }

  if (action === 'status') {
    const { error } = await requireAuth(req)
    if (error) return error
    const oauth = getGoogleOAuth()
    return NextResponse.json({ connected: !!(oauth?.refresh_token), has_credentials: !!(oauth?.client_id) })
  }

  if (action === 'disconnect') {
    const { error } = await requireAuth(req)
    if (error) return error
    clearGoogleOAuth()
    return NextResponse.json({ ok: true })
  }

  if (action === 'start') {
    const { error } = await requireAuth(req)
    if (error) return error
    const oauth = getGoogleOAuth()
    if (!oauth?.client_id) return NextResponse.json({ error: 'No client credentials configured' }, { status: 400 })
    const redirectUri = getRedirectUri(req)
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', oauth.client_id)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', SCOPES)
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')  // forces refresh_token to be returned
    return NextResponse.redirect(authUrl.toString())
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

// POST /api/drive-sync/oauth — save client credentials
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { client_id, client_secret } = await req.json()
  if (!client_id || !client_secret) return NextResponse.json({ error: 'client_id and client_secret required' }, { status: 400 })
  saveGoogleOAuth(client_id, client_secret)
  return NextResponse.json({ ok: true })
}
