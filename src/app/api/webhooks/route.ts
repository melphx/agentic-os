import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAllWebhooks, createWebhook, deleteWebhook } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getAllWebhooks())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  const wh = createWebhook({ name: b.name, url: b.url, headers: JSON.stringify(b.headers || {}), events: b.events || 'task.completed', agent_filter: b.agent_filter || null, enabled: 1 })
  return NextResponse.json(wh, { status: 201 })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  deleteWebhook(id)
  return NextResponse.json({ ok: true })
}
