import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(req: NextRequest) {
  try {
    const { messages, apiKey, model } = await req.json()

    const key = apiKey || process.env.ANTHROPIC_API_KEY

    if (!key) {
      return NextResponse.json(
        { error: 'No API key found. Add ANTHROPIC_API_KEY to .env.local, or enter it in Settings.' },
        { status: 401 },
      )
    }

    const client = new Anthropic({ apiKey: key })

    const response = await client.messages.create({
      model: model || 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [
        'You are Claude, the AI brain powering Claude OS — a beautiful mission control dashboard',
        'for managing AI agents. You have access to a fleet of specialist agents: Research Agent,',
        'Code Engineer, Data Analyst, Content Writer, Email Manager, and Security Analyst.',
        'Be helpful, concise, and occasionally reference the OS/agent context when it is relevant.',
        'Use markdown sparingly — responses are displayed in a dark chat UI.',
      ].join(' '),
      messages,
    })

    const text =
      response.content[0].type === 'text'
        ? response.content[0].text
        : '(No text response)'

    return NextResponse.json({ content: text })
  } catch (err: any) {
    console.error('[chat/route]', err)
    return NextResponse.json(
      { error: err.message || 'Failed to get a response from Claude.' },
      { status: 500 },
    )
  }
}
