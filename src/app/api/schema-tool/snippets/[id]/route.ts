/**
 * /api/schema-tool/snippets/:id
 * GET                      → full snippet (code + settings + validation)
 * POST { snippet, title? } → manual edit: saved as a changeset and applied right away (revertible from History)
 */
import { NextRequest, NextResponse } from 'next/server'
import { getSnippet } from '@/lib/schema-tool/wp'
import { validateSnippet, outsideScripts } from '@/lib/schema-tool/engine'
import { changesetFromEdits, startApply } from '@/lib/schema-tool/changesets'
import { changesetSummary, fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await guard(req); if (error) return error
  try {
    const s = await getSnippet(Number(params.id))
    return NextResponse.json({ snippet: s, validation: validateSnippet(s.snippet) })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { email, error } = await guard(req); if (error) return error
  try {
    const body = await req.json()
    const text = String(body.snippet ?? '')
    const v = validateSnippet(text)
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })
    const s = await getSnippet(Number(params.id))
    if (body.base !== undefined && body.base !== s.snippet) {
      return NextResponse.json({ error: 'This snippet changed on the site since you opened it. Reload it and redo your edit.' }, { status: 409 })
    }
    if (s.snippet === text) return NextResponse.json({ unchanged: true })
    if (outsideScripts(text) !== outsideScripts(s.snippet) && !body.allow_outside) {
      return NextResponse.json({ error: 'Only the JSON-LD inside <script> tags can be edited here.' }, { status: 400 })
    }
    const id = changesetFromEdits([{ snippet: s, after: text }], { title: String(body.title || `Manual edit of #${s.id}`), kind: 'manual', source: 'manual', created_by: email })
    startApply(id)
    return NextResponse.json({ changeset: changesetSummary(id) })
  } catch (e) { return fail(e) }
}
