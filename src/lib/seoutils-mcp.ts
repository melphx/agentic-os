/**
 * seoutils-mcp.ts — HTTP MCP client for the SEO Utils server.
 *
 * Endpoint: http://<SEOUTILS_MCP_URL>  (env var — no trailing slash)
 * Auth:     Bearer token               (env var SEOUTILS_MCP_TOKEN)
 * Protocol: MCP 2024-11-05 over HTTP Streamable (JSON or SSE responses)
 *
 * IMPORTANT — Host header:
 *   SEO Utils validates the Host header and only accepts "localhost:<port>".
 *   When MCD accesses it via the external IP (198.37.105.107:19515), the
 *   server returns 403 Forbidden unless we spoof the Host header.
 *   We use Node.js `http.request()` directly (NOT global fetch) because
 *   Node's Undici fetch forbids overriding the Host header, while http.request
 *   passes any headers as-is.
 */

import http  from 'http'
import https from 'https'

const DEFAULT_URL   = 'http://198.37.105.107:19515/mcp'
const HOST_OVERRIDE = 'localhost:19515'

// ── Raw HTTP helper ──────────────────────────────────────────────────────────

interface RawResponse {
  status:  number
  headers: Record<string, string | string[] | undefined>
  text:    string
}

function rawPost(
  urlStr: string,
  headers: Record<string, string | number>,
  body: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = new URL(urlStr) } catch (e) { return reject(e) }

    const isHttps = u.protocol === 'https:'
    const agent   = isHttps ? https : http

    const options: http.RequestOptions = {
      hostname: u.hostname,
      port:     u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers,
    }

    const req = (agent as typeof http).request(options, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status:  res.statusCode ?? 0,
          headers: res.headers as Record<string, string | string[] | undefined>,
          text:    Buffer.concat(chunks).toString('utf8'),
        })
      )
      res.on('error', reject)
    })

    req.on('error', reject)
    req.setTimeout(28_000, () => {
      req.destroy(new Error('SEO Utils MCP: request timed out after 28 s'))
    })

    req.write(body)
    req.end()
  })
}

// ── MCP JSON-RPC layer ───────────────────────────────────────────────────────

type MCPFrame = { result?: unknown; error?: { message?: string; code?: number } }

async function seoMcpPost(
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<{ result: unknown; sessionId: string | undefined }> {
  const url   = (process.env.SEOUTILS_MCP_URL   || DEFAULT_URL).trim()
  const token = (process.env.SEOUTILS_MCP_TOKEN  || '').trim()

  const bodyStr = JSON.stringify({
    jsonrpc: '2.0',
    id:      String(Date.now()),
    method,
    params,
  })

  const headers: Record<string, string | number> = {
    'Content-Type':   'application/json',
    'Accept':         'application/json, text/event-stream',
    'Authorization':  `Bearer ${token}`,
    'Host':           HOST_OVERRIDE,          // must be localhost:19515
    'Content-Length': Buffer.byteLength(bodyStr),
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId

  let raw: RawResponse
  try {
    raw = await rawPost(url, headers, bodyStr)
  } catch (e: unknown) {
    throw new Error(`SEO Utils MCP network error (${method}): ${(e as Error).message}`)
  }

  if (raw.status === 204) {
    const newSid = raw.headers['mcp-session-id'] as string | undefined
    return { result: null, sessionId: newSid ?? sessionId }
  }

  const ct     = (raw.headers['content-type'] as string) ?? ''
  const newSid = (raw.headers['mcp-session-id'] as string | undefined) ?? sessionId

  let parsed: MCPFrame | null = null

  if (ct.includes('text/event-stream')) {
    for (const line of raw.text.split('\n')) {
      if (!line.startsWith('data: ')) continue
      const chunk = line.slice(6).trim()
      if (!chunk || chunk === '[DONE]') continue
      try {
        const frame = JSON.parse(chunk) as MCPFrame
        if (frame && (frame.result !== undefined || frame.error)) {
          parsed = frame
          break
        }
      } catch { /* skip malformed SSE data lines */ }
    }
  } else {
    try { parsed = JSON.parse(raw.text) as MCPFrame } catch { /* ignore */ }
  }

  if (!parsed) {
    throw new Error(
      `SEO Utils MCP: unparseable response for ${method} (HTTP ${raw.status}). ` +
      `Body: ${raw.text.slice(0, 200)}`
    )
  }
  if (parsed.error) {
    const msg = parsed.error.message ?? JSON.stringify(parsed.error)
    throw new Error(`SEO Utils MCP error (${method}): ${msg}`)
  }

  return { result: parsed.result, sessionId: newSid }
}

// ── Session management ───────────────────────────────────────────────────────

async function seoUtilsInit(): Promise<string | undefined> {
  const { sessionId } = await seoMcpPost('initialize', {
    protocolVersion: '2024-11-05',
    capabilities:    { tools: {} },
    clientInfo:      { name: 'phr-mcd', version: '1.0.0' },
  })
  // Fire-and-forget — no response expected
  seoMcpPost('notifications/initialized', {}, sessionId).catch(() => {})
  return sessionId
}

// ── Public API ───────────────────────────────────────────────────────────────

type MCPContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

interface SEOToolResult {
  content:  MCPContent[]
  isError?: boolean
}

/**
 * Call a SEO Utils MCP tool by its exact server-side name.
 * Returns the combined text content, capped at 6 000 chars.
 */
export async function callSEOUtilsMcp(
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  let sessionId: string | undefined
  try {
    sessionId = await seoUtilsInit()
  } catch (e: unknown) {
    throw new Error(`SEO Utils init failed: ${(e as Error).message}`)
  }

  const { result } = await seoMcpPost(
    'tools/call',
    { name: toolName, arguments: args },
    sessionId,
  )

  const toolResult = result as SEOToolResult | undefined
  if (!toolResult?.content?.length) return '[SEO Utils: no content returned]'

  const text = toolResult.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join('\n')

  const MAX = 6_000
  return text.length > MAX ? text.slice(0, MAX) + '\n...[truncated]' : text
}
