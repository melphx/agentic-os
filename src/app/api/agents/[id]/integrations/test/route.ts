import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { executeIntegration } from '@/lib/integrations'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const body = await req.json()
  try {
    const result = await executeIntegration(body.type, JSON.parse(body.config || '{}'), body.payload || {})
    return NextResponse.json({ ok: true, result })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 200 })
  }
}
