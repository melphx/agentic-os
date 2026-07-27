import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb } from '@/lib/db'
import OpenAI from 'openai'

// Hermes Agent API server — falls back to standard OpenAI if not configured
const HERMES_BASE_URL = process.env.HERMES_BASE_URL || ''
const HERMES_API_KEY  = process.env.HERMES_API_KEY  || 'hermes-local'
const HERMES_MODEL    = process.env.HERMES_MODEL    || 'hermes-agent'

// Standard OpenAI fallback
const OAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const OAI_KEY      = process.env.OPENAI_API_KEY  || ''
const OAI_MODEL    = process.env.OPENAI_MODEL    || 'gpt-5.4'

const HERMES_SYSTEM = `You are Hermes, the AI command center for PHR OS — an AI agent platform built for Phoenix Home Remodeling.

You have full control over the system. Use the available tools to:
- Dispatch tasks to agents (research, writer, code, data, email, security)
- Create and run pipelines
- Create and manage projects
- Search past task results
- Check system status and metrics
- Configure agents and integrations

Always be direct and action-oriented. When the user asks you to do something, USE THE TOOLS to actually do it. Confirm actions concisely.`

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  try {
    const { messages, systemOverride } = await req.json()

    const useHermes = !!HERMES_BASE_URL
    const client = useHermes
      ? new OpenAI({ baseURL: HERMES_BASE_URL, apiKey: HERMES_API_KEY, timeout: 120000 })
      : new OpenAI({ baseURL: OAI_BASE_URL,    apiKey: OAI_KEY,         timeout: 60000  })

    const model   = useHermes ? HERMES_MODEL : OAI_MODEL
    const sysMsg  = systemOverride || HERMES_SYSTEM

    // For Hermes Agent, use session key for persistent memory
    const extraHeaders: Record<string, string> = {}
    if (useHermes) {
      extraHeaders['X-Hermes-Session-Key'] = 'claude-os:hermes-chat'
    }

    const response = await client.chat.completions.create(
      {
        model,
        max_completion_tokens: 2048,
        messages: [
          { role: 'system', content: sysMsg },
          ...messages,
        ],
      },
      { headers: extraHeaders }
    )

    const content    = response.choices[0].message.content || '(No response)'
    const tokensUsed = response.usage?.total_tokens || 0

    // Persist to DB
    const db = getDb()
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
    if (lastUser) db.prepare('INSERT INTO chat_messages (role, content) VALUES (?, ?)').run('user', lastUser.content)
    db.prepare('INSERT INTO chat_messages (role, content, tokens_used) VALUES (?, ?, ?)').run('assistant', content, tokensUsed)

    return NextResponse.json({
      content,
      tokensUsed,
      model,
      backend: useHermes ? 'hermes-agent' : 'openai',
    })
  } catch (err: any) {
    console.error('[hermes/route]', err)
    return NextResponse.json({ error: err.message || 'Failed to get response.' }, { status: 500 })
  }
}
