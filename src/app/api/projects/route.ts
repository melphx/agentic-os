import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getProjects, createProject, updateProject, deleteProject, getProjectTasks, addTaskToProject } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = req.nextUrl.searchParams.get('id')
  if (id) {
    const tasks = getProjectTasks(parseInt(id))
    return NextResponse.json(tasks)
  }
  return NextResponse.json(getProjects())
}
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  if (b.action === 'add_task') { addTaskToProject(b.project_id, b.task_id); return NextResponse.json({ ok: true }) }
  const p = createProject({ name: b.name, description: b.description || '', status: 'active', agent_ids: JSON.stringify(b.agent_ids || []) })
  return NextResponse.json(p, { status: 201 })
}
export async function PATCH(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  updateProject(b.id, b)
  return NextResponse.json({ ok: true })
}
export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  deleteProject(parseInt(req.nextUrl.searchParams.get('id') || '0'))
  return NextResponse.json({ ok: true })
}
