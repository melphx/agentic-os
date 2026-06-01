import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getTemplates, createTemplate, deleteTemplate } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const agentId = req.nextUrl.searchParams.get('agent_id') || undefined
  return NextResponse.json(getTemplates(agentId))
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const body = await req.json()
  const template = createTemplate({
    agent_id: body.agent_id || null,
    name: body.name,
    title_template: body.title_template,
    description_template: body.description_template,
    type: body.type || 'general',
    variables: JSON.stringify(body.variables || []),
  })
  return NextResponse.json(template, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  deleteTemplate(id)
  return NextResponse.json({ ok: true })
}
