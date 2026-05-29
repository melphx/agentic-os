import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb, updateAgent, addLog, recordMetric, createTask } from '@/lib/db'
import { exec } from 'child_process'
import { promisify } from 'util'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import path from 'path'
import OpenAI from 'openai'

const execAsync = promisify(exec)

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
})

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

async function runTask(taskId: number, agentId: string, type: string, description: string) {
  const db = getDb()
  db.prepare(`UPDATE tasks SET status='running', started_at=datetime('now') WHERE id=?`).run(taskId)
  updateAgent(agentId, { status: 'active', current_task: description.slice(0, 80) })
  addLog(taskId, agentId, 'info', `Task started: ${description.slice(0, 120)}`)

  let result = ''
  let tokensUsed = 0

  try {
    switch (type) {
      case 'code': {
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a code execution agent. Respond with ONLY the shell command or Python script to run, no explanation, no markdown fences.' },
            { role: 'user', content: description },
          ],
          max_tokens: 1024,
        })
        const code = completion.choices[0].message.content || ''
        tokensUsed = completion.usage?.total_tokens || 0
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
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a web research agent. Summarise the key information from the provided page content.' },
            { role: 'user', content: `URL: ${url}\n\nContent:\n${text}\n\nTask: ${description}` },
          ],
          max_tokens: 1024,
        })
        result = completion.choices[0].message.content || ''
        tokensUsed = completion.usage?.total_tokens || 0
        addLog(taskId, agentId, 'success', result.slice(0, 500))
        break
      }

      case 'file': {
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a file management agent. Complete the task and respond with a JSON object: { "action": "read|write|list", "path": "...", "content": "..." }' },
            { role: 'user', content: description },
          ],
          max_tokens: 2048,
        })
        tokensUsed = completion.usage?.total_tokens || 0
        const raw = completion.choices[0].message.content || '{}'
        let instruction: any = {}
        try { instruction = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}') } catch {}
        const ALLOWED_DIR = process.env.AGENT_FILES_DIR || path.join(process.cwd(), 'agent-files')
        const filePath = path.join(ALLOWED_DIR, path.basename(instruction.path || 'output.txt'))
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
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are an API integration agent. Respond with ONLY a JSON object: { "url": "...", "method": "GET|POST", "headers": {}, "body": {} }' },
            { role: 'user', content: description },
          ],
          max_tokens: 512,
        })
        tokensUsed = completion.usage?.total_tokens || 0
        const raw = completion.choices[0].message.content || '{}'
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
        const completion = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: 'system', content: 'You are a general-purpose AI agent. Complete the task thoroughly.' },
            { role: 'user', content: description },
          ],
          max_tokens: 2048,
        })
        result = completion.choices[0].message.content || ''
        tokensUsed = completion.usage?.total_tokens || 0
        addLog(taskId, agentId, 'success', result.slice(0, 500))
      }
    }

    db.prepare(`UPDATE tasks SET status='completed', completed_at=datetime('now'), result=?, tokens_used=? WHERE id=?`)
      .run(result.slice(0, 8000), tokensUsed, taskId)
    db.prepare(`UPDATE agents SET tasks_completed=tasks_completed+1, tokens_used=tokens_used+?, status='idle', current_task=NULL, updated_at=datetime('now') WHERE id=?`)
      .run(tokensUsed, agentId)
    recordMetric(agentId, 'tokens', tokensUsed)

  } catch (err: any) {
    const msg = err.message || String(err)
    db.prepare(`UPDATE tasks SET status='failed', completed_at=datetime('now'), error=? WHERE id=?`).run(msg, taskId)
    updateAgent(agentId, { status: 'error', current_task: null })
    addLog(taskId, agentId, 'error', `Task failed: ${msg}`)
  }
}

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
