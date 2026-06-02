import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getBudget, setBudget } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getBudget(params.id))
}
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { limit } = await req.json()
  setBudget(params.id, parseInt(limit) || 0)
  return NextResponse.json({ ok: true })
}
