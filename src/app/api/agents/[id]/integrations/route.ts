import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAllIntegrations, createIntegration, updateIntegration, deleteIntegration } from '@/lib/db'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getAllIntegrations(params.id))
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const body = await req.json()
  const integration = createIntegration({
    agent_id: params.id,
    name: body.name,
    type: body.type,
    description: body.description,
    config: JSON.stringify(body.config || {}),
    enabled: 1,
  })
  return NextResponse.json(integration, { status: 201 })
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const body = await req.json()
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (body.config) body.config = JSON.stringify(body.config)
  updateIntegration(body.id, body)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('integration_id') || '0')
  if (!id) return NextResponse.json({ error: 'integration_id required' }, { status: 400 })
  deleteIntegration(id, params.id)
  return NextResponse.json({ ok: true })
}
