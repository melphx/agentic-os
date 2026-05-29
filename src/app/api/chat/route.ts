import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { requireAuth } from '@/lib/auth'
import { getDb, getAgents, getTasks, getSchedules, createTask } from '@/lib/db'

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.OPENAI_API_KEY || '',
})
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

const SYSTEM_PROMPT = `You are the AI brain of Claude OS — a production mission control dashboard for managing AI agents.
You have full control over the system. When users ask you to do something, USE THE AVAILABLE TOOLS to actually do it.
Never say "I can't do that" — if there's a tool for it, use it.
Be concise. Confirm actions with a short success message. Use markdown sparingly.`

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_agent',
      description: 'Create a new AI agent with a name, description and optional accent color',
      parameters: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'Full agent name e.g. "SEO Specialist"' },
          description: { type: 'string', description: 'What this agent does' },
          short:       { type: 'string', description: '3-letter abbreviation e.g. "SEO"' },
          accent:      { type: 'string', description: 'Hex color e.g. "#06b6d4"' },
        },
        required: ['name', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_task',
      description: 'Dispatch a task to an agent for execution. Use this when the user wants something done.',
      parameters: {
        type: 'object',
        properties: {
          agent_id:    { type: 'string', description: 'Agent ID e.g. "research", "code", "writer"' },
          title:       { type: 'string', description: 'Short task title' },
          description: { type: 'string', description: 'Full task description — be detailed' },
          type:        { type: 'string', enum: ['general','code','scrape','file','api','browser','security','search'], description: 'Task type' },
          priority:    { type: 'number', enum: [1, 2, 3], description: '1=high, 2=normal, 3=low' },
        },
        required: ['agent_id', 'title', 'description', 'type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_agents',
      description: 'Get the list of all agents and their current status',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Get recent tasks, optionally filtered by status or agent',
      parameters: {
        type: 'object',
        properties: {
          status:   { type: 'string', enum: ['pending','running','completed','failed'], description: 'Filter by status' },
          agent_id: { type: 'string', description: 'Filter by agent ID' },
          limit:    { type: 'number', description: 'Max results, default 10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description: 'Schedule a recurring task with a cron expression',
      parameters: {
        type: 'object',
        properties: {
          agent_id:    { type: 'string', description: 'Agent ID' },
          title:       { type: 'string', description: 'Schedule title' },
          description: { type: 'string', description: 'What to do each time it runs' },
          type:        { type: 'string', enum: ['general','code','scrape','file','api','browser','security','search'] },
          cron:        { type: 'string', description: 'Cron expression e.g. "0 9 * * *" for 9am daily' },
        },
        required: ['agent_id', 'title', 'description', 'type', 'cron'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_metrics',
      description: 'Get system metrics: token usage, task counts, agent statuses',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_system',
      description: 'Search across agents, tasks, and logs for a keyword',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term' },
        },
        required: ['query'],
      },
    },
  },
]

// ── Tool executors ──────────────────────────────────────────────────────────

async function executeTool(name: string, args: any, baseUrl: string, jwtSecret: string): Promise<string> {
  const db = getDb()

  switch (name) {
    case 'create_agent': {
      const id = args.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 32)
      const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(id)
      if (existing) return `Agent "${args.name}" already exists (id: ${id})`
      db.prepare(`INSERT INTO agents (id, name, short, description, accent, accent_dark, status) VALUES (?, ?, ?, ?, ?, ?, 'idle')`)
        .run(id, args.name, args.short || args.name.slice(0,3).toUpperCase(), args.description, args.accent || '#6366f1', '#4338ca')
      return `✅ Agent "${args.name}" created successfully (id: ${id})`
    }

    case 'run_task': {
      const task = createTask({
        agent_id: args.agent_id,
        title: args.title,
        description: args.description,
        type: args.type || 'general',
        priority: args.priority || 2,
        status: 'pending',
      })
      // Fire async execution
      fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': jwtSecret },
        body: JSON.stringify(args),
      }).catch(console.error)
      return `✅ Task dispatched (ID: ${task.id}) — "${args.title}" assigned to ${args.agent_id}. Check the Tasks view for progress.`
    }

    case 'get_agents': {
      const agents = getAgents()
      return agents.map(a => `• ${a.name} [${a.status}] — ${a.tasks_completed} tasks, ${a.tokens_used} tokens`).join('\n')
    }

    case 'get_tasks': {
      const tasks = getTasks({ status: args.status, agent_id: args.agent_id, limit: args.limit || 10 })
      if (!tasks.length) return 'No tasks found.'
      return tasks.map(t => `• [${t.status.toUpperCase()}] ${t.title} (${t.type}) — ${new Date(t.created_at).toLocaleString()}`).join('\n')
    }

    case 'create_schedule': {
      const res = await fetch(`${baseUrl}/api/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-scheduler': jwtSecret },
        body: JSON.stringify(args),
      })
      const data = await res.json()
      if (data.error) return `❌ Failed: ${data.error}`
      return `✅ Schedule created — "${args.title}" will run ${args.cron} (ID: ${data.id})`
    }

    case 'get_metrics': {
      const row = db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM agents) as total_agents,
          (SELECT COUNT(*) FROM agents WHERE status='active') as active_agents,
          (SELECT SUM(tokens_used) FROM agents) as total_tokens,
          (SELECT COUNT(*) FROM tasks WHERE status='completed') as completed,
          (SELECT COUNT(*) FROM tasks WHERE status='running') as running,
          (SELECT COUNT(*) FROM tasks WHERE status='pending') as pending,
          (SELECT COUNT(*) FROM tasks WHERE status='failed') as failed
      `).get() as any
      return `Agents: ${row.total_agents} (${row.active_agents} active)\nTasks: ${row.completed} completed, ${row.running} running, ${row.pending} pending, ${row.failed} failed\nTotal tokens used: ${row.total_tokens || 0}`
    }

    case 'search_system': {
      const q = `%${args.query}%`
      const agents = db.prepare(`SELECT name, status, description FROM agents WHERE name LIKE ? OR description LIKE ?`).all(q, q) as any[]
      const tasks  = db.prepare(`SELECT title, status, type FROM tasks WHERE title LIKE ? OR description LIKE ? OR result LIKE ? LIMIT 5`).all(q, q, q) as any[]
      const logs   = db.prepare(`SELECT message, level, created_at FROM task_logs WHERE message LIKE ? LIMIT 5`).all(q) as any[]
      const parts: string[] = []
      if (agents.length) parts.push(`Agents:\n${agents.map(a => `• ${a.name} [${a.status}]`).join('\n')}`)
      if (tasks.length)  parts.push(`Tasks:\n${tasks.map(t => `• [${t.status}] ${t.title}`).join('\n')}`)
      if (logs.length)   parts.push(`Logs:\n${logs.map(l => `• ${l.message.slice(0,80)}`).join('\n')}`)
      return parts.length ? parts.join('\n\n') : `No results found for "${args.query}"`
    }

    default:
      return `Unknown tool: ${name}`
  }
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  try {
    const { messages } = await req.json()
    const baseUrl = process.env.INTERNAL_URL || 'http://localhost:3000'
    const jwtSecret = process.env.JWT_SECRET || ''

    // First call — may trigger tool use
    const response = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 2048,
      tools: TOOLS,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
      ],
    })

    let assistantMessage = response.choices[0].message
    let totalTokens = response.usage?.total_tokens || 0
    const toolResults: string[] = []

    // Execute any tool calls
    if (assistantMessage.tool_calls?.length) {
      const toolCallMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
        assistantMessage,
      ]

      for (const tc of assistantMessage.tool_calls) {
        const args = JSON.parse(tc.function.arguments)
        const result = await executeTool(tc.function.name, args, baseUrl, jwtSecret)
        toolResults.push(result)
        toolCallMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }

      // Second call — get final natural language response
      const finalResponse = await client.chat.completions.create({
        model: MODEL,
        max_completion_tokens: 1024,
        messages: toolCallMessages,
      })
      assistantMessage = finalResponse.choices[0].message
      totalTokens += finalResponse.usage?.total_tokens || 0
    }

    const content = assistantMessage.content || '(No response)'

    // Persist to DB
    const db = getDb()
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
    if (lastUser) db.prepare('INSERT INTO chat_messages (role, content) VALUES (?, ?)').run('user', lastUser.content)
    db.prepare('INSERT INTO chat_messages (role, content, tokens_used) VALUES (?, ?, ?)').run('assistant', content, totalTokens)

    return NextResponse.json({ content, tokensUsed: totalTokens, model: MODEL, toolsUsed: assistantMessage.tool_calls?.map(tc => tc.function.name) || [] })
  } catch (err: any) {
    console.error('[chat/route]', err)
    return NextResponse.json({ error: err.message || 'Failed to get a response.' }, { status: 500 })
  }
}
