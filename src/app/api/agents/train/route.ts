import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getKnowledge, saveKnowledge, deleteKnowledge } from '@/lib/db'

// Supported file types and their extractors
const SUPPORTED_TYPES: Record<string, string> = {
  'text/plain': 'text',
  'text/markdown': 'markdown',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/html': 'html',
  'application/pdf': 'pdf',
}

async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const raw = buffer.toString('utf-8')

  // HTML: strip tags
  if (mimeType === 'text/html' || filename.endsWith('.html')) {
    return raw.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
  }

  // JSON: pretty-print
  if (mimeType === 'application/json' || filename.endsWith('.json')) {
    try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
  }

  // PDF: use pdf-parse for proper text extraction
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require('pdf-parse')
      const data = await pdfParse(buffer)
      const text = data.text?.trim()
      if (text && text.length > 50) return text.slice(0, 100000)
    } catch {}
    // Fallback: extract readable ASCII runs (avoids raw PDF structure)
    const latin = buffer.toString('latin1')
    const runs = latin.match(/[\x20-\x7E]{4,}/g) || []
    const cleaned = runs
      .filter(r => r.trim().split(' ').length > 1) // only keep multi-word runs
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    return cleaned.length > 100 ? cleaned.slice(0, 100000) : ''
  }

  // Default: return as-is
  return raw
}

// GET /api/agents/train?agent_id=xxx — list knowledge files
export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const agentId = req.nextUrl.searchParams.get('agent_id')
  if (!agentId) return NextResponse.json({ error: 'agent_id required' }, { status: 400 })

  const knowledge = getKnowledge(agentId)
  return NextResponse.json(knowledge)
}

// POST /api/agents/train — upload file(s)
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  try {
    const formData = await req.formData()
    const agentId = formData.get('agent_id') as string
    if (!agentId) return NextResponse.json({ error: 'agent_id required' }, { status: 400 })

    const files = formData.getAll('files') as File[]
    if (!files.length) return NextResponse.json({ error: 'No files provided' }, { status: 400 })

    const saved = []
    for (const file of files) {
      // Size limit: 2MB per file
      if (file.size > 2 * 1024 * 1024) {
        saved.push({ filename: file.name, error: 'File too large (max 2MB)' })
        continue
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || 'text/plain'
      const fileType = SUPPORTED_TYPES[mimeType] || (file.name.match(/\.(md|txt|csv|json|html|pdf)$/) ? 'text' : 'text')

      const content = await extractText(buffer, mimeType, file.name)
      if (!content.trim()) {
        saved.push({ filename: file.name, error: 'Could not extract text from file' })
        continue
      }

      const knowledge = saveKnowledge(agentId, file.name, fileType, file.size, content.slice(0, 100000))
      saved.push({ id: knowledge.id, filename: file.name, file_type: fileType, file_size: file.size })
    }

    return NextResponse.json({ saved })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

// DELETE /api/agents/train?id=X&agent_id=Y
export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const id = parseInt(req.nextUrl.searchParams.get('id') || '0')
  const agentId = req.nextUrl.searchParams.get('agent_id') || ''
  if (!id || !agentId) return NextResponse.json({ error: 'id and agent_id required' }, { status: 400 })

  deleteKnowledge(id, agentId)
  return NextResponse.json({ ok: true })
}
