import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const db = getDb()

  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT id)                                           AS total_agents,
      (SELECT COUNT(*) FROM agents WHERE status = 'active')       AS active_agents,
      (SELECT SUM(tokens_used) FROM agents)                       AS total_tokens,
      (SELECT COUNT(*) FROM tasks WHERE status = 'completed')     AS tasks_completed,
      (SELECT COUNT(*) FROM tasks WHERE status = 'pending')       AS tasks_pending,
      (SELECT COUNT(*) FROM tasks WHERE status = 'running')       AS tasks_running,
      (SELECT COUNT(*) FROM tasks WHERE status = 'failed')        AS tasks_failed
    FROM agents
  `).get() as Record<string, number>

  const recentActivity = db.prepare(`
    SELECT tl.*, a.name as agent_name, a.accent
    FROM task_logs tl
    LEFT JOIN agents a ON tl.agent_id = a.id
    ORDER BY tl.created_at DESC LIMIT 20
  `).all()

  return NextResponse.json({ totals, recentActivity })
}
