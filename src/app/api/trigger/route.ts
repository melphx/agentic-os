import { NextRequest, NextResponse } from 'next/server'
import { validateApiKey, createTask } from '@/lib/db'

// POST /api/trigger — inbound webhook for external systems (GHL, N8N, Zapier, etc.)
// Auth: x-api-key header with a key created in Settings
export async function POST(req: NextRequest) {
  const apiKey = req.headers.get('x-api-key') || req.nextUrl.searchParams.get('api_key') || ''
  if (!apiKey || !validateApiKey(apiKey)) {
    return NextResponse.json({ error: 'Invalid or missing API key' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { agent_id, title, description, type = 'general', priority = 2 } = body

  if (!title && !description) {
    return NextResponse.json({ error: 'title or description required' }, { status: 400 })
  }

  const effectiveTitle = (title || description).slice(0, 200)
  const effectiveDesc  = (description || title).trim()

  const task = createTask({
    agent_id: agent_id || null,
    title: effectiveTitle,
    description: effectiveDesc,
    type,
    priority,
    status: 'pending',
  })

  // Fire execution
  const baseUrl = process.env.INTERNAL_URL || 'http://localhost:3000'
  const secret  = process.env.JWT_SECRET || ''
  fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': secret },
    body: JSON.stringify({ agent_id, title: effectiveTitle, description: effectiveDesc, type, priority }),
  }).catch(() => {})

  return NextResponse.json({ ok: true, task_id: task.id, status: 'queued' })
}
