import { NextResponse } from 'next/server'
import { getMcdConversations, createMcdConversation } from '@/lib/db'

export async function GET() {
  try {
    const conversations = getMcdConversations(60)
    return NextResponse.json({ conversations })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const title = (body.title as string | undefined)?.trim() || 'New Chat'
    const conversation = createMcdConversation(title)
    return NextResponse.json({ conversation })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
