import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getOutputTemplates, createOutputTemplate, deleteOutputTemplate } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getOutputTemplates(req.nextUrl.searchParams.get('agent_id') || undefined))
}
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  const t = createOutputTemplate({ name: b.name, format: b.format || 'markdown', template: b.template, agent_id: b.agent_id || null })
  return NextResponse.json(t, { status: 201 })
}
export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  deleteOutputTemplate(parseInt(req.nextUrl.searchParams.get('id') || '0'))
  return NextResponse.json({ ok: true })
}
