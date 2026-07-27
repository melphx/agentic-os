import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb, getUsers, updateUserRole } from '@/lib/db'
import { hash } from 'bcryptjs'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getUsers())
}
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { email, password, role = 'operator' } = await req.json()
  if (!email || !password) return NextResponse.json({ error: 'email and password required' }, { status: 400 })
  try {
    const db = getDb()
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'`).toString()
  } catch {}
  try {
    const passwordHash = await hash(password, 10)
    const db = getDb()
    const info = db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?,?,?)').run(email, passwordHash, role)
    return NextResponse.json({ id: info.lastInsertRowid, email, role }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e.message.includes('UNIQUE') ? 'Email already exists' : e.message }, { status: 400 })
  }
}
export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { id, role } = await req.json()
  updateUserRole(id, role)
  return NextResponse.json({ ok: true })
}
export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  getDb().prepare('DELETE FROM users WHERE id=?').run(id)
  return NextResponse.json({ ok: true })
}
