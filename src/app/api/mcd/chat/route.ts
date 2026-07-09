/**
 * /api/mcd/chat — live conversational Q&A with the MCD agent
 *
 * POST { message: string, history: { role: 'user'|'assistant', content: string }[] }
 *
 * Intelligently selects which connectors to call based on the question,
 * fetches live data, then streams an OpenAI response in MCD's voice.
 */

import { NextRequest, NextResponse } from 'next/server'
import { spawn }                     from 'child_process'
import pathModule                    from 'path'
import OpenAI                        from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

// ── Connector config (mirrors scheduler.ts) ───────────────────────────────

const SCRIPTS_DIR  = process.env.MCD_SCRIPTS_DIR  || '/root/agentic-os/mcd/scripts'
const VENV_PYTHON  = process.env.MCD_VENV_PYTHON   || '/root/agentic-os/mcd/venv/bin/python3'

const CONNECTOR_MAP: Record<string, { script: string; useVenv: boolean }> = {
  ghl:         { script: 'ghl_client.py',        useVenv: false },
  ga4:         { script: 'ga4_client.py',         useVenv: true  },
  gsc:         { script: 'gsc_client.py',         useVenv: true  },
  gtm:         { script: 'gtm_client.py',         useVenv: true  },
  wp:          { script: 'wp_client.py',          useVenv: false },
  initiatives: { script: 'initiatives_client.py', useVenv: true  },
}

function spawnPython(python: string, scriptPath: string, args: string[]): Promise<{ out: string; err: string; ok: boolean }> {
  return new Promise(resolve => {
    const mcdEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        ['GHL_API_KEY','GHL_LOCATION_ID','GA4_PROPERTY_ID','GA4_SA_JSON','GA4_FORM_EVENT',
         'GA4_KEYWORD_HERO_PROPERTY_ID','GA4_KH_KEYWORD_DIMENSION',
         'GSC_SITE_URL','GSC_SA_JSON','GTM_ACCOUNT_ID','GTM_CONTAINER_ID','GTM_SA_JSON',
         'INITIATIVES_DOC_ID','INITIATIVES_SA_JSON'].includes(k)
      )
    ) as NodeJS.ProcessEnv

    const proc = spawn(python, [scriptPath, ...args], {
      env: { ...process.env, ...mcdEnv },
      timeout: 25000,
    })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => resolve({ out, err, ok: code === 0 }))
    proc.on('error', e => resolve({ out: '', err: e.message, ok: false }))
  })
}

async function callConnector(name: string, args: string[] = []): Promise<string> {
  const cfg = CONNECTOR_MAP[name]
  if (!cfg) return `[${name}: unknown connector]`
  const python = cfg.useVenv ? VENV_PYTHON : (process.env.MCD_SYSTEM_PYTHON || 'python3')
  const script = pathModule.join(SCRIPTS_DIR, cfg.script)
  const { out, err, ok } = await spawnPython(python, script, args)
  if (!ok || !out.trim()) return `[${name}: ${err.slice(0, 200) || 'no data'}]`
  return out.trim().slice(0, 2000) // cap per connector
}

// ── Connector routing — pick which sources to query ───────────────────────

interface ConnectorPlan {
  connectors: string[]
  args: Record<string, string[]>
  reason: string
}

function planConnectors(message: string): ConnectorPlan {
  const m = message.toLowerCase()

  const want = {
    ghl:         /lead|contact|appoint|discovery|call|pipeline|opportunit|crm|booked|follow.?up|client|prospect/i.test(message),
    ga4:         /traffic|session|visit|channel|organic|paid|form|conversion|landing|page|source|medium|user/i.test(message),
    gsc:         /search|click|query|keyword|ranking|impression|seo|google search|position/i.test(message),
    initiatives: /initiative|priorit|focus|jeremy|goal|project|quarter/i.test(message),
    wp:          /wordpress|blog|post|content|publish|rank.?math/i.test(message),
    gtm:         /tag|gtm|trigger|pixel|tracking/i.test(message),
  }

  // Always include GHL as baseline — it's the most commonly asked-about source
  want.ghl = true

  // "What should I focus on" or general → pull everything key
  const isGeneral = /focus|today|summary|overview|how.?are|status|update|brief|this week|week/i.test(message)
  if (isGeneral) {
    want.ga4 = true
    want.gsc = true
    want.initiatives = true
  }

  const connectors = Object.entries(want).filter(([,v]) => v).map(([k]) => k)
  const args: Record<string, string[]> = {}

  // Date window for time-specific queries
  const today = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7))
  const mondayStr = monday.toISOString().slice(0,10)
  const todayStr  = today.toISOString().slice(0,10)

  if (want.ga4)  args.ga4  = ['channels', '--from', mondayStr, '--to', todayStr]
  if (want.gsc)  args.gsc  = ['wow', '--week-ending', todayStr]
  if (want.ghl)  args.ghl  = ['leads', '--from', mondayStr, '--to', todayStr]

  return { connectors, args, reason: connectors.join(', ') }
}

// ── MCD soul (condensed for chat context) ─────────────────────────────────

const MCD_CHAT_SYSTEM = `You are MCD — Marketing and Conversions Director for Phoenix Home Remodeling.

IDENTITY: You are Jeremy's blunt, data-first marketing analyst. You pull live data and give direct answers. No fluff, no hedging, no em dashes.

VOICE: Short sentences. Lead with the answer. Back it with numbers. If data is missing or stale, say so and say what it means.

CHAT RULES:
- Answer the specific question asked. Don't pad with unrequested sections.
- If asked "how many X" → give the number first, then context.
- If asked "what should I focus on" → give MAX 3 prioritized actions, ordered by impact.
- Bold key numbers and metrics.
- When data is provided, reference it specifically.
- Always "Discovery Call" (never "discovery call" or "DC").
- If you don't have data to answer, say so directly and suggest what connector would have it.

COMPANY: Phoenix Home Remodeling — remodeling contractor, Phoenix AZ. Primary metrics: qualified leads, Discovery Calls booked/completed, In-Home appointments, conversion rates through funnel.`

// ── Route handler ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { message, history = [] } = await req.json() as {
    message: string
    history: { role: 'user' | 'assistant'; content: string }[]
  }

  if (!message?.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }

  // Plan which connectors to call
  const plan = planConnectors(message)

  // Fetch connector data in parallel
  const dataChunks: string[] = []
  const sourcesHit: string[] = []

  if (plan.connectors.length > 0) {
    const fetches = plan.connectors.map(async name => {
      const args = plan.args[name] || []
      const result = await callConnector(name, args)
      if (!result.startsWith(`[${name}:`)) {
        sourcesHit.push(name.toUpperCase())
        return `### ${name.toUpperCase()} DATA\n${result}`
      }
      return `### ${name.toUpperCase()} DATA\n${result}` // include even errors
    })
    const results = await Promise.all(fetches)
    dataChunks.push(...results)
  }

  const dataContext = dataChunks.length > 0
    ? `\n\nLIVE DATA (just fetched):\n${dataChunks.join('\n\n')}`
    : ''

  // Build messages
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: MCD_CHAT_SYSTEM + dataContext },
    ...history.slice(-10), // last 10 turns for context
    { role: 'user', content: message },
  ]

  // Stream response
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      // First, send the sources metadata
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: 'sources', sources: sourcesHit })}\n\n`
      ))

      try {
        const completion = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o',
          messages,
          stream: true,
          max_completion_tokens: 800,
        })

        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`
            ))
          }
        }
      } catch (e: any) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', error: e.message })}\n\n`
        ))
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
