/**
 * /api/schema-tool/page-check  POST { url } → what schema the page outputs, validity, FAQ match
 */
import { NextRequest, NextResponse } from 'next/server'
import { checkPage } from '@/lib/schema-tool/pagecheck'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const { url } = await req.json()
    if (!url) return NextResponse.json({ error: 'url required' }, { status: 400 })
    return NextResponse.json({ check: await checkPage(String(url)) })
  } catch (e) { return fail(e) }
}
