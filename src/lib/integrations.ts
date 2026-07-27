// ── Integration Executor ───────────────────────────────────────────────────
// Handles all external integration calls: webhooks, GHL, N8N, Google, Obsidian, browser

// ── Google helpers (defined first so they're available to the switch cases) ─

async function getGoogleToken(serviceAccount: Record<string, string>, scope: string): Promise<string> {
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
  const privateKey = (serviceAccount.private_key || '').replace(/\\n/g, '\n')
  if (!privateKey) throw new Error('No private_key in service account')
  const sign = createSign('RSA-SHA256')
  sign.update(`${header}.${claim}`)
  const sig = sign.sign(privateKey, 'base64url')
  const jwt = `${header}.${claim}.${sig}`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json() as Record<string, string>
  if (!data.access_token) throw new Error(`Google auth failed: ${JSON.stringify(data)}`)
  return data.access_token
}

function extractDocsText(doc: Record<string, any>): string {
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

// ── Main executor ──────────────────────────────────────────────────────────

export async function executeIntegration(
  type: string,
  config: Record<string, any>,
  payload: Record<string, any>
): Promise<string> {

  switch (type) {

    // ── Webhook / N8N ─────────────────────────────────────────────────────
    case 'webhook':
    case 'n8n': {
      const url: string = config.url
      if (!url) throw new Error('No URL configured')
      const method = (config.method || 'POST').toUpperCase()
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(config.headers || {}) }
      if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`
      let body: Record<string, any> = { ...payload }
      if (config.bodyTemplate) {
        try { body = { ...(typeof config.bodyTemplate === 'string' ? JSON.parse(config.bodyTemplate) : config.bodyTemplate), ...payload } } catch {}
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

    // ── GHL Read ──────────────────────────────────────────────────────────
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
      const url = endpoints[resource as string]
      if (!url) throw new Error(`Unknown GHL resource: ${resource}`)
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`GHL API error ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return JSON.stringify(await res.json(), null, 2).slice(0, 6000)
    }

    // ── GHL Write ─────────────────────────────────────────────────────────
    case 'ghl_write': {
      const { apiKey, locationId, action = 'create_contact' } = config
      if (!apiKey) throw new Error('GHL API key not configured')
      const ghlHeaders = { 'Authorization': `Bearer ${apiKey}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' }
      if (action === 'create_contact') {
        const res = await fetch('https://services.leadconnectorhq.com/contacts/', { method: 'POST', headers: ghlHeaders, body: JSON.stringify({ locationId, ...payload }), signal: AbortSignal.timeout(15000) })
        const data = await res.json()
        if (!res.ok) throw new Error(`GHL error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Contact created: ${JSON.stringify(data, null, 2).slice(0, 2000)}`
      }
      if (action === 'add_note') {
        const res = await fetch(`https://services.leadconnectorhq.com/contacts/${payload.contactId}/notes`, { method: 'POST', headers: ghlHeaders, body: JSON.stringify({ body: payload.body, userId: config.userId }), signal: AbortSignal.timeout(15000) })
        return `Note added: ${JSON.stringify(await res.json()).slice(0, 500)}`
      }
      if (action === 'create_opportunity') {
        const res = await fetch('https://services.leadconnectorhq.com/opportunities/', { method: 'POST', headers: ghlHeaders, body: JSON.stringify({ locationId, ...payload }), signal: AbortSignal.timeout(15000) })
        const data = await res.json()
        if (!res.ok) throw new Error(`GHL error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Opportunity created: ${JSON.stringify(data, null, 2).slice(0, 2000)}`
      }
      throw new Error(`Unknown GHL action: ${action}`)
    }

    // ── Google Sheets ─────────────────────────────────────────────────────
    case 'google_sheets': {
      const { spreadsheetId, serviceAccountJson, range = 'Sheet1!A1:Z100', action = 'read' } = config
      if (!spreadsheetId) throw new Error('Spreadsheet ID not configured')
      if (!serviceAccountJson) throw new Error('Service account not configured')
      const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson
      const token = await getGoogleToken(sa, 'https://www.googleapis.com/auth/spreadsheets')
      if (action === 'read') {
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
        const data = await res.json() as Record<string, any>
        if (!res.ok) throw new Error(`Sheets error: ${JSON.stringify(data).slice(0, 200)}`)
        const rows: string[][] = data.values || []
        return `Spreadsheet data (${rows.length} rows):\n${rows.map((r: string[]) => r.join('\t')).join('\n').slice(0, 6000)}`
      }
      if (action === 'write') {
        const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ range, majorDimension: 'ROWS', values: payload.values || [[]] }), signal: AbortSignal.timeout(15000) })
        const data = await res.json() as Record<string, any>
        if (!res.ok) throw new Error(`Sheets write error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Written ${data.updatedCells} cells to ${range}`
      }
      throw new Error(`Unknown sheets action: ${action}`)
    }

    // ── Google Docs ───────────────────────────────────────────────────────
    case 'google_docs': {
      const { documentId, serviceAccountJson, action = 'read' } = config
      if (!documentId) throw new Error('Document ID not configured')
      if (!serviceAccountJson) throw new Error('Service account not configured')
      const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson
      const token = await getGoogleToken(sa, 'https://www.googleapis.com/auth/documents')
      if (action === 'read') {
        const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) })
        const doc = await res.json() as Record<string, any>
        if (!res.ok) throw new Error(`Docs error: ${JSON.stringify(doc).slice(0, 200)}`)
        return `Document "${doc.title}":\n${extractDocsText(doc).slice(0, 6000)}`
      }
      if (action === 'append') {
        const res = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: payload.content || '' } }] }), signal: AbortSignal.timeout(15000) })
        const data = await res.json() as Record<string, any>
        if (!res.ok) throw new Error(`Docs append error: ${JSON.stringify(data).slice(0, 200)}`)
        return `Appended to document`
      }
      throw new Error(`Unknown docs action: ${action}`)
    }

    // ── Obsidian ──────────────────────────────────────────────────────────
    case 'obsidian': {
      const { apiUrl, apiKey, vaultPath, action = 'search' } = config
      const query: string = payload.query || payload.search || ''
      const notePath: string = payload.path || payload.note || ''
      const noteContent: string = payload.content || ''

      if (apiUrl) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) }
        const base = apiUrl.replace(/\/$/, '')
        if (action === 'search') {
          const res = await fetch(`${base}/search/simple/?query=${encodeURIComponent(query)}&contextLength=200`, { headers, signal: AbortSignal.timeout(10000) })
          if (!res.ok) throw new Error(`Obsidian API ${res.status}`)
          const data = await res.json() as any[]
          return data.slice(0, 10).map((r: any) => `📄 ${r.filename}\n${(r.matches || []).map((m: any) => m.context).join(' … ')}`).join('\n\n') || 'No results'
        }
        if (action === 'read') {
          const res = await fetch(`${base}/vault/${encodeURIComponent(notePath)}`, { headers, signal: AbortSignal.timeout(10000) })
          if (!res.ok) throw new Error(`Note not found: ${notePath}`)
          return await res.text()
        }
        if (action === 'write' || action === 'create') {
          await fetch(`${base}/vault/${encodeURIComponent(notePath)}`, { method: 'PUT', headers, body: noteContent, signal: AbortSignal.timeout(10000) })
          return `✓ Note saved: ${notePath}`
        }
        if (action === 'append') {
          await fetch(`${base}/vault/${encodeURIComponent(notePath)}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/markdown' }, body: `\n\n${noteContent}`, signal: AbortSignal.timeout(10000) })
          return `✓ Appended to: ${notePath}`
        }
        if (action === 'list') {
          const res = await fetch(`${base}/vault/`, { headers, signal: AbortSignal.timeout(10000) })
          const data = await res.json() as Record<string, any>
          const files = (data.files as string[] || []).filter((f: string) => f.endsWith('.md')).slice(0, 50)
          return `Vault files (${files.length}):\n${files.join('\n')}`
        }
      }

      if (vaultPath) {
        const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('fs')
        const { join, dirname } = await import('path')
        const { execSync } = await import('child_process')
        const vault: string = (vaultPath as string).replace(/\/$/, '')
        if (action === 'search') {
          try {
            const out = execSync(`grep -rl "${query.replace(/"/g, '\\"')}" "${vault}" --include="*.md" 2>/dev/null | head -20`).toString()
            const files = out.trim().split('\n').filter(Boolean)
            if (!files.length) return `No notes found for: ${query}`
            return files.map((f: string) => `📄 ${f.replace(vault + '/', '')}\n${readFileSync(f, 'utf8').slice(0, 300)}…`).join('\n\n')
          } catch { return 'Search failed' }
        }
        if (action === 'read') {
          const full = join(vault, notePath.endsWith('.md') ? notePath : notePath + '.md')
          if (!existsSync(full)) throw new Error(`Note not found: ${notePath}`)
          return readFileSync(full, 'utf8')
        }
        if (action === 'write' || action === 'create') {
          const full = join(vault, notePath.endsWith('.md') ? notePath : notePath + '.md')
          mkdirSync(dirname(full), { recursive: true })
          writeFileSync(full, noteContent)
          return `✓ Note saved: ${notePath}`
        }
        if (action === 'append') {
          const full = join(vault, notePath.endsWith('.md') ? notePath : notePath + '.md')
          const existing = existsSync(full) ? readFileSync(full, 'utf8') : ''
          writeFileSync(full, existing + '\n\n' + noteContent)
          return `✓ Appended to: ${notePath}`
        }
        if (action === 'list') {
          const out = execSync(`find "${vault}" -name "*.md" | head -50`).toString()
          const files = out.trim().split('\n').filter(Boolean).map((f: string) => f.replace(vault + '/', ''))
          return `Vault notes (${files.length}):\n${files.join('\n')}`
        }
      }

      throw new Error('Obsidian requires apiUrl (REST API) or vaultPath (file system)')
    }

    default:
      throw new Error(`Unknown integration type: ${type}`)
  }
}
