/**
 * /api/schema-tool/chat
 * GET                    → recent conversations
 * GET ?conversation_id=X → messages, changesets they staged, and the latest assistant job (running / done / error + steps)
 * POST { conversation_id?, message, attachment_ids? } → starts the assistant in the background and returns right away
 *                                       { conversation_id, job_id }. The UI polls GET until the job is done,
 *                                       so leaving the page doesn't lose the answer.
 *                                       Google Docs / Sheets / Drive links in the message are read automatically.
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { runAgent } from '@/lib/schema-tool/agent'
import { addMessage, createJob, finishJob, getMessages, getSettings, latestJob, listConversations, setMessageAttachments, updateJobSteps } from '@/lib/schema-tool/store'
import { attachLink, attachmentRefLine, AttachmentSummary, claimAttachments, KIND_LABEL, summaries } from '@/lib/schema-tool/attachments'
import { findGoogleLinks } from '@/lib/schema-tool/sources'
import { startApply } from '@/lib/schema-tool/changesets'
import { changesetSummary, fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const MAX_PARTS = 3

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
    const uploadIds: number[] = Array.isArray(body.attachment_ids) ? body.attachment_ids.map(Number).filter((n: number) => n > 0).slice(0, 10) : []
    const message = String(body.message || '').trim() || (uploadIds.length ? 'Please look at the attached file(s).' : '')
    if (!message) return NextResponse.json({ error: 'Empty message' }, { status: 400 })
    const conversationId = String(body.conversation_id || randomUUID())
    const running = latestJob(conversationId)
    if (running && running.status === 'running') return NextResponse.json({ error: 'Still working on your last message in this chat.' }, { status: 409 })

    const past = getMessages(conversationId, 16).map(m => ({
      role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: m.content + (m.changeset_ids.length ? `\n[staged changesets: ${m.changeset_ids.map(i => '#' + i).join(', ')}]` : '') + attachmentRefLine(m.attachments || []),
    }))
    claimAttachments(uploadIds, conversationId)
    const chip = (a: AttachmentSummary) => ({ id: a.id, kind: a.kind, name: a.name, url: a.url, error: a.error, note: a.note })
    const uploaded = summaries(uploadIds)
    const links = findGoogleLinks(message).slice(0, 6)
    const msgId = addMessage(conversationId, 'user', message, [], email, undefined, undefined,
      [...uploaded.map(chip), ...links.map(url => ({ id: 0, kind: /spreadsheets/.test(url) ? 'gsheet' : 'gdoc', name: 'Reading link…', url, pending: true }))])
    const jobId = createJob(conversationId)

    // run in the background — the response returns immediately
    void (async () => {
      try {
        const pre: string[] = []
        const linked: AttachmentSummary[] = []
        for (const url of links) {
          pre.push(`Reading ${/spreadsheets/.test(url) ? 'Google Sheet' : /document/.test(url) ? 'Google Doc' : 'Google Drive file'}`)
          updateJobSteps(jobId, pre)
          const a = await attachLink(url, conversationId, email)
          linked.push(a)
          pre[pre.length - 1] = a.error ? `Could not open ${KIND_LABEL[a.kind]} (${a.error.slice(0, 80)})` : `Read ${KIND_LABEL[a.kind]} “${a.name}”${a.note ? ` (${a.note})` : ''}`
          updateJobSteps(jobId, pre)
        }
        setMessageAttachments(msgId, [...uploaded, ...linked].map(chip))
        // A big job can run out of steps; carry on automatically (up to 3 parts) so nothing is left half done.
        let history: { role: 'user' | 'assistant'; content: string }[] = [...past, { role: 'user', content: message }]
        for (let part = 1; part <= MAX_PARTS; part++) {
          const { reply, changesetIds, steps, usage, hitLimit } = await runAgent(history, {
            conversationId, user: email, onProgress: s => updateJobSteps(jobId, s),
            attachmentIds: part === 1 ? [...uploaded, ...linked].map(a => a.id) : [], preSteps: part === 1 ? pre : [`Continuing (part ${part} of up to ${MAX_PARTS})`],
          })
          const { auto_apply_max } = getSettings()
          if (auto_apply_max > 0) {
            for (const id of changesetIds) {
              const s = changesetSummary(id)
              if (s && s.snippet_count <= auto_apply_max && !(s.meta?.invalid?.length)) startApply(id)
            }
          }
          addMessage(conversationId, 'assistant', reply, changesetIds, null, steps, usage.calls ? usage : undefined)
          if (!hitLimit || part === MAX_PARTS) break
          const cont = `↻ Continuing automatically (part ${part + 1}): finish whatever is left from the request above. Don't redo anything already staged.`
          addMessage(conversationId, 'user', cont, [], 'auto')
          history = [...history,
            { role: 'assistant', content: reply + (changesetIds.length ? `\n[staged changesets: ${changesetIds.map(i => '#' + i).join(', ')}]` : '') },
            { role: 'user', content: cont }]
        }
        finishJob(jobId, 'done')
      } catch (e: any) {
        addMessage(conversationId, 'assistant', `Something went wrong: ${e?.message || e}`)
        finishJob(jobId, 'error', e?.message || String(e))
      }
    })()

    return NextResponse.json({ conversation_id: conversationId, job_id: jobId })
  } catch (e) { return fail(e) }
}
