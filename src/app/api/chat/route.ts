import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
})

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

const SYSTEM_PROMPT = [
  'You are the AI brain powering Claude OS — a production mission control dashboard for managing AI agents.',
  'You have access to a fleet of specialist agents: Research Agent, Code Engineer, Data Analyst, Content Writer, Email Manager, and Security Analyst.',
  'Be helpful, concise, and technically precise. When the user asks you to run a task, confirm what you will do.',
  'Use markdown sparingly — responses are displayed in a dark terminal-style chat UI.',
].join(' ')

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  try {
    const { messages } = await req.json()

    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    })

    const content = response.choices[0].message.content || '(No response)'
    const tokensUsed = response.usage?.total_tokens || 0

    const db = getDb()
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
    if (lastUser) {
      db.prepare('INSERT INTO chat_messages (role, content) VALUES (?, ?)').run('user', lastUser.content)
    }
    db.prepare('INSERT INTO chat_messages (role, content, tokens_used) VALUES (?, ?, ?)').run('assistant', content, tokensUsed)

    return NextResponse.json({ content, tokensUsed, model: MODEL })
  } catch (err: any) {
    console.error('[chat/route]', err)
    return NextResponse.json({ error: err.message || 'Failed to get a response.' }, { status: 500 })
  }
}
