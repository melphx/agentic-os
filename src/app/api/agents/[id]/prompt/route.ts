import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { setAgentCustomPrompt } from '@/app/api/run/route'

// GET /api/agents/[id]/prompt — read stored prompt
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const db = getDb()
  ensureTable(db)
  const row = db.prepare(`SELECT value FROM agent_settings WHERE agent_id = ? AND key = 'custom_prompt'`).get(params.id) as { value: string } | undefined
  return NextResponse.json({ prompt: row?.value ?? null })
}

// POST /api/agents/[id]/prompt — save prompt and inject into runtime cache
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const { prompt } = await req.json()
  if (typeof prompt !== 'string') return NextResponse.json({ error: 'prompt must be a string' }, { status: 400 })

  const db = getDb()
  ensureTable(db)

  db.prepare(`
    INSERT INTO agent_settings (agent_id, key, value)
    VALUES (?, 'custom_prompt', ?)
    ON CONFLICT(agent_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(params.id, prompt)

  // Inject into the in-process runtime cache immediately
  setAgentCustomPrompt(params.id, prompt)

  return NextResponse.json({ ok: true })
}

// DELETE /api/agents/[id]/prompt — clear custom prompt
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const db = getDb()
  ensureTable(db)
  db.prepare(`DELETE FROM agent_settings WHERE agent_id = ? AND key = 'custom_prompt'`).run(params.id)
  setAgentCustomPrompt(params.id, '')

  return NextResponse.json({ ok: true })
}

function ensureTable(db: ReturnType<typeof getDb>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(agent_id, key)
    )
  `)
}
