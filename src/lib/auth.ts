import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'claude-os-dev-secret-change-in-production'
)
const COOKIE = 'claude-os-token'
const EXPIRY = '7d'

export async function signToken(payload: { userId: number; email: string }) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(EXPIRY)
    .sign(SECRET)
}

export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return payload as { userId: number; email: string }
  } catch {
    return null
  }
}

export async function getSession() {
  const cookieStore = cookies()
  const token = cookieStore.get(COOKIE)?.value
  if (!token) return null
  return verifyToken(token)
}

export function setAuthCookie(res: NextResponse, token: string) {
  res.cookies.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  })
  return res
}

export function clearAuthCookie(res: NextResponse) {
  res.cookies.set(COOKIE, '', { maxAge: 0, path: '/' })
  return res
}

/** Middleware helper — returns the session or a 401 response */
export async function requireAuth(req: NextRequest) {
  const token = req.cookies.get(COOKIE)?.value
  if (!token) return { session: null, error: NextResponse.json({ error: 'Unauthorised' }, { status: 401 }) }
  const session = await verifyToken(token)
  if (!session) return { session: null, error: NextResponse.json({ error: 'Invalid token' }, { status: 401 }) }
  return { session, error: null }
}
