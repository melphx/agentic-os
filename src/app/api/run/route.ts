import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb, updateAgent, addLog, recordMetric, createTask, saveMemory, getMemory, getKnowledgeContent } from '@/lib/db'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import OpenAI from 'openai'

const execAsync = promisify(exec)

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
})
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'
const AGENT_FILES_DIR = process.env.AGENT_FILES_DIR || path.join(process.cwd(), 'agent-files')

// Ensure agent files dir exists
if (!existsSync(AGENT_FILES_DIR)) mkdirSync(AGENT_FILES_DIR, { recursive: true })

// ── GPT helper with memory injection ──────────────────────────────────────

// Custom system prompts stored per-agent (set via UI, persisted in DB)
const customPromptCache: Record<string, string> = {}
let promptsLoaded = false

function loadCustomPromptsFromDb() {
  if (promptsLoaded) return
  promptsLoaded = true
  try {
    const db = getDb()
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(agent_id, key)
      )
    `)
    const rows = db.prepare(`SELECT agent_id, value FROM agent_settings WHERE key = 'custom_prompt'`).all() as { agent_id: string; value: string }[]
    for (const row of rows) customPromptCache[row.agent_id] = row.value
  } catch { /* table may not exist yet */ }
}

export function setAgentCustomPrompt(agentId: string, prompt: string) {
  customPromptCache[agentId] = prompt
}

async function ask(agentId: string, systemPrompt: string, userPrompt: string, maxTokens = 2048) {
  loadCustomPromptsFromDb()
  const memory    = getMemory(agentId, 5)
  const knowledge = getKnowledgeContent(agentId)
  // Use custom prompt if set, otherwise use provided systemPrompt
  const baseSystem = customPromptCache[agentId] || systemPrompt
  let fullSystem  = baseSystem
  if (knowledge) fullSystem += `\n\n--- Uploaded Knowledge Base ---\n${knowledge}\n--- End Knowledge Base ---`
  if (memory)    fullSystem += `\n\nYour recent memory:\n${memory}`

  const completion = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: maxTokens,
    messages: [
      { role: 'system', content: fullSystem },
      { role: 'user', content: userPrompt },
    ],
  })
  return {
    content: completion.choices[0].message.content || '',
    tokens: completion.usage?.total_tokens || 0,
  }
}

// ── Vision helper ──────────────────────────────────────────────────────────

async function analyzeScreenshot(base64Image: string, prompt: string) {
  const completion = await client.chat.completions.create({
    model: 'gpt-4o', // vision requires gpt-4o
    max_completion_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
        { type: 'text', text: prompt },
      ],
    }],
  })
  return completion.choices[0].message.content || ''
}

// ── Web search via Tavily ──────────────────────────────────────────────────

async function webSearch(query: string): Promise<string> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return 'No TAVILY_API_KEY set. Add it to .env.local to enable web search.'
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: 5, include_answer: true }),
  })
  const data = await res.json()
  const results = (data.results || []).map((r: any, i: number) =>
    `[${i + 1}] ${r.title}\n${r.url}\n${r.content?.slice(0, 300)}`
  ).join('\n\n')
  return data.answer ? `Answer: ${data.answer}\n\nSources:\n${results}` : results
}

// ── Playwright browser automation ─────────────────────────────────────────

async function browserTask(agentId: string, taskId: number, description: string): Promise<{ result: string; tokens: number }> {
  // Hard 90-second timeout for the entire browser task
  const BROWSER_TIMEOUT = 90_000

  // Dynamically import playwright (optional dep)
  let chromium: any
  try {
    const pw = await import('playwright')
    chromium = pw.chromium
  } catch {
    return { result: 'Playwright not installed. Run: npx playwright install chromium --with-deps', tokens: 0 }
  }

  addLog(taskId, agentId, 'info', 'Launching headless browser…')

  let browser: any
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
  } catch (e: any) {
    return { result: `Failed to launch browser: ${e.message}`, tokens: 0 }
  }

  const page = await browser.newPage()
  await page.setDefaultTimeout(10000)
  await page.setDefaultNavigationTimeout(20000)

  let result = ''
  let tokens = 0

  // Wrap everything in a hard timeout
  const taskPromise = (async () => {
    // Ask GPT to produce a step-by-step browser plan
    const { content: plan, tokens: planTokens } = await ask(
      String(agentId),
      `You are a browser automation agent. Given a task, produce a JSON array of steps.
Each step: { "action": "navigate|extract|screenshot|scroll|click|type|wait", "selector"?: "css", "value"?: "text or url", "description": "what this does" }
For content scraping tasks, use: navigate then extract then (optionally) screenshot.
Respond with ONLY the JSON array, no markdown, no explanation.`,
      description,
      512,
    )
    tokens += planTokens

    let steps: any[] = []
    try { steps = JSON.parse(plan.match(/\[[\s\S]*\]/)?.[0] || '[]') } catch {}

    if (!steps.length) {
      // Fallback: just navigate and extract if no steps parsed
      const urlMatch = description.match(/https?:\/\/[^\s]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
      if (urlMatch) {
        const url = urlMatch[0].startsWith('http') ? urlMatch[0] : `https://${urlMatch[0]}`
        steps = [
          { action: 'navigate', value: url, description: `Open ${url}` },
          { action: 'extract', value: 'all visible text, headings, and key content', description: 'Extract page content' },
        ]
      }
    }

    addLog(taskId, agentId, 'info', `Executing ${steps.length} browser steps`)
    const outputs: string[] = []

    for (const step of steps) {
      try {
        switch (step.action) {
          case 'navigate': {
            const url = step.value?.startsWith('http') ? step.value : `https://${step.value}`
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
            // Wait a moment for JS to settle
            await page.waitForTimeout(1500)
            outputs.push(`Navigated to ${url}`)
            break
          }
          case 'extract': {
            const text = await page.evaluate(() => {
              // Remove nav, footer, scripts for cleaner extraction
              const remove = document.querySelectorAll('nav,footer,script,style,noscript,iframe')
              remove.forEach(el => el.remove())
              return document.body.innerText
            })
            const clean = text.replace(/\s+/g, ' ').trim().slice(0, 5000)
            if (!clean) { outputs.push('Page returned no readable text'); break }
            const { content: summary, tokens: sumTokens } = await ask(
              String(agentId),
              'Extract and summarise the key information from this page. Be thorough and accurate.',
              `Page content:\n${clean}\n\nTask context: ${description}`,
              1024,
            )
            tokens += sumTokens
            outputs.push(`Page content:\n${summary}`)
            break
          }
          case 'screenshot': {
            const buf = await page.screenshot({ type: 'png', fullPage: false })
            const b64 = buf.toString('base64')
            const imgPath = path.join(AGENT_FILES_DIR, `screenshot-${Date.now()}.png`)
            writeFileSync(imgPath, buf)
            const analysis = await analyzeScreenshot(b64, step.value || 'Describe what you see on this page')
            tokens += 300
            outputs.push(`Screenshot analysis: ${analysis}`)
            break
          }
          case 'scroll':
            await page.evaluate(() => window.scrollBy(0, 500))
            outputs.push('Scrolled down')
            break
          case 'wait':
            await page.waitForTimeout(Math.min(parseInt(step.value) || 1000, 3000))
            outputs.push(`Waited`)
            break
          case 'click':
            await page.click(step.selector, { timeout: 5000 })
            outputs.push(`Clicked ${step.selector}`)
            break
          case 'type':
            await page.fill(step.selector, step.value, { timeout: 5000 })
            outputs.push(`Typed into ${step.selector}`)
            break
        }
        addLog(taskId, agentId, 'info', `✓ ${step.description || step.action}`)
      } catch (stepErr: any) {
        addLog(taskId, agentId, 'warn', `Step failed: ${step.description} — ${stepErr.message}`)
        outputs.push(`⚠ ${step.description}: ${stepErr.message}`)
      }
    }

    result = outputs.join('\n\n')
  })()

  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('Browser task timed out after 90 seconds')), BROWSER_TIMEOUT)
  )

  try {
    await Promise.race([taskPromise, timeoutPromise])
  } catch (e: any) {
    result = result || `Browser task failed: ${e.message}`
    addLog(taskId, agentId, 'error', e.message)
  } finally {
    await browser.close().catch(() => {})
  }

  // If we got raw extracted content, use the full ask to produce the final output
  if (result && description.toLowerCase().includes('blog') || description.toLowerCase().includes('write') || description.toLowerCase().includes('post')) {
    try {
      const { content: final, tokens: finalTokens } = await ask(
        String(agentId),
        'You are a content writer. Using the extracted page content below, complete the user\'s writing task. Produce polished, publication-ready content.',
        `Task: ${description}\n\nExtracted content:\n${result}`,
        2048,
      )
      tokens += finalTokens
      result = final
    } catch {}
  }

  return { result: result || 'Browser task completed but returned no content.', tokens }
}

// ── Security scanner ───────────────────────────────────────────────────────

async function securityScan(agentId: string, taskId: number, description: string): Promise<{ result: string; tokens: number }> {
  const outputs: string[] = []

  // Determine what to scan from description
  const targetMatch = description.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/)
  const target = targetMatch?.[0] || 'localhost'

  addLog(taskId, agentId, 'info', `Starting security scan on ${target}`)

  // nmap port scan
  try {
    addLog(taskId, agentId, 'info', 'Running nmap port scan…')
    const { stdout } = await execAsync(`nmap -sV --top-ports 100 -T4 ${target} 2>&1`, { timeout: 60000 })
    outputs.push(`NMAP RESULTS:\n${stdout}`)
    addLog(taskId, agentId, 'info', 'nmap scan complete')
  } catch (e: any) {
    outputs.push(`nmap: ${e.message} (install with: sudo apt install nmap)`)
  }

  // Lynis system audit (localhost only)
  if (target === 'localhost' || target === '127.0.0.1') {
    try {
      addLog(taskId, agentId, 'info', 'Running Lynis system audit…')
      const { stdout } = await execAsync('lynis audit system --quick --no-colors 2>&1 | tail -50', { timeout: 120000 })
      outputs.push(`LYNIS AUDIT:\n${stdout}`)
      addLog(taskId, agentId, 'info', 'Lynis audit complete')
    } catch (e: any) {
      outputs.push(`lynis: ${e.message} (install with: sudo apt install lynis)`)
    }

    // Check open ports
    try {
      const { stdout } = await execAsync('ss -tlnp 2>&1')
      outputs.push(`OPEN PORTS:\n${stdout}`)
    } catch {}

    // Check failed logins
    try {
      const { stdout } = await execAsync('grep "Failed password" /var/log/auth.log 2>/dev/null | tail -20 || echo "No auth.log access"')
      outputs.push(`FAILED LOGINS:\n${stdout}`)
    } catch {}

    // Check for outdated packages
    try {
      const { stdout } = await execAsync('apt list --upgradable 2>/dev/null | head -20')
      outputs.push(`UPGRADABLE PACKAGES:\n${stdout}`)
    } catch {}
  }

  const rawOutput = outputs.join('\n\n')

  // Ask GPT to summarise findings and give recommendations
  const { content: summary, tokens } = await ask(
    agentId,
    'You are a security analyst. Analyse the scan results and provide: 1) Critical findings, 2) Medium risk issues, 3) Recommendations. Be concise and actionable.',
    `Scan target: ${target}\n\nRaw results:\n${rawOutput.slice(0, 6000)}`,
    1024,
  )

  return { result: `${summary}\n\n---\nRAW OUTPUT:\n${rawOutput.slice(0, 3000)}`, tokens }
}

// ── Main task runner ───────────────────────────────────────────────────────

async function runTask(taskId: number, agentId: string, type: string, description: string) {
  const db = getDb()
  db.prepare(`UPDATE tasks SET status='running', started_at=datetime('now') WHERE id=?`).run(taskId)
  updateAgent(agentId, { status: 'active', current_task: description.slice(0, 80) })
  addLog(taskId, agentId, 'info', `Task started: ${description.slice(0, 120)}`)

  let result = ''
  let tokensUsed = 0

  try {
    switch (type) {
      case 'browser': {
        const out = await browserTask(agentId, taskId, description)
        result = out.result; tokensUsed = out.tokens
        break
      }

      case 'security': {
        const out = await securityScan(agentId, taskId, description)
        result = out.result; tokensUsed = out.tokens
        break
      }

      case 'search': {
        addLog(taskId, agentId, 'info', 'Searching the web…')
        const searchResults = await webSearch(description)
        const { content, tokens } = await ask(agentId,
          'You are a research agent. Synthesise the search results into a clear, well-structured answer.',
          `Query: ${description}\n\nSearch results:\n${searchResults}`,
        )
        result = content; tokensUsed = tokens
        addLog(taskId, agentId, 'success', result.slice(0, 300))
        break
      }

      case 'code': {
        const { content: code, tokens: planTokens } = await ask(agentId,
          'You are a code execution agent. Respond with ONLY the shell command or Python script to run, no explanation, no markdown fences.',
          description, 1024,
        )
        tokensUsed += planTokens
        addLog(taskId, agentId, 'info', `Generated code:\n${code}`)
        const { stdout, stderr } = await execAsync(`timeout 30 bash -c ${JSON.stringify(code)}`)
        result = stdout || stderr || '(no output)'
        addLog(taskId, agentId, 'success', `Output:\n${result.slice(0, 2000)}`)
        break
      }

      case 'scrape': {
        const urlMatch = description.match(/https?:\/\/[^\s]+/)
        if (!urlMatch) throw new Error('No URL found in task description')
        const url = urlMatch[0]
        addLog(taskId, agentId, 'info', `Fetching ${url}`)
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
        const html = await response.text()
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
        const { content, tokens } = await ask(agentId,
          'You are a web research agent. Summarise the key information from the provided page content.',
          `URL: ${url}\n\nContent:\n${text}\n\nTask: ${description}`,
        )
        result = content; tokensUsed = tokens
        addLog(taskId, agentId, 'success', result.slice(0, 500))
        break
      }

      case 'file': {
        const { content: raw, tokens } = await ask(agentId,
          'You are a file management agent. Complete the task and respond with a JSON object: { "action": "read|write|list", "path": "...", "content": "..." }',
          description, 2048,
        )
        tokensUsed = tokens
        let instruction: any = {}
        try { instruction = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}') } catch {}
        const filePath = path.join(AGENT_FILES_DIR, path.basename(instruction.path || 'output.txt'))
        if (instruction.action === 'write') {
          writeFileSync(filePath, instruction.content || '')
          result = `Wrote ${filePath}`
        } else if (instruction.action === 'read' && existsSync(filePath)) {
          result = readFileSync(filePath, 'utf8').slice(0, 4000)
        } else {
          result = raw
        }
        addLog(taskId, agentId, 'success', result.slice(0, 500))
        break
      }

      case 'api': {
        const { content: raw, tokens } = await ask(agentId,
          'You are an API integration agent. Respond with ONLY a JSON object: { "url": "...", "method": "GET|POST", "headers": {}, "body": {} }',
          description, 512,
        )
        tokensUsed = tokens
        let apiReq: any = {}
        try { apiReq = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}') } catch {}
        const resp = await fetch(apiReq.url, {
          method: apiReq.method || 'GET',
          headers: apiReq.headers || {},
          body: apiReq.body ? JSON.stringify(apiReq.body) : undefined,
          signal: AbortSignal.timeout(15000),
        })
        result = (await resp.text()).slice(0, 4000)
        addLog(taskId, agentId, 'success', `API response (${resp.status}):\n${result.slice(0, 500)}`)
        break
      }

      default: {
        const { content, tokens } = await ask(agentId,
          'You are a general-purpose AI agent. Complete the task thoroughly.',
          description,
        )
        result = content; tokensUsed = tokens
        addLog(taskId, agentId, 'success', result.slice(0, 500))
      }
    }

    // Save to DB
    db.prepare(`UPDATE tasks SET status='completed', completed_at=datetime('now'), result=?, tokens_used=? WHERE id=?`)
      .run(result.slice(0, 8000), tokensUsed, taskId)
    db.prepare(`UPDATE agents SET tasks_completed=tasks_completed+1, tokens_used=tokens_used+?, status='idle', current_task=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(tokensUsed, agentId)
    recordMetric(agentId, 'tokens', tokensUsed)

    // Save memory summary
    const { content: memorySummary } = await ask(agentId,
      'Summarise what was just accomplished in 1-2 sentences for future memory.',
      `Task: ${description}\nResult: ${result.slice(0, 500)}`,
      100,
    ).catch(() => ({ content: description.slice(0, 100) }))
    saveMemory(agentId, memorySummary, taskId)

  } catch (err: any) {
    const msg = err.message || String(err)
    db.prepare(`UPDATE tasks SET status='failed', completed_at=datetime('now'), error=? WHERE id=?`).run(msg, taskId)
    updateAgent(agentId, { status: 'error', current_task: null })
    addLog(taskId, agentId, 'error', `Task failed: ${msg}`)
  }
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  try {
    const { agent_id, title, description, type, priority } = await req.json()
    if (!title || !description)
      return NextResponse.json({ error: 'title and description are required' }, { status: 400 })

    const task = createTask({ agent_id, title, description, type: type || 'general', priority: priority || 2, status: 'pending' })
    runTask(task.id, agent_id || 'code', type || 'general', description).catch(console.error)

    return NextResponse.json({ ok: true, taskId: task.id, message: 'Task queued and running' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
