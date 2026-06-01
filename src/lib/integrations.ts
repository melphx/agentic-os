// ── Integration Executor ───────────────────────────────────────────────────
// Handles all external integration calls: webhooks, GHL, N8N, Google, browser

export async function executeIntegration(
  type: string,
  config: Record<string, any>,
  payload: Record<string, any>
): Promise<string> {
  switch (type) {

    // ── Generic webhook / N8N ─────────────────────────────────────────────
    case 'webhook':
    case 'n8n': {
      const url = config.url
      if (!url) throw new Error('No URL configured for this integration')
      const method = (config.method || 'POST').toUpperCase()
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      }
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

      // Merge config body template with runtime payload
      let body: Record<string, any> = { ...payload }
      if (config.bodyTemplate) {
        try {
          const tpl = typeof config.bodyTemplate === 'string'
            ? JSON.parse(config.bodyTemplate) : config.bodyTemplate
          body = { ...tpl, ...payload }
        } catch {}
      }

      const res = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      try { return JSON.stringify(JSON.parse(text), null, 2).slice(0, 4000) } catch { return text.slice(0, 4000) }
    }

    // ── GoHighLevel — read data ───────────────────────────────────────────
    case 'ghl_read': {
      const { apiKey, locationId, resource = 'contacts', limit = 20 } = config
      if (!apiKey) throw new Error('GHL API key not configured')

      const endpoints: Record<string, string> = {
        contacts:      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&limit=${limit}`,
        opportunities: `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&limit=${limit}`,
        pipelines:     `https://services.leadconnectorhq.com/opportunities/pipelines/?locationId=${locationId}`,
        conversations: `https://services.leadconnectorhq.com/conversations/?locationId=${locationId}&limit=${limit}`,
        calendars:     `https://services.leadconnectorhq.com/calendars/?locationId=${locationId}`,
      }
      const url = endpoints[resource]
      if (!url) throw new Error(`Unknown GHL resource: ${resource}`)

      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) {
        const err = await res.text()
        throw new Error(`GHL API error ${res.status}: ${err.slice(0, 200)}`)
      }
      const data = await res.json()
      return JSON.stringify(data, null, 2).slice(0, 6000)
    }

    // ── GoHighLevel — write data ──────────────────────────────────────────
    case 'ghl_write': {
      const { apiKey, locationId, action = 'create_contact' } = config
      if (!apiKey) throw new Error('GHL API key not configured')

      const ghlHeaders = {
        'Authorization': `Bearer ${apiKey}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
      }

      if (action === 'create_contact') {
        const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
          method: 'POST',
          headers: ghlHeaders,
          body: JSON.stringify({ locationId, ...payload }),
          signal: AbortSignal.timeout(15000),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(`GHL error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Contact created: ${JSON.stringify(data, null, 2).slice(0, 2000)}`
      }

      if (action === 'add_note') {
        const { contactId, body: noteBody } = payload
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
          method: 'POST',
          headers: ghlHeaders,
          body: JSON.stringify({ body: noteBody, userId: config.userId }),
          signal: AbortSignal.timeout(15000),
        })
        const data = await res.json()
        return `Note added: ${JSON.stringify(data).slice(0, 500)}`
      }

      if (action === 'create_opportunity') {
        const res = await fetch('https://services.leadconnectorhq.com/opportunities/', {
          method: 'POST',
          headers: ghlHeaders,
          body: JSON.stringify({ locationId, ...payload }),
          signal: AbortSignal.timeout(15000),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(`GHL error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Opportunity created: ${JSON.stringify(data, null, 2).slice(0, 2000)}`
      }

      throw new Error(`Unknown GHL write action: ${action}`)
    }

    // ── Google Sheets ─────────────────────────────────────────────────────
    case 'google_sheets': {
      const { spreadsheetId, serviceAccountJson, range = 'Sheet1!A1:Z100', action = 'read' } = config
      if (!spreadsheetId) throw new Error('Spreadsheet ID not configured')
      if (!serviceAccountJson) throw new Error('Google service account not configured')

      let sa: any
      try { sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson }
      catch { throw new Error('Invalid service account JSON') }

      // Get access token via JWT
      const token = await getGoogleToken(sa, 'https://www.googleapis.com/auth/spreadsheets')

      if (action === 'read') {
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
        )
        const data = await res.json()
        if (!res.ok) throw new Error(`Sheets API error: ${JSON.stringify(data).slice(0, 200)}`)
        const rows = data.values || []
        return `Spreadsheet data (${rows.length} rows):\n${rows.map((r: string[]) => r.join('\t')).join('\n').slice(0, 6000)}`
      }

      if (action === 'write') {
        const values = payload.values || [[]]
        const res = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
            signal: AbortSignal.timeout(15000),
          }
        )
        const data = await res.json()
        if (!res.ok) throw new Error(`Sheets write error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Written ${data.updatedCells} cells to ${range}`
      }

      throw new Error(`Unknown sheets action: ${action}`)
    }

    // ── Google Docs ───────────────────────────────────────────────────────
    case 'google_docs': {
      const { documentId, serviceAccountJson, action = 'read' } = config
      if (!documentId) throw new Error('Document ID not configured')
      if (!serviceAccountJson) throw new Error('Google service account not configured')

      let sa: any
      try { sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson }
      catch { throw new Error('Invalid service account JSON') }

      const token = await getGoogleToken(sa, 'https://www.googleapis.com/auth/documents')

      if (action === 'read') {
        const res = await fetch(
          `https://docs.googleapis.com/v1/documents/${documentId}`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
        )
        const doc = await res.json()
        if (!res.ok) throw new Error(`Docs API error: ${JSON.stringify(doc).slice(0, 200)}`)
        // Extract plain text from doc body
        const text = extractDocsText(doc)
        return `Document "${doc.title}":\n${text.slice(0, 6000)}`
      }

      if (action === 'append') {
        const content = payload.content || ''
        const res = await fetch(
          `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              requests: [{ insertText: { location: { index: 1 }, text: content } }]
            }),
            signal: AbortSignal.timeout(15000),
          }
        )
        const data = await res.json()
        if (!res.ok) throw new Error(`Docs append error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Appended ${content.length} chars to document`
      }

      throw new Error(`Unknown docs action: ${action}`)
    }

    default:
      throw new Error(`Unknown integration type: ${type}`)
  }
}

// ── Google JWT helper ──────────────────────────────────────────────────────

async function getGoogleToken(serviceAccount: any, scope: string): Promise<string> {
  const { createSign } = await import('crypto')
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim  = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).toString('base64url')

  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${claim}`)
  const sig = sign.sign(serviceAccount.private_key, 'base64url')
  const jwt = `${header}.${claim}.${sig}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json()
  if (!data.access_token) throw new Error(`Google auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

// ── Google Docs text extractor ─────────────────────────────────────────────

function extractDocsText(doc: any): string {
  const parts: string[] = []
  for (const el of doc.body?.content || []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements || []) {
        if (pe.textRun?.content) parts.push(pe.textRun.content)
      }
    }
    if (el.table) {
      for (const row of el.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const c of cell.content || []) {
            for (const pe of c.paragraph?.elements || []) {
              if (pe.textRun?.content) parts.push(pe.textRun.content)
            }
          }
        }
      }
    }
  }
  return parts.join('')
}
