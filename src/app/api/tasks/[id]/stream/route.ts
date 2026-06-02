import { NextRequest } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const taskId = parseInt(params.id)
  const db = getDb()

  let lastLogId = 0
  let closed = false

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try { controller.enqueue(`data: ${JSON.stringify(data)}\n\n`) } catch {}
      }

      // Send initial task state
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any
      if (!task) { send({ type: 'error', message: 'Task not found' }); controller.close(); return }
      send({ type: 'task', task })

      const poll = async () => {
        if (closed) return
        try {
          // Send new logs
          const logs = db.prepare('SELECT * FROM task_logs WHERE task_id = ? AND id > ? ORDER BY id ASC').all(taskId, lastLogId) as any[]
          for (const log of logs) {
            send({ type: 'log', log })
            lastLogId = log.id
          }

          // Send updated task state
          const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as any
          if (updated) {
            send({ type: 'task', task: updated })
            if (['completed', 'failed', 'cancelled'].includes(updated.status)) {
              send({ type: 'done', status: updated.status })
              controller.close()
              closed = true
              return
            }
          }
          setTimeout(poll, 250)
        } catch { controller.close(); closed = true }
      }

      setTimeout(poll, 100)

      req.signal.addEventListener('abort', () => { closed = true; try { controller.close() } catch {} })
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
