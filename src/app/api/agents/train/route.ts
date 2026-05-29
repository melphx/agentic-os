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

function extractText(buffer: Buffer, mimeType: string, filename: string): string {
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
    try {
      const parsed = JSON.parse(raw)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return raw
    }
  }

  // PDF: basic text extraction (strip binary, grab readable chars)
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
    // Extract text between BT and ET markers (basic PDF text extraction)
    const text = buffer.toString('latin1')
    const textMatches = text.match(/BT[\s\S]*?ET/g) || []
    if (textMatches.length > 0) {
      const extracted = textMatches
        .join('\n')
        .replace(/[^\x20-\x7E\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (extracted.length > 100) return extracted
    }
    // Fallback: grab printable ASCII runs
    return text.replace(/[^\x20-\x7E\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50000)
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

      const content = extractText(buffer, mimeType, file.name)
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
