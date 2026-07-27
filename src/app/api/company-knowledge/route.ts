import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getCompanyKnowledge, saveCompanyKnowledge, deleteCompanyKnowledge } from '@/lib/db'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getCompanyKnowledge())
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const formData = await req.formData()
  const files = formData.getAll('files') as File[]
  if (!files.length) return NextResponse.json({ error: 'No files' }, { status: 400 })
  const saved = []
  for (const file of files) {
    if (file.size > 5 * 1024 * 1024) { saved.push({ filename: file.name, error: 'Too large (max 5MB)' }); continue }
    const buffer = Buffer.from(await file.arrayBuffer())
    let content = buffer.toString('utf-8')
    if (file.name.endsWith('.html')) content = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (file.name.endsWith('.json')) { try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {} }
    if (file.name.endsWith('.pdf')) {
      try { const pdfParse = require('pdf-parse'); const d = await pdfParse(buffer); if (d.text?.trim()) content = d.text.trim() } catch {}
    }
    const kb = saveCompanyKnowledge(file.name, 'text', file.size, content.slice(0, 100000))
    saved.push({ id: kb.id, filename: file.name })
  }
  return NextResponse.json({ saved })
}

export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  deleteCompanyKnowledge(id)
  return NextResponse.json({ ok: true })
}
