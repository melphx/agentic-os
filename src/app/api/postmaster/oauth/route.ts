import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getGoogleOAuth, getPostmasterOAuth, savePostmasterTokens, clearPostmasterOAuth } from '@/lib/db'

const SCOPE = 'https://www.googleapis.com/auth/postmaster.readonly'

function getRedirectUri(req: NextRequest) {
  const host = req.headers.get('host') || 'localhost:3000'
  const proto = host.includes('localhost') ? 'http' : 'https'
  return `${proto}://${host}/api/postmaster/oauth`
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const action = searchParams.get('action')
  const code   = searchParams.get('code')

  // OAuth callback
  if (code) {
    const creds = getGoogleOAuth()
    if (!creds) return NextResponse.redirect(new URL('/?postmaster_error=no_credentials', req.url))
    const redirectUri = getRedirectUri(req)
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: creds.client_id, client_secret: creds.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    })
    const data = await res.json() as Record<string, any>
    if (!data.refresh_token) {
      return NextResponse.redirect(new URL('/?postmaster_error=no_refresh_token', req.url))
    }
    savePostmasterTokens(data.refresh_token, data.access_token || '', Date.now() + (data.expires_in || 3600) * 1000)
    return NextResponse.redirect(new URL('/?postmaster_connected=1', req.url))
  }

  if (action === 'status') {
    const { error } = await requireAuth(req)
    if (error) return error
    const pm = getPostmasterOAuth()
    return NextResponse.json({ connected: !!(pm?.refresh_token) })
  }

  if (action === 'disconnect') {
    const { error } = await requireAuth(req)
    if (error) return error
    clearPostmasterOAuth()
    return NextResponse.json({ ok: true })
  }

  if (action === 'start') {
    const { error } = await requireAuth(req)
    if (error) return error
    const creds = getGoogleOAuth()
    if (!creds?.client_id) return NextResponse.json({ error: 'No Google credentials configured. Set up Google Drive first.' }, { status: 400 })
    const redirectUri = getRedirectUri(req)
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', creds.client_id)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', SCOPE)
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    return NextResponse.redirect(authUrl.toString())
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
