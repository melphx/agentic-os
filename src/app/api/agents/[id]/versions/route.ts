import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getPromptVersions, savePromptVersion } from '@/lib/db'
import { setAgentCustomPrompt } from '@/app/api/run/route'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getPromptVersions(params.id))
}
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { prompt, note } = await req.json()
  savePromptVersion(params.id, prompt, note)
  return NextResponse.json({ ok: true })
}
export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { prompt } = await req.json()
  setAgentCustomPrompt(params.id, prompt)
  return NextResponse.json({ ok: true })
}
