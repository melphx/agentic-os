import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getPipeline, createTask, getDb } from '@/lib/db'

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error

  const pipeline = getPipeline(parseInt(params.id))
  if (!pipeline) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 })

  const steps: any[] = JSON.parse(pipeline.steps || '[]')
  if (!steps.length) return NextResponse.json({ error: 'Pipeline has no steps' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  const inputVars: Record<string, string> = body.variables || {}
  const baseUrl = process.env.INTERNAL_URL || 'http://localhost:3000'
  const secret  = process.env.JWT_SECRET || ''

  const run = async () => {
    let prevResult = ''
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]
      let desc  = step.description || step.prompt || ''
      let title = step.title || `${pipeline.name} — Step ${i + 1}`
      for (const [k, v] of Object.entries(inputVars)) {
        desc  = desc.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
        title = title.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v)
      }
      if (prevResult && step.use_previous !== false) {
        desc += `\n\nPrevious step output:\n${prevResult.slice(0, 2000)}`
      }
      const task = createTask({ agent_id: step.agent_id || null, title, description: desc, type: step.type || 'general', priority: 1, status: 'pending' })
      await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': secret },
        body: JSON.stringify({ agent_id: step.agent_id, title, description: desc, type: step.type || 'general', priority: 1 }),
      })
      const start = Date.now()
      while (Date.now() - start < 300000) {
        await new Promise(r => setTimeout(r, 2500))
        const row = getDb().prepare('SELECT status, result FROM tasks WHERE id = ?').get(task.id) as any
        if (row?.status === 'completed') { prevResult = row.result || ''; break }
        if (['failed','cancelled'].includes(row?.status)) { prevResult = `Step ${i+1} failed: ${row.error || ''}`; break }
      }
    }
  }

  run().catch(console.error)
  return NextResponse.json({ ok: true, message: `Pipeline "${pipeline.name}" started`, steps: steps.length })
}
