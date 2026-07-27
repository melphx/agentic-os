import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getPipelines, createPipeline, updatePipeline, deletePipeline } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getPipelines())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const body = await req.json()
  const pipeline = createPipeline({
    name: body.name,
    description: body.description || '',
    steps: JSON.stringify(body.steps || []),
    enabled: 1,
  })
  return NextResponse.json(pipeline, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const body = await req.json()
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  if (body.steps) body.steps = JSON.stringify(body.steps)
  updatePipeline(body.id, body)
  return NextResponse.json({ ok: true })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  deletePipeline(id)
  return NextResponse.json({ ok: true })
}
