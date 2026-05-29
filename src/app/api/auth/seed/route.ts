import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { getDb } from '@/lib/db'

// One-time endpoint to create the admin user. Disable after first use.
export async function POST(req: NextRequest) {
  try {
    const { email, password, seedKey } = await req.json()
    if (seedKey !== process.env.SEED_KEY)
      return NextResponse.json({ error: 'Invalid seed key' }, { status: 403 })

    const hash = await bcrypt.hash(password, 12)
    const db = getDb()
    db.prepare('INSERT OR REPLACE INTO users (email, password_hash) VALUES (?, ?)').run(email, hash)
    return NextResponse.json({ ok: true, message: `User ${email} created` })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
