/**
 * /api/schema-tool/chat
 * GET                    → recent conversations
 * GET ?conversation_id=X → messages, changesets they staged, and the latest assistant job (running / done / error + steps)
 * POST { conversation_id?, message } → starts the assistant in the background and returns right away
 *                                       { conversation_id, job_id }. The UI polls GET until the job is done,
 *                                       so leaving the page doesn't lose the answer.
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { runAgent } from '@/lib/schema-tool/agent'
import { addMessage, createJob, finishJob, getMessages, getSettings, latestJob, listConversations, updateJobSteps } from '@/lib/schema-tool/store'
import { startApply } from '@/lib/schema-tool/changesets'
import { changesetSummary, fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const cid = new URL(req.url).searchParams.get('conversation_id')
    if (!cid) return NextResponse.json({ conversations: listConversations(25) })
    const messages = getMessages(cid)
    const ids: number[] = []
    messages.forEach(m => m.changeset_ids.forEach(i => { if (ids.indexOf(i) < 0) ids.push(i) }))
    return NextResponse.json({ messages, changesets: ids.map(changesetSummary).filter(Boolean), job: latestJob(cid) })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { email, error } = await guard(req); if (error) return error
  try {
    const body = await req.json()
    const message = String(body.message || '').trim()
    if (!message) return NextResponse.json({ error: 'Empty message' }, { status: 400 })
    const conversationId = String(body.conversation_id || randomUUID())
    const running = latestJob(conversationId)
    if (running && running.status === 'running') return NextResponse.json({ error: 'Still working on your last message in this chat.' }, { status: 409 })

    const past = getMessages(conversationId, 16).map(m => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content + (m.changeset_ids.length ? `\n[staged changesets: ${m.changeset_ids.map(i => '#' + i).join(', ')}]` : ''),
    }))
    addMessage(conversationId, 'user', message, [], email)
    const jobId = createJob(conversationId)

    // run in the background — the response returns immediately
    void (async () => {
      try {
        const { reply, changesetIds, steps, usage } = await runAgent([...past, { role: 'user', content: message }], {
          conversationId, user: email, onProgress: s => updateJobSteps(jobId, s),
        })
        const { auto_apply_max } = getSettings()
        if (auto_apply_max > 0) {
          for (const id of changesetIds) {
            const s = changesetSummary(id)
            if (s && s.snippet_count <= auto_apply_max && !(s.meta?.invalid?.length)) startApply(id)
          }
        }
        addMessage(conversationId, 'assistant', reply, changesetIds, null, steps, usage.calls ? usage : undefined)
        finishJob(jobId, 'done')
      } catch (e: any) {
        addMessage(conversationId, 'assistant', `Something went wrong: ${e?.message || e}`)
        finishJob(jobId, 'error', e?.message || String(e))
      }
    })()

    return NextResponse.json({ conversation_id: conversationId, job_id: jobId })
  } catch (e) { return fail(e) }
}
