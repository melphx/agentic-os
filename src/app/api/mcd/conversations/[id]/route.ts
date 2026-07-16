import { NextResponse } from 'next/server'
import {
  getMcdConversation,
  getMcdMessages,
  updateMcdConversationTitle,
  updateMcdConversationSummary,
  deleteMcdConversation,
} from '@/lib/db'

type Params = { params: { id: string } }

export async function GET(_req: Request, { params }: Params) {
  try {
    const id = parseInt(params.id, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const conversation = getMcdConversation(id)
    if (!conversation) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const messages = getMcdMessages(id)
    return NextResponse.json({ conversation, messages })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const id = parseInt(params.id, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const body = await req.json()
    if (body.title !== undefined) updateMcdConversationTitle(id, body.title)
    if (body.summary !== undefined) updateMcdConversationSummary(id, body.summary)

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const id = parseInt(params.id, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    deleteMcdConversation(id)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
