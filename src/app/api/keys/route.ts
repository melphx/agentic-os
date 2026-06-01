import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getApiKeys, createApiKey, deleteApiKey } from '@/lib/db'
import { randomBytes, createHash } from 'crypto'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getApiKeys())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { name } = await req.json()
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 })
  // Generate key: cos_live_<32 random hex chars>
  const raw = `cos_live_${randomBytes(16).toString('hex')}`
  const hash = createHash('sha256').update(raw).digest('hex')
  const prefix = raw.slice(0, 16)
  createApiKey(name, prefix, hash)
  // Return full key ONCE — never stored in plaintext
  return NextResponse.json({ key: raw, prefix })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  deleteApiKey(id)
  return NextResponse.json({ ok: true })
}
