import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb, updateAgent } from '@/lib/db'

// PATCH /api/tasks/[id] — cancel or update a task
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const id = parseInt(params.id)
  if (!id) return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })

  const body = await req.json()
  const db = getDb()

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  // Only allow cancelling pending or running tasks
  if (body.status === 'cancelled') {
    if (!['pending', 'running'].includes(task.status)) {
      return NextResponse.json({ error: `Cannot cancel a task with status '${task.status}'` }, { status: 400 })
    }
    db.prepare(`
      UPDATE tasks
      SET status = 'cancelled', error = 'Cancelled by user', completed_at = datetime('now')
      WHERE id = ?
    `).run(id)

    // Reset agent status if it was running this task
    if (task.agent_id) {
      const stillRunning = db.prepare(
        `SELECT COUNT(*) as n FROM tasks WHERE agent_id = ? AND status = 'running'`
      ).get(task.agent_id) as { n: number }
      if (stillRunning.n === 0) {
        updateAgent(task.agent_id, { status: 'idle', current_task: null, progress: 0 })
      }
    }

    // Log the cancellation
    db.prepare(
      `INSERT INTO task_logs (task_id, agent_id, level, message) VALUES (?, ?, 'warn', 'Task cancelled by user')`
    ).run(id, task.agent_id || '')

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unsupported update' }, { status: 400 })
}

// GET /api/tasks/[id] — fetch a single task with its logs
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const id = parseInt(params.id)
  if (!id) return NextResponse.json({ error: 'Invalid task id' }, { status: 400 })

  const db = getDb()
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
  if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 })

  const logs = db.prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at ASC').all(id)
  return NextResponse.json({ ...task as object, logs })
}
