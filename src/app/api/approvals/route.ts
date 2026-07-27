import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getPendingApprovals, resolveApproval, updatePipelineRun, getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getPendingApprovals())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const { approval_id, action, note } = await req.json()
  if (!approval_id || !action) return NextResponse.json({ error: 'approval_id and action required' }, { status: 400 })

  resolveApproval(approval_id, action === 'approve' ? 'approved' : 'rejected', note || '')

  // Get the approval to find the run
  const approval = getDb().prepare('SELECT * FROM pipeline_approvals WHERE id=?').get(approval_id) as any
  if (!approval) return NextResponse.json({ error: 'Approval not found' }, { status: 404 })

  if (action === 'approve') {
    // Resume the pipeline from the next step
    const run = getDb().prepare('SELECT * FROM pipeline_runs WHERE id=?').get(approval.run_id) as any
    if (run) {
      const pipeline = getDb().prepare('SELECT * FROM pipelines WHERE id=?').get(run.pipeline_id) as any
      if (pipeline) {
        const baseUrl = process.env.INTERNAL_URL || 'http://localhost:3000'
        const secret  = process.env.JWT_SECRET || ''
        // Resume from step after the approval step
        fetch(`${baseUrl}/api/pipelines/${run.pipeline_id}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': secret },
          body: JSON.stringify({ resume_run_id: run.id, resume_from_step: approval.step_index + 1, prev_result: run.last_result }),
        }).catch(() => {})
      }
      updatePipelineRun(approval.run_id, { status: 'running' })
    }
  } else {
    // Rejected — mark run as failed
    if (approval.run_id) {
      updatePipelineRun(approval.run_id, { status: 'rejected', completed_at: new Date().toISOString() })
    }
  }

  return NextResponse.json({ ok: true })
}
