/**
 * /api/mcd/chat — live conversational Q&A with the MCD agent
 *
 * POST { message, history }
 *
 * Architecture:
 *   1. Pre-fetch non-GHL connectors (GA4, GSC, GTM, WP, Initiatives) via Python — keyword-routed.
 *   2. Let OpenAI tool-call the GHL MCP server for all GHL data (contacts, calendar, pipeline,
 *      opportunities, conversations). The model decides what it needs based on the question.
 *   3. Stream the final response once all data is collected.
 *
 * GHL MCP endpoint: https://services.leadconnectorhq.com/mcp/
 * Credentials from env: GHL_API_KEY (PIT token), GHL_LOCATION_ID
 */

import { NextRequest, NextResponse } from 'next/server'
import { spawn }                     from 'child_process'
import pathModule                    from 'path'
import OpenAI                        from 'openai'
import { callGHLMcp }                from '@/lib/ghl-mcp'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })

// ── Python connectors (non-GHL) ───────────────────────────────────────────

const SCRIPTS_DIR = process.env.MCD_SCRIPTS_DIR    || '/root/agentic-os/mcd/scripts'
const VENV_PYTHON = process.env.MCD_VENV_PYTHON    || '/root/agentic-os/mcd/venv/bin/python3'
const SYS_PYTHON  = process.env.MCD_SYSTEM_PYTHON  || 'python3'

function spawnPython(
  python: string, scriptPath: string, args: string[]
): Promise<{ out: string; err: string; ok: boolean }> {
  return new Promise(resolve => {
    const mcdEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        ['GHL_API_KEY','GHL_LOCATION_ID',
         'GA4_PROPERTY_ID','GA4_SA_JSON','GA4_FORM_EVENT',
         'GA4_KEYWORD_HERO_PROPERTY_ID','GA4_KH_KEYWORD_DIMENSION',
         'GSC_SITE_URL','GSC_SA_JSON',
         'GTM_ACCOUNT_ID','GTM_CONTAINER_ID','GTM_SA_JSON',
         'INITIATIVES_DOC_ID','INITIATIVES_SA_JSON'].includes(k)
      )
    ) as NodeJS.ProcessEnv

    const proc = spawn(python, [scriptPath, ...args], {
      env: { ...process.env, ...mcdEnv },
      timeout: 30000,
    })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => resolve({ out, err, ok: code === 0 }))
    proc.on('error', e  => resolve({ out: '', err: e.message, ok: false }))
  })
}

async function callPython(script: string, args: string[], useVenv = false): Promise<string> {
  const python = useVenv ? VENV_PYTHON : SYS_PYTHON
  const path   = pathModule.join(SCRIPTS_DIR, script)
  const { out, err, ok } = await spawnPython(python, path, args)
  if (!ok || !out.trim()) return `[${script}: ${err.slice(0, 200) || 'no data'}]`
  return out.trim().slice(0, 3000)
}

// ── GHL tools we expose to OpenAI ────────────────────────────────────────
//
// locationId is NEVER listed in the schema — we inject it ourselves in callGHLMcp.
// Epoch ms for calendar: we inject today's date context into the system prompt.

const GHL_OPENAI_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'ghl_get_contacts',
      description:
        'Fetch GHL contacts (leads). Returns the most recent contacts. ' +
        'No server-side date filter; use limit=100 for broad coverage and filter by dateAdded in your response. ' +
        'Use for: how many leads, new contacts, lead count, source breakdown.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max contacts to return (default 20, max 100). Use 100 for weekly summaries.',
          },
          query: {
            type: 'string',
            description: 'Optional: search by name, email, or phone.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_get_calendar_events',
      description:
        'Fetch GHL calendar events (Discovery Calls, in-home appointments, site visits). ' +
        'Use startTime/endTime as epoch milliseconds. ' +
        'Use for: Discovery Call counts, show rate, appointment data, booked/completed calls.',
      parameters: {
        type: 'object',
        properties: {
          startTime: {
            type: 'number',
            description: 'Start epoch milliseconds. Use the epoch values from the system prompt for date ranges.',
          },
          endTime: {
            type: 'number',
            description: 'End epoch milliseconds. Use the epoch values from the system prompt.',
          },
          calendarId: {
            type: 'string',
            description: 'Optional: specific calendar ID to filter events.',
          },
        },
        required: ['startTime', 'endTime'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_get_pipelines',
      description:
        'Fetch all GHL pipelines with stages and current open opportunity counts. ' +
        'This is a live snapshot. Use for: pipeline stage counts, funnel status, open deals by stage.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_search_opportunities',
      description:
        'Search GHL opportunities (deals) by status and date range. ' +
        'Use for: won deals, lost deals, close rate, conversion rate, revenue, deals in a date range.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'won', 'lost', 'abandoned'],
            description: 'Filter by deal status.',
          },
          date: {
            type: 'string',
            description: 'Start date in MM-DD-YYYY format.',
          },
          endDate: {
            type: 'string',
            description: 'End date in MM-DD-YYYY format.',
          },
          limit: {
            type: 'number',
            description: 'Number of results (default 20, max 100).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_search_conversations',
      description:
        'Search GHL conversations (calls, SMS, emails). Use for: call logs, message history, outbound calls, realtor line activity.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text or contact name.' },
          limit: { type: 'number', description: 'Number of results (default 20).' },
        },
      },
    },
  },
]

// Map from our OpenAI tool names to GHL MCP tool names + arg mapping
const GHL_TOOL_DISPATCH: Record<string, (args: Record<string, unknown>) => {
  mcpTool: string
  mcpArgs: Record<string, unknown>
}> = {
  ghl_get_contacts: (a) => ({
    mcpTool: 'contacts_get-contacts',
    mcpArgs: { limit: a.limit ?? 100, ...(a.query ? { query: a.query } : {}) },
  }),
  ghl_get_calendar_events: (a) => ({
    mcpTool: 'calendars_get-calendar-events',
    mcpArgs: { startTime: a.startTime, endTime: a.endTime, ...(a.calendarId ? { calendarId: a.calendarId } : {}) },
  }),
  ghl_get_pipelines: (_) => ({
    mcpTool: 'opportunities_get-pipelines',
    mcpArgs: {},
  }),
  ghl_search_opportunities: (a) => ({
    mcpTool: 'opportunities_search-opportunity',
    mcpArgs: Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)),
  }),
  ghl_search_conversations: (a) => ({
    mcpTool: 'conversations_search-conversation',
    mcpArgs: { query: a.query ?? '', limit: a.limit ?? 20 },
  }),
}

// ── Date context helpers ──────────────────────────────────────────────────

function buildDateContext(): {
  todayStr: string
  mondayStr: string
  lastMondayStr: string
  lastSundayStr: string
  todayEpoch: number
  mondayEpoch: number
  lastMondayEpoch: number
  lastSundayEpoch: number
  weekdayName: string
} {
  const now      = new Date()
  const dow      = now.getDay()                          // 0=Sun
  const monday   = new Date(now)
  monday.setDate(now.getDate() - ((dow + 6) % 7))
  monday.setHours(0, 0, 0, 0)

  const lastMonday = new Date(monday)
  lastMonday.setDate(monday.getDate() - 7)

  const lastSunday = new Date(monday)
  lastSunday.setDate(monday.getDate() - 1)
  lastSunday.setHours(23, 59, 59, 999)

  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

  return {
    todayStr:      iso(now),
    mondayStr:     iso(monday),
    lastMondayStr: iso(lastMonday),
    lastSundayStr: iso(lastSunday),
    todayEpoch:    now.getTime(),
    mondayEpoch:   monday.getTime(),
    lastMondayEpoch: lastMonday.getTime(),
    lastSundayEpoch: lastSunday.getTime(),
    weekdayName:   DAYS[dow],
  }
}

// ── Non-GHL connector keyword routing ────────────────────────────────────

async function fetchNonGHLData(message: string, dc: ReturnType<typeof buildDateContext>): Promise<string[]> {
  const wantsGA4    = /traffic|session|visit|channel|organic|paid|form|ga4|google analytic|landing|source|medium|user/i.test(message)
  const wantsGSC    = /search|click|query|keyword|ranking|impression|seo|google search|position/i.test(message)
  const wantsInit   = /initiative|priorit|focus|jeremy|goal|project|quarter/i.test(message)
  const wantsWP     = /wordpress|blog|post|content|publish|rank.?math/i.test(message)
  const wantsGTM    = /\bgtm\b|tag manager|trigger|pixel|tracking/i.test(message)
  const isGeneral   = /focus|today|summary|overview|how.?are|status|update|brief|this week|week|morning/i.test(message)

  const tasks: Array<{ label: string; fn: () => Promise<string> }> = []

  if (wantsGA4 || isGeneral)
    tasks.push({ label: 'GA4', fn: () => callPython('ga4_client.py', ['channels', '--from', dc.mondayStr, '--to', dc.todayStr], true) })

  if (wantsGSC || isGeneral)
    tasks.push({ label: 'GSC', fn: () => callPython('gsc_client.py', ['wow', '--week-ending', dc.todayStr], true) })

  if (wantsInit || isGeneral)
    tasks.push({ label: 'INITIATIVES', fn: () => callPython('initiatives_client.py', [], true) })

  if (wantsWP)
    tasks.push({ label: 'WP', fn: () => callPython('wp_client.py', []) })

  if (wantsGTM)
    tasks.push({ label: 'GTM', fn: () => callPython('gtm_client.py', []) })

  if (tasks.length === 0) return []

  const results = await Promise.all(tasks.map(async t => {
    const data = await t.fn()
    return `### ${t.label} DATA\n${data}`
  }))
  return results
}

// ── MCD system prompt ─────────────────────────────────────────────────────

function buildSystemPrompt(dc: ReturnType<typeof buildDateContext>, nonGHLContext: string): string {
  const base = `You are MCD — Marketing and Conversions Director for Phoenix Home Remodeling.

IDENTITY: Jeremy's blunt, data-first marketing analyst. Pull live data and give direct answers. No fluff, no hedging, no em dashes.

VOICE: Short sentences. Lead with the answer. Back it with numbers. If data is missing or stale, say so.

TODAY: ${dc.weekdayName}, ${dc.todayStr}
THIS WEEK: ${dc.mondayStr} → ${dc.todayStr} (epoch: ${dc.mondayEpoch} → ${dc.todayEpoch})
LAST WEEK: ${dc.lastMondayStr} → ${dc.lastSundayStr} (epoch: ${dc.lastMondayEpoch} → ${dc.lastSundayEpoch})

Use these epoch values directly when calling calendar tools. Do not compute your own.

CHAT RULES:
- Answer the specific question asked. Don't pad with unrequested sections.
- If asked "how many X" → give the number first, then context.
- If asked "what should I focus on" → give MAX 3 prioritized actions by impact.
- Bold key numbers. Use tables for comparisons.
- Write "Discovery Call" (not "DC" or "discovery call").
- Conversion rate = qualified leads → Discovery Calls booked. Show rate = completed / booked.
- Pipeline data = CURRENT open counts per stage. Lead/appointment data = date window specified.
- If the tool returns a lot of contact data, count contacts with dateAdded in the relevant date range.
- When calling ghl_get_contacts for weekly leads, use limit=100 and filter results by dateAdded.

COMPANY: Phoenix Home Remodeling — remodeling contractor, Phoenix AZ.
FUNNEL: Qualified Lead → Discovery Call booked → Discovery Call completed → In-Home appointment → Won deal.
KEY METRICS: qualified leads, Discovery Calls booked/completed, show rate, In-Home appointments, pipeline by stage.`

  const nonGHL = nonGHLContext.trim()
    ? `\n\nPRE-FETCHED DATA (use directly — do not say you don't have it):\n${nonGHLContext}`
    : ''

  return base + nonGHL
}

// ── Route handler ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { message, history = [] } = await req.json() as {
    message: string
    history: { role: 'user' | 'assistant'; content: string }[]
  }

  if (!message?.trim()) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 })
  }

  const dc = buildDateContext()

  // Run non-GHL connectors in parallel (keyword-gated)
  const nonGHLChunks = await fetchNonGHLData(message, dc)
  const nonGHLContext = nonGHLChunks.join('\n\n---\n\n')

  const systemPrompt = buildSystemPrompt(dc, nonGHLContext)

  // Build initial messages
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10) as OpenAI.Chat.ChatCompletionMessageParam[],
    { role: 'user', content: message },
  ]

  // Track which sources we actually hit
  const sourcesHit = new Set<string>()
  if (nonGHLContext.includes('GA4'))         sourcesHit.add('GA4')
  if (nonGHLContext.includes('GSC'))         sourcesHit.add('GSC')
  if (nonGHLContext.includes('INITIATIVES')) sourcesHit.add('INITIATIVES')

  // ── OpenAI tool-calling loop (max 3 rounds) ──────────────────────────
  //
  // We use non-streaming for rounds that have tool calls, then switch to
  // streaming for the final answer.

  let roundMessages = [...messages]

  for (let round = 0; round < 3; round++) {
    const isLastRound = round === 2

    // Non-streaming call so we can inspect tool calls before committing to streaming
    let response: OpenAI.Chat.ChatCompletion
    try {
      response = await openai.chat.completions.create({
        model:                 process.env.OPENAI_MODEL || 'gpt-4o',
        messages:              roundMessages,
        tools:                 GHL_OPENAI_TOOLS,
        tool_choice:           isLastRound ? 'none' : 'auto',
        max_completion_tokens: 1500,
      })
    } catch (e: unknown) {
      console.error('OpenAI error in tool loop:', (e as Error).message)
      break
    }

    const msg          = response.choices[0].message
    const hasToolCalls = !!msg.tool_calls?.length && response.choices[0].finish_reason === 'tool_calls'

    // No tool calls → don't add this message to roundMessages; streaming will re-generate
    // with all accumulated tool results already in context.
    if (!hasToolCalls) break

    // Has tool calls → add assistant turn + execute tools in parallel
    roundMessages.push(msg as OpenAI.Chat.ChatCompletionMessageParam)

    const toolCallResults = await Promise.all(
      msg.tool_calls!.map(async (tc) => {
        const toolName = tc.function.name
        const rawArgs  = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>

        const dispatch = GHL_TOOL_DISPATCH[toolName]
        if (!dispatch) {
          return { role: 'tool' as const, tool_call_id: tc.id, content: `[${toolName}: unknown tool]` }
        }

        const { mcpTool, mcpArgs } = dispatch(rawArgs)
        sourcesHit.add('GHL')

        try {
          const result = await callGHLMcp(mcpTool, mcpArgs)
          return { role: 'tool' as const, tool_call_id: tc.id, content: result || '[no data returned]' }
        } catch (e: unknown) {
          const errMsg = (e as Error).message || String(e)
          console.error(`GHL MCP tool call failed (${mcpTool}):`, errMsg)
          return { role: 'tool' as const, tool_call_id: tc.id, content: `[GHL MCP error: ${errMsg}]` }
        }
      })
    )

    roundMessages.push(...(toolCallResults as OpenAI.Chat.ChatCompletionMessageParam[]))
  }

  // ── Stream the final response ─────────────────────────────────────────

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // Emit source badges first
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: 'sources', sources: Array.from(sourcesHit) })}\n\n`
      ))

      try {
        // Final streaming call — tools disabled so we always get prose
        const streamCompletion = await openai.chat.completions.create({
          model:                 process.env.OPENAI_MODEL || 'gpt-4o',
          messages:              roundMessages,
          stream:                true,
          max_completion_tokens: 900,
        })

        for await (const chunk of streamCompletion) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'delta', content: delta })}\n\n`
            ))
          }
        }
      } catch (e: unknown) {
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'error', error: (e as Error).message })}\n\n`
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
