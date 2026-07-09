/**
 * ghl-mcp.ts — Lightweight client for the GoHighLevel HTTP Streamable MCP server.
 *
 * GHL MCP endpoint: https://services.leadconnectorhq.com/mcp/
 * Protocol: MCP 2024-11-05 over HTTP Streamable (SSE responses)
 *
 * Handles: initialize handshake, tool calls, SSE response parsing.
 * One session per call (stateless from our perspective).
 */

const GHL_MCP_URL = 'https://services.leadconnectorhq.com/mcp/'

type MCPContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface MCPToolResult {
  content: MCPContent[]
  isError?: boolean
}

// ── Raw JSON-RPC request to GHL MCP ──────────────────────────────────────

async function mcpPost(
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
  expectResponse = true,
): Promise<{ result: unknown; sessionId?: string }> {
  const apiKey    = process.env.GHL_API_KEY    || ''
  const locationId = process.env.GHL_LOCATION_ID || ''

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept':       'application/json, text/event-stream',
    'Authorization': `Bearer ${apiKey}`,
    'locationId':   locationId,
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  // Notifications have no id field; regular requests do
  const body = expectResponse
    ? JSON.stringify({ jsonrpc: '2.0', id: String(Date.now()), method, params })
    : JSON.stringify({ jsonrpc: '2.0', method, params })

  const controller = new AbortController()
  const timeout    = setTimeout(() => controller.abort(), 28000)

  let res: Response
  try {
    res = await fetch(GHL_MCP_URL, { method: 'POST', headers, body, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }

  const newSid = res.headers.get('Mcp-Session-Id') ?? sessionId

  if (!expectResponse || res.status === 204) {
    return { result: null, sessionId: newSid ?? undefined }
  }

  const text = await res.text()
  const ct   = res.headers.get('Content-Type') ?? ''

  type MCPFrame = { result?: unknown; error?: { message?: string } }
  let parsed: MCPFrame | null = null

  if (ct.includes('text/event-stream')) {
    // Extract data: lines from SSE stream
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ')) {
        const raw = line.slice(6).trim()
        if (!raw || raw === '[DONE]') continue
        try {
          const frame = JSON.parse(raw) as MCPFrame
          if (frame && (frame.result !== undefined || frame.error)) { parsed = frame; break }
        } catch { /* skip non-JSON lines */ }
      }
    }
  } else {
    try { parsed = JSON.parse(text) as MCPFrame } catch { /* ignore */ }
  }

  if (!parsed) throw new Error(`GHL MCP: empty response for ${method}`)
  if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error))

  return { result: parsed.result, sessionId: newSid ?? undefined }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Initialize a session with GHL MCP and return the session ID.
 * Must be called before tool calls on the same session.
 */
export async function ghlMcpInit(): Promise<string | undefined> {
  const { sessionId } = await mcpPost('initialize', {
    protocolVersion: '2024-11-05',
    capabilities:    { tools: {} },
    clientInfo:      { name: 'phr-os', version: '1.0.0' },
  })
  // Fire-and-forget initialized notification
  mcpPost('notifications/initialized', {}, sessionId, false).catch(() => {})
  return sessionId
}

/**
 * Call a GHL MCP tool and return the text content.
 * Automatically handles session initialization.
 */
export async function callGHLMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const locationId = process.env.GHL_LOCATION_ID || ''

  // Initialize session
  let sessionId: string | undefined
  try {
    sessionId = await ghlMcpInit()
  } catch (e: unknown) {
    throw new Error(`GHL MCP init failed: ${(e as Error).message}`)
  }

  // Execute tool call — always inject locationId
  const { result } = await mcpPost(
    'tools/call',
    { name: toolName, arguments: { locationId, ...args } },
    sessionId,
  )

  const toolResult = result as MCPToolResult
  if (!toolResult?.content) return '[no content returned]'

  const text = toolResult.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n')

  return text.slice(0, 4000) // cap per tool call
}

/**
 * Fetch tool definitions from GHL MCP for use as OpenAI tool schemas.
 * Returns a filtered subset relevant for MCD chat.
 */
export async function getGHLToolSchemas(): Promise<Array<{
  name: string
  description: string
  inputSchema: Record<string, unknown>
}>> {
  const sessionId = await ghlMcpInit()
  const { result } = await mcpPost('tools/list', {}, sessionId)
  const tools = (result as { tools?: typeof result[] } | null)?.tools ?? []
  return (tools as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>)
    .filter(t => GHL_MCD_TOOLS.has(t.name))
}

// The GHL tools most relevant for MCD questions
export const GHL_MCD_TOOLS = new Set([
  'contacts_get-contacts',            // leads / all contacts
  'calendars_get-calendar-events',    // Discovery Calls, in-home appointments
  'opportunities_get-pipelines',      // funnel stage counts (current snapshot)
  'opportunities_search-opportunity', // opportunities with date / status filter
  'conversations_search-conversation',// call/message activity
])
