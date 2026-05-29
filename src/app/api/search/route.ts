import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const q = req.nextUrl.searchParams.get('q')?.trim()
  if (!q) return NextResponse.json([])

  const db = getDb()
  const like = `%${q}%`
  const results: any[] = []

  // Search agents
  const agents = db.prepare(`
    SELECT id, name, status, description FROM agents
    WHERE name LIKE ? OR description LIKE ? LIMIT 4
  `).all(like, like) as any[]
  for (const a of agents) {
    results.push({ type: 'agent', id: a.id, title: a.name, subtitle: `${a.status} · ${a.description?.slice(0, 60)}` })
  }

  // Search tasks
  const tasks = db.prepare(`
    SELECT id, title, status, type, agent_id FROM tasks
    WHERE title LIKE ? OR description LIKE ? OR result LIKE ?
    ORDER BY created_at DESC LIMIT 6
  `).all(like, like, like) as any[]
  for (const t of tasks) {
    results.push({ type: 'task', id: t.id, title: t.title, subtitle: `${t.status} · ${t.type} · agent: ${t.agent_id || 'none'}` })
  }

  // Search logs
  const logs = db.prepare(`
    SELECT tl.message, tl.level, a.name as agent_name FROM task_logs tl
    LEFT JOIN agents a ON tl.agent_id = a.id
    WHERE tl.message LIKE ? LIMIT 4
  `).all(like) as any[]
  for (const l of logs) {
    results.push({ type: 'log', id: null, title: l.message.slice(0, 80), subtitle: `${l.level} · ${l.agent_name}` })
  }

  return NextResponse.json(results)
}
