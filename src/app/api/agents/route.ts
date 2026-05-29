import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAgents, getMetricHistory } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const agents = getAgents()
  const enriched = agents.map(a => ({
    ...a,
    sparkline: getMetricHistory(a.id, 'tokens', 12),
  }))
  return NextResponse.json(enriched)
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json()
  if (!body.name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  const id = body.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 32)
  const db = (await import('@/lib/db')).getDb()

  // Check if already exists
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id)
  if (existing) return NextResponse.json({ error: `Agent "${id}" already exists` }, { status: 409 })

  db.prepare(`
    INSERT INTO agents (id, name, short, description, accent, accent_dark, status)
    VALUES (?, ?, ?, ?, ?, ?, 'idle')
  `).run(
    id,
    body.name,
    body.short || body.name.slice(0, 3).toUpperCase(),
    body.description || '',
    body.accent || '#6366f1',
    body.accent_dark || '#4338ca',
  )

  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
  return NextResponse.json(agent, { status: 201 })
}
