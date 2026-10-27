/**
 * /api/schema-tool/changesets/:id
 * GET                 → changeset + items (previews)
 * GET ?item=N         → full line diff for one item
 * POST { action: 'apply', item_ids?, force? } | { action: 'revert', force? } | { action: 'discard' }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getChangeset, getItems, ItemFull, ItemRow, setChangesetStatus } from '@/lib/schema-tool/store'
import { startApply, startRevert } from '@/lib/schema-tool/changesets'
import { lineDiff } from '@/lib/schema-tool/engine'
import { changesetSummary, fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await guard(req); if (error) return error
  try {
    const id = Number(params.id)
    const summary = changesetSummary(id)
    if (!summary) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const itemId = new URL(req.url).searchParams.get('item')
    if (itemId) {
      const it = (getItems(id, true) as ItemFull[]).find(i => i.id === Number(itemId))
      if (!it) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
      const hunks = it.item_type === 'config'
        ? [{ before: [JSON.stringify(JSON.parse(it.before || '{}'), null, 2)], after: [JSON.stringify(JSON.parse(it.after || '{}'), null, 2)] }]
        : lineDiff(it.before || '', it.after || '', 200)
      return NextResponse.json({ item: { id: it.id, snippet_id: it.snippet_id, snippet_name: it.snippet_name, status: it.status }, hunks })
    }
    const items = (getItems(id) as ItemRow[]).map(i => ({ ...i, preview: i.preview ? JSON.parse(i.preview) : [] }))
    return NextResponse.json({ changeset: summary, items })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { error } = await guard(req); if (error) return error
  try {
    const id = Number(params.id)
    const cs = getChangeset(id)
    if (!cs) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const body = await req.json()
    if (body.action === 'apply') {
      const r = startApply(id, { itemIds: Array.isArray(body.item_ids) ? body.item_ids.map(Number) : undefined, force: !!body.force })
      if (!r.started) return NextResponse.json({ error: r.reason }, { status: 409 })
    } else if (body.action === 'revert') {
      const r = startRevert(id, { force: !!body.force })
      if (!r.started) return NextResponse.json({ error: r.reason }, { status: 409 })
    } else if (body.action === 'discard') {
      if (cs.status !== 'proposed') return NextResponse.json({ error: `Can't discard a changeset that is ${cs.status}` }, { status: 409 })
      setChangesetStatus(id, 'discarded')
    } else {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    return NextResponse.json({ changeset: changesetSummary(id) })
  } catch (e) { return fail(e) }
}
