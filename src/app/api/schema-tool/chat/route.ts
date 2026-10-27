/**
 * /api/schema-tool/chat
 * GET                    → recent conversations
 * GET ?conversation_id=X → messages (+ changeset summaries referenced by them)
 * POST { conversation_id?, message } → assistant reply + staged changesets (auto-applied if small enough and enabled)
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { runAgent } from '@/lib/schema-tool/agent'
import { addMessage, getMessages, getSettings, listConversations } from '@/lib/schema-tool/store'
import { startApply } from '@/lib/schema-tool/changesets'
import { changesetSummary, fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const cid = new URL(req.url).searchParams.get('conversation_id')
    if (!cid) return NextResponse.json({ conversations: listConversations(25) })
    const messages = getMessages(cid)
    const ids: number[] = []
    messages.forEach(m => m.changeset_ids.forEach(i => { if (ids.indexOf(i) < 0) ids.push(i) }))
    return NextResponse.json({ messages, changesets: ids.map(changesetSummary).filter(Boolean) })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { email, error } = await guard(req); if (error) return error
  try {
    const body = await req.json()
    const message = String(body.message || '').trim()
    if (!message) return NextResponse.json({ error: 'Empty message' }, { status: 400 })
    const conversationId = String(body.conversation_id || randomUUID())

    const past = getMessages(conversationId, 16).map(m => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content + (m.changeset_ids.length ? `\n[staged changesets: ${m.changeset_ids.map(i => '#' + i).join(', ')}]` : ''),
    }))
    addMessage(conversationId, 'user', message, [], email)

    const { reply, changesetIds } = await runAgent([...past, { role: 'user', content: message }], { conversationId, user: email })

    // Auto-apply small, clean changesets when the person turned that on
    const { auto_apply_max } = getSettings()
    const autoApplied: number[] = []
    if (auto_apply_max > 0) {
      for (const id of changesetIds) {
        const s = changesetSummary(id)
        if (s && s.snippet_count <= auto_apply_max && !(s.meta?.invalid?.length) && startApply(id).started) autoApplied.push(id)
      }
    }
    addMessage(conversationId, 'assistant', reply || '(no reply)', changesetIds)
    return NextResponse.json({
      conversation_id: conversationId,
      reply,
      changesets: changesetIds.map(changesetSummary).filter(Boolean),
      auto_applied: autoApplied,
    })
  } catch (e) { return fail(e) }
}
