/**
 * /api/schema-tool/snippets
 * GET ?q=text[&regex=1][&case=0][&inactive=1][&fresh=1]  → search results with contexts
 * GET (no q)                                               → snippet list (no code)
 */
import { NextRequest, NextResponse } from 'next/server'
import { listSnippets } from '@/lib/schema-tool/wp'
import { searchSnippets, validateSnippet } from '@/lib/schema-tool/engine'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const sp = new URL(req.url).searchParams
    const snippets = await listSnippets({ fresh: sp.get('fresh') === '1' })
    const q = sp.get('q') || ''
    const inactive = sp.get('inactive') === '1'
    if (q) {
      let r
      try {
        r = searchSnippets(snippets, { find: q, regex: sp.get('regex') === '1', caseSensitive: sp.get('case') !== '0', activeOnly: !inactive, limitPerSnippet: 3 })
      } catch (e) { return fail(e, 400) }
      return NextResponse.json(r)
    }
    return NextResponse.json({
      snippets: snippets.filter(s => inactive || s.status === 'active').map(s => ({
        id: s.id, name: s.name, status: s.status, display_on: s.display_on, s_pages: s.s_pages, s_posts: s.s_posts,
        size: s.snippet.length, valid: validateSnippet(s.snippet).ok,
      })),
      total: snippets.length,
    })
  } catch (e) { return fail(e) }
}
