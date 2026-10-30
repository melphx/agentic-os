/** Schema Tool — shared route helpers. */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getChangeset, getItems, ItemRow } from './store'
import { isRunning } from './changesets'
import { describeRows, getSource } from './sources'

export async function guard(req: NextRequest): Promise<{ email: string | null; error: NextResponse | null }> {
  const { session, error } = await requireAuth(req)
  if (error) return { email: null, error }
  return { email: (session as any)?.email || null, error: null }
}

export function fail(e: unknown, status = 500) {
  const msg = e instanceof Error ? e.message : String(e)
  return NextResponse.json({ error: msg }, { status })
}

export function changesetSummary(id: number) {
  const cs = getChangeset(id)
  if (!cs) return null
  const items = getItems(id) as ItemRow[]
  const count = (st: string) => items.filter(i => i.status === st).length
  const meta = cs.meta ? JSON.parse(cs.meta) : {}
  // sheet rows staged before row details were stored: fill in type / URL / current status from the last read
  if (meta.sheet?.rows?.some((r: any) => r.type === undefined)) {
    const src = getSource(meta.sheet.source_id)
    if (src) meta.sheet.rows = describeRows(src, meta.sheet.rows)
  }
  const snippetIds = new Set<number>()
  items.forEach(i => snippetIds.add(i.snippet_id))
  return {
    ...cs,
    meta,
    running: isRunning(id),
    snippet_count: snippetIds.size,
    mention_count: items.reduce((a, i) => a + (i.mentions || 0), 0),
    counts: { total: items.length, applied: count('applied'), pending: count('pending'), failed: count('failed'), conflict: count('conflict'), reverted: count('reverted'), skipped: count('skipped') },
    samples: items.slice(0, 3).map(i => ({ snippet_id: i.snippet_id, snippet_name: i.snippet_name, preview: i.preview ? JSON.parse(i.preview)[0] : null })),
  }
}
