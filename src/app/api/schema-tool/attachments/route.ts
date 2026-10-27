/**
 * /api/schema-tool/attachments
 * POST multipart/form-data  file=<one or more files> [conversation_id]  → { attachments: [...] }
 * POST { url, conversation_id?, tab? }                                    → { attachment } (Google Sheet / Doc / Drive link)
 * GET  ?conversation_id=X                                                → attachments in that chat
 */
import { NextRequest, NextResponse } from 'next/server'
import { attachLink, conversationAttachments, MAX_UPLOAD_BYTES, saveUpload } from '@/lib/schema-tool/attachments'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const cid = new URL(req.url).searchParams.get('conversation_id')
    return NextResponse.json({ attachments: cid ? conversationAttachments(cid) : [] })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { email, error } = await guard(req); if (error) return error
  try {
    if ((req.headers.get('content-type') || '').includes('multipart/form-data')) {
      const form = await req.formData()
      const cid = (form.get('conversation_id') as string) || null
      const files = form.getAll('file').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f)
      if (!files.length) return NextResponse.json({ error: 'No file received.' }, { status: 400 })
      const out: any[] = []
      for (const f of files) {
        if (f.size > MAX_UPLOAD_BYTES) { out.push({ name: f.name, error: 'Files must be under 20 MB.' }); continue }
        try { out.push(await saveUpload(f.name, f.type || '', Buffer.from(await f.arrayBuffer()), email, cid)) }
        catch (e: any) { out.push({ name: f.name, error: e?.message || String(e) }) }
      }
      return NextResponse.json({ attachments: out })
    }
    const body = await req.json()
    if (!body.url) return NextResponse.json({ error: 'Missing url' }, { status: 400 })
    return NextResponse.json({ attachment: await attachLink(String(body.url), body.conversation_id || null, email, body.tab || undefined) })
  } catch (e) { return fail(e) }
}
