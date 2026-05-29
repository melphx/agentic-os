import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getDb } from '@/lib/db'
import { signToken, setAuthCookie } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const { email, password } = await req.json()
    if (!email || !password)
      return NextResponse.json({ error: 'Email and password required' }, { status: 400 })

    const db = getDb()
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | { id: number; email: string; password_hash: string } | undefined

    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })

    const token = await signToken({ userId: user.id, email: user.email })
    const res = NextResponse.json({ ok: true, email: user.email })
    return setAuthCookie(res, token)
  } catch (err: any) {
    console.error('[auth/login]', err)
    return NextResponse.json({ error: 'Login failed' }, { status: 500 })
  }
}
