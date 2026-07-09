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
        'Fetch GHL contacts (leads). Supports server-side date range and tag filtering. ' +
        'For lead count questions ALWAYS pass startDate/endDate (epoch ms from system prompt) and tags=["prospect tags - new lead - all leads from everywhere - qualified and unqualified"]. ' +
        'Use for: how many leads, new contacts, lead count, source breakdown.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max contacts to return (default 100, max 100).',
          },
          query: {
            type: 'string',
            description: 'Optional: search by name, email, or phone.',
          },
          startDate: {
            type: 'number',
            description: 'Filter contacts added on or after this epoch ms. Use mondayEpoch for this week, lastMondayEpoch for last week.',
          },
          endDate: {
            type: 'number',
            description: 'Filter contacts added on or before this epoch ms. Use todayEpoch for current end, lastSundayEpoch for last week end.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter by tags. For PHR leads use: ["prospect tags - new lead - all leads from everywhere - qualified and unqualified"]',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_get_location',
      description:
        'Get GHL location/sub-account details including the list of users (team members) and their IDs. ' +
        'Call this first when you need a userId to pass to ghl_get_calendar_events. ' +
        'Also useful for: location name, timezone, address, team member list.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_get_calendar_events',
      description:
        'Fetch GHL calendar events. Use groupId from the system prompt — do NOT call ghl_get_location first. ' +
        'Discovery Calls groupId = "Lw5fSwnOXd0Kn814J1De". In-Home groupId = "B0UmNJYhaUFH6JgOSHvw". ' +
        'Use startTime/endTime epoch ms from the system prompt date context.',
      parameters: {
        type: 'object',
        properties: {
          startTime: {
            type: 'number',
            description: 'Start epoch ms — use mondayEpoch or lastMondayEpoch from system prompt.',
          },
          endTime: {
            type: 'number',
            description: 'End epoch ms — use todayEpoch or lastSundayEpoch from system prompt.',
          },
          groupId: {
            type: 'string',
            description: 'Use "Lw5fSwnOXd0Kn814J1De" for Discovery Calls, "B0UmNJYhaUFH6JgOSHvw" for In-Home appointments.',
          },
          calendarId: {
            type: 'string',
            description: 'Specific calendar ID — only use if filtering to one calendar source.',
          },
          userId: {
            type: 'string',
            description: 'Specific user ID — only use if filtering to one team member.',
          },
        },
        required: ['startTime', 'endTime', 'groupId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ghl_list_transactions',
      description:
        'List GHL payment transactions. Use for: revenue, payments received, transaction history. ' +
        'Supports filtering and pagination.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Number of results (default 20).' },
          offset: { type: 'number', description: 'Pagination offset.' },
        },
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
    mcpArgs: Object.fromEntries(Object.entries({
      limit: a.limit ?? 100,
      query: a.query,
      startDate: a.startDate,
      endDate: a.endDate,
      tags: a.tags,
    }).filter(([, v]) => v !== undefined)),
  }),
  ghl_get_location: (_) => ({
    mcpTool: 'locations_get-location',
    mcpArgs: {},
  }),
  ghl_get_calendar_events: (a) => ({
    mcpTool: 'calendars_get-calendar-events',
    mcpArgs: Object.fromEntries(
      Object.entries({ startTime: a.startTime, endTime: a.endTime, userId: a.userId, calendarId: a.calendarId, groupId: a.groupId })
        .filter(([, v]) => v !== undefined)
    ),
  }),
  ghl_list_transactions: (a) => ({
    mcpTool: 'payments_list-transactions',
    mcpArgs: Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)),
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

════════════════════════════════════════
GHL SETUP — PHOENIX HOME REMODELING
════════════════════════════════════════

COMPANY: Phoenix Home Remodeling — remodeling contractor, Phoenix AZ.

FULL SALES FUNNEL:
Qualified Lead → Discovery Call booked → Discovery Call completed (1cc) → In-Home Evaluation scheduled → In-Home completed → Proposal sent → Design & Planning Agreement signed → Construction Agreement signed → Construction complete

CRITICAL TERMINOLOGY (GHL uses different names internally):
- "Discovery Call" = called "Phone Consultation" inside GHL. When you see "phone consultation" in data, that IS the Discovery Call.
- "1cc" = First Call Consultation = what happens during/after a Discovery Call
- "DIW" = Design Initial Walkthrough = site visit by designer
- "In-Home" = In-Home Evaluation = sales appointment at the client's home

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LEAD FILTER (use this EXACTLY for all lead count questions):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Tag: "prospect tags - new lead - all leads from everywhere - qualified and unqualified"
Contact type NONE OF: Vendor, Bogus Lead, Job applicant, solicitor

When calling ghl_get_contacts for lead counts, ALWAYS pass:
  startDate = mondayEpoch (this week) or lastMondayEpoch (last week)
  endDate = todayEpoch (this week) or lastSundayEpoch (last week)
  tags = ["prospect tags - new lead - all leads from everywhere - qualified and unqualified"]
  limit = 100
Then exclude contacts whose type is Vendor, Bogus Lead, Job applicant, or solicitor.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CALENDAR GROUPS (use groupId for calendar event queries):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Discovery Calls groupId: Lw5fSwnOXd0Kn814J1De
  — covers all 20+ Discovery Call calendars (inbound, outbound, PPC, LSA, website, chatbot, AI, etc.)
  — ALWAYS use this groupId when asked about Discovery Calls booked or completed

In-Home Evaluations groupId: B0UmNJYhaUFH6JgOSHvw
  — covers all In-Home calendars (from Justin, from email, from texting, 2hr, manual, etc.)
  — ALWAYS use this groupId when asked about In-Home appointments

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PIPELINES (12 total — key ones for MCD):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#01 Inbound Caller Disposition (id: JvgkifSKMnS7tzI65pqK)
  Tracks: what happened with each inbound call. Key stages:
  - "New Lead - from AI Remodel Coach Bot" — bot-originated lead
  - "Scheduled phone consultation from Inbound" — booked a Discovery Call
  - "Didn't schedule phone consultation" — didn't book
  - "Solicitation" — solicitor, not a real lead

#02 New Leads & Outbound Campaign (id: V2dwMtKIiCz6f7saVAhS)
  Tracks: outbound calling sequence for new leads. Key stages:
  - "New Lead" → "Call 1" through "Call 6 (Day 9)" — follow-up cadence
  - "Phone consultation Scheduled from Outbound AI Call" — Discovery Call booked via outbound
  - "Not Interested" / "Not interested right now but ok to Nurture"
  - "Lead Unresponsive - Never got a hold of lead"

#03 Phone Consultation Scheduled to 1CC Outcomes (id: Pa6iq2YQCwBlUCmUwBQ9) ← KEY PIPELINE
  Tracks: every Discovery Call and its outcome. KEY STAGES:
  - "*Phone Consultation Scheduled" — Discovery Call BOOKED ✓
  - "*Phone Consultation No Show" — no-show
  - "*Phone Consultation Cancelled" — cancelled
  - "* 1cc - Too Expensive" — completed but price objection
  - "* 1cc - Referred to Travek - Out of scope/area" — not a fit, referred out
  - "* 1cc - Lead Not Sure About DB" — completed, lead undecided
  - "*1cc - Can't Wait to Start Their Project" — hot lead
  - "*1cc - Need to Schedule In-Home" — Discovery Call completed, In-Home needed ✓
  - "1cc - Project Under $15k" — below minimum project size
  - "1cc - Sent to Jeremy" — escalated to owner
  - "Prospect no longer interested after phone consultation" — lost post-call

#04 In-Home Scheduled to Design Agreement Signed (id: TVvpPHfZ23RIjYkVBvPd)
  Tracks: in-home visit through proposal. KEY STAGES:
  - "*In-Home Evaluation Scheduled" — In-Home BOOKED ✓
  - "*In-home Cancelled" / "In-Home Missed"
  - "Sent SOW To Estimators For Pricing"
  - "Check Pricing & Make Proposal"
  - "*Proposal Reviewed and Sent, Need to Follow Up"
  - "Hot - Close to Moving Forward"
  - "Design & Planning Agreement Signed" — WON (design phase) ✓

#05 Planning & Design Phase (id: R89SFM9SElTlPFM9I4v4)
  Tracks: active design clients through design completion.
  Key: DIW = Design Initial Walkthrough (designer site visit)

#06 Design Complete to Signed Construction Agreement (id: jMw6TNIqczubSuR4tZLC)
  Tracks: design-complete clients through construction agreement signing.
  - "Construction Agreement Signed" — fully committed client ✓

#07 New Construction Client to Project Complete (id: 8qxLSNDiFrRAYeVzZILu)
  Tracks: active construction projects.
  - "Construction in Progress" / "Construction Project Complete"

#08 Nurture and Lost Opp Stages (id: 8QNPRh5CialN3HH8JKEr)
  Tracks: lost and long-term nurture contacts. Loss reasons:
  - "Lost - Bogus Lead Info" / "Lost - New lead - No Contact" / "Lost - New Lead - Not a Fit"
  - "Lost - Proposal Too High" / "Lost - Competitor (not cost)"
  - "Lost - During Design Phase" / "Lost - After Design Phase"
  - "Nurture" / "Long Term Nurture"

#09 Referred to Another Company (id: 63BKeQ4A4JWjOftpQTiT)
  Partner companies: Travek & Hoffman, RM Flooring, 1st Class Finishing, ITSA Contracting, Homework Remodels

#11 Realtors & Brokers (id: RxsnkHiQ4RGZZ0pf1cWI)
  Tracks realtor partnership outreach and referral relationships.

#12 Interior Designers For Referrals (id: AeecRgr8SNTujCVby9Ks)
  Tracks designer partnership calls and qualified/interested designers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KEY METRICS DEFINITIONS:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Qualified leads = contacts with the prospect tag (not Vendor/Bogus/Job applicant/solicitor)
- Discovery Calls booked = calendar events in Discovery Call group (Lw5fSwnOXd0Kn814J1De) OR stage "*Phone Consultation Scheduled" in Pipeline #03
- Discovery Call show rate = completed calls / booked calls (Pipeline #03 non-cancelled, non-no-show outcomes vs total booked)
- In-Home booked = calendar events in In-Home group (B0UmNJYhaUFH6JgOSHvw) OR stage "*In-Home Evaluation Scheduled" in Pipeline #04
- Conversion rate = leads → Discovery Calls booked
- Won = "Design & Planning Agreement Signed" (Pipeline #04) or "Construction Agreement Signed" (Pipeline #06)
- Minimum project size = $15k (leads under this are not a fit)`

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
        model:                 process.env.OPENAI_MODEL || 'gpt-5.4-mini',
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
          model:                 process.env.OPENAI_MODEL || 'gpt-5.4-mini',
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
