import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DB_DIR = process.env.DB_PATH || path.join(process.cwd(), 'data')
const DB_FILE = path.join(DB_DIR, 'claude-os.db')

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db
  _db = new Database(DB_FILE)
  _db.pragma('journal_mode = WAL')
  _db.pragma('foreign_keys = ON')
  initSchema(_db)
  return _db
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short TEXT NOT NULL,
      description TEXT,
      accent TEXT DEFAULT '#6366f1',
      accent_dark TEXT DEFAULT '#4338ca',
      status TEXT DEFAULT 'idle' CHECK(status IN ('active','idle','error','offline')),
      current_task TEXT,
      tokens_used INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      uptime_seconds INTEGER DEFAULT 0,
      progress INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT REFERENCES agents(id),
      summary TEXT NOT NULL,
      task_id INTEGER REFERENCES tasks(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT REFERENCES agents(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      cron TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      next_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT REFERENCES agents(id),
      title TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'general' CHECK(type IN ('code','scrape','file','api','general','browser','security','search')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
      priority INTEGER DEFAULT 2 CHECK(priority IN (1,2,3)),
      result TEXT,
      error TEXT,
      tokens_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER REFERENCES tasks(id),
      agent_id TEXT REFERENCES agents(id),
      level TEXT DEFAULT 'info' CHECK(level IN ('info','warn','error','success')),
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT REFERENCES agents(id),
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
      content TEXT NOT NULL,
      agent_id TEXT,
      tokens_used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      file_type TEXT DEFAULT 'text',
      file_size INTEGER DEFAULT 0,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Seed default agents if table is empty
    INSERT OR IGNORE INTO agents (id, name, short, description, accent, accent_dark) VALUES
      ('research',  'Research Agent',  'RES', 'Web research, data gathering, and summarisation', '#06b6d4', '#0e7490'),
      ('code',      'Code Engineer',   'ENG', 'Code generation, debugging, and review',          '#6366f1', '#4338ca'),
      ('data',      'Data Analyst',    'DAT', 'Data analysis, SQL queries, and visualisation',   '#10b981', '#047857'),
      ('writer',    'Content Writer',  'WRT', 'Blog posts, emails, and marketing copy',          '#f59e0b', '#b45309'),
      ('email',     'Email Manager',   'EML', 'Inbox management and automated responses',        '#f43f5e', '#be123c'),
      ('security',  'Security Analyst','SEC', 'Vulnerability scanning and threat analysis',      '#a855f7', '#7c3aed');
  `)

  // ── Migration: expand tasks.type CHECK constraint to include browser/security/search ──
  // SQLite can't ALTER constraints, so we recreate the table preserving all data
  try {
    const typeCheck = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'`).get() as { sql: string } | undefined
    if (typeCheck && !typeCheck.sql.includes("'browser'")) {
      db.exec(`
        ALTER TABLE tasks RENAME TO tasks_old;
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT REFERENCES agents(id),
          title TEXT NOT NULL,
          description TEXT,
          type TEXT DEFAULT 'general' CHECK(type IN ('code','scrape','file','api','general','browser','security','search')),
          status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
          priority INTEGER DEFAULT 2 CHECK(priority IN (1,2,3)),
          result TEXT,
          error TEXT,
          tokens_used INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT
        );
        INSERT INTO tasks SELECT * FROM tasks_old;
        DROP TABLE tasks_old;
      `)
    }
  } catch (e) {
    // Migration already applied or not needed
  }
}

// ── Typed helpers ──────────────────────────────────────────────────────────

export interface Agent {
  id: string
  name: string
  short: string
  description: string
  accent: string
  accent_dark: string
  status: 'active' | 'idle' | 'error' | 'offline'
  current_task: string | null
  tokens_used: number
  tasks_completed: number
  uptime_seconds: number
  progress: number
  created_at: string
  updated_at: string
}

export interface Task {
  id: number
  agent_id: string | null
  title: string
  description: string | null
  type: 'code' | 'scrape' | 'file' | 'api' | 'general'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  priority: 1 | 2 | 3
  result: string | null
  error: string | null
  tokens_used: number
  created_at: string
  started_at: string | null
  completed_at: string | null
}

export interface TaskLog {
  id: number
  task_id: number
  agent_id: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  created_at: string
}

export function saveMemory(agentId: string, summary: string, taskId?: number) {
  getDb().prepare(`
    INSERT INTO agent_memory (agent_id, summary, task_id) VALUES (?, ?, ?)
  `).run(agentId, summary, taskId ?? null)
  // Keep only the last 20 memories per agent
  getDb().prepare(`
    DELETE FROM agent_memory WHERE agent_id = ? AND id NOT IN (
      SELECT id FROM agent_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20
    )
  `).run(agentId, agentId)
}

export function getMemory(agentId: string, limit = 5): string {
  const rows = getDb().prepare(`
    SELECT summary FROM agent_memory WHERE agent_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(agentId, limit) as { summary: string }[]
  if (!rows.length) return ''
  return rows.reverse().map((r, i) => `[Memory ${i + 1}] ${r.summary}`).join('\n')
}

export interface Schedule {
  id: number; agent_id: string; title: string; description: string
  type: string; cron: string; enabled: number
  last_run: string | null; next_run: string | null; created_at: string
}

export function getSchedules(): Schedule[] {
  return getDb().prepare('SELECT * FROM schedules ORDER BY created_at DESC').all() as Schedule[]
}

export function createSchedule(data: Omit<Schedule, 'id' | 'created_at' | 'last_run' | 'next_run'>): Schedule {
  const info = getDb().prepare(`
    INSERT INTO schedules (agent_id, title, description, type, cron, enabled)
    VALUES (@agent_id, @title, @description, @type, @cron, @enabled)
  `).run(data)
  return getDb().prepare('SELECT * FROM schedules WHERE id = ?').get(info.lastInsertRowid) as Schedule
}

export function updateSchedule(id: number, fields: Partial<Schedule>) {
  const allowed = ['enabled', 'last_run', 'next_run']
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k} = @${k}`).join(', ')
  if (!updates) return
  getDb().prepare(`UPDATE schedules SET ${updates} WHERE id = @id`).run({ ...fields, id })
}

export function getAgents(): Agent[] {
  return getDb().prepare('SELECT * FROM agents ORDER BY name').all() as Agent[]
}

export function getAgent(id: string): Agent | null {
  return (getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent) ?? null
}

export function updateAgent(id: string, fields: Partial<Agent>) {
  const allowed = ['status','current_task','tokens_used','tasks_completed','uptime_seconds','progress']
  const updates = Object.entries(fields)
    .filter(([k]) => allowed.includes(k))
    .map(([k]) => `${k} = @${k}`)
    .join(', ')
  if (!updates) return
  getDb().prepare(`UPDATE agents SET ${updates}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...fields, id })
}

export function getTasks(filters?: { agent_id?: string; status?: string; limit?: number }): Task[] {
  let q = 'SELECT * FROM tasks WHERE 1=1'
  const params: Record<string, unknown> = {}
  if (filters?.agent_id) { q += ' AND agent_id = @agent_id'; params.agent_id = filters.agent_id }
  if (filters?.status)   { q += ' AND status = @status';     params.status   = filters.status   }
  q += ' ORDER BY priority ASC, created_at DESC'
  if (filters?.limit)    { q += ' LIMIT @limit';              params.limit    = filters.limit    }
  return getDb().prepare(q).all(params) as Task[]
}

export function createTask(data: Omit<Task, 'id' | 'created_at' | 'started_at' | 'completed_at' | 'result' | 'error' | 'tokens_used'>): Task {
  const stmt = getDb().prepare(`
    INSERT INTO tasks (agent_id, title, description, type, priority, status)
    VALUES (@agent_id, @title, @description, @type, @priority, 'pending')
  `)
  const info = stmt.run(data)
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) as Task
}

export function addLog(taskId: number, agentId: string | null, level: TaskLog['level'], message: string) {
  try {
    // Use null if agentId is empty/missing to avoid FK constraint failures
    const safeAgentId = agentId || null
    getDb().prepare(`
      INSERT INTO task_logs (task_id, agent_id, level, message) VALUES (?, ?, ?, ?)
    `).run(taskId, safeAgentId, level, message)
  } catch { /* never let logging crash the task */ }
}

export function getMetricHistory(agentId: string, metric: string, limit = 12): number[] {
  const rows = getDb().prepare(`
    SELECT value FROM metrics WHERE agent_id = ? AND metric = ?
    ORDER BY recorded_at DESC LIMIT ?
  `).all(agentId, metric, limit) as { value: number }[]
  return rows.map(r => r.value).reverse()
}

export function recordMetric(agentId: string, metric: string, value: number) {
  getDb().prepare(`
    INSERT INTO metrics (agent_id, metric, value) VALUES (?, ?, ?)
  `).run(agentId, metric, value)
}

// ── Agent Knowledge (training files) ──────────────────────────────────────

export interface AgentKnowledge {
  id: number
  agent_id: string
  filename: string
  file_type: string
  file_size: number
  content: string
  created_at: string
}

export function getKnowledge(agentId: string): AgentKnowledge[] {
  return getDb().prepare(`
    SELECT id, agent_id, filename, file_type, file_size, created_at
    FROM agent_knowledge WHERE agent_id = ? ORDER BY created_at DESC
  `).all(agentId) as AgentKnowledge[]
}

export function getKnowledgeContent(agentId: string): string {
  const rows = getDb().prepare(`
    SELECT filename, content FROM agent_knowledge WHERE agent_id = ? ORDER BY created_at DESC
  `).all(agentId) as { filename: string; content: string }[]
  if (!rows.length) return ''
  return rows.map(r => `--- Knowledge File: ${r.filename} ---\n${r.content.slice(0, 8000)}`).join('\n\n')
}

export function saveKnowledge(agentId: string, filename: string, fileType: string, fileSize: number, content: string): AgentKnowledge {
  const info = getDb().prepare(`
    INSERT INTO agent_knowledge (agent_id, filename, file_type, file_size, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, filename, fileType, fileSize, content)
  return getDb().prepare('SELECT * FROM agent_knowledge WHERE id = ?').get(info.lastInsertRowid) as AgentKnowledge
}

export function deleteKnowledge(id: number, agentId: string) {
  getDb().prepare('DELETE FROM agent_knowledge WHERE id = ? AND agent_id = ?').run(id, agentId)
}

// ── Agent Integrations ─────────────────────────────────────────────────────

export interface AgentIntegration {
  id: number
  agent_id: string
  name: string
  type: 'webhook' | 'n8n' | 'ghl_read' | 'ghl_write' | 'google_sheets' | 'google_docs' | 'browser'
  description: string
  config: string  // JSON string
  enabled: number
  created_at: string
}

export function ensureIntegrationsTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS agent_integrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      config TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

export function getIntegrations(agentId: string): AgentIntegration[] {
  ensureIntegrationsTable()
  return getDb().prepare(
    'SELECT * FROM agent_integrations WHERE agent_id = ? AND enabled = 1 ORDER BY created_at ASC'
  ).all(agentId) as AgentIntegration[]
}

export function getAllIntegrations(agentId: string): AgentIntegration[] {
  ensureIntegrationsTable()
  return getDb().prepare(
    'SELECT * FROM agent_integrations WHERE agent_id = ? ORDER BY created_at ASC'
  ).all(agentId) as AgentIntegration[]
}

export function createIntegration(data: Omit<AgentIntegration, 'id' | 'created_at'>): AgentIntegration {
  ensureIntegrationsTable()
  const info = getDb().prepare(`
    INSERT INTO agent_integrations (agent_id, name, type, description, config, enabled)
    VALUES (@agent_id, @name, @type, @description, @config, @enabled)
  `).run(data)
  return getDb().prepare('SELECT * FROM agent_integrations WHERE id = ?').get(info.lastInsertRowid) as AgentIntegration
}

export function updateIntegration(id: number, fields: Partial<AgentIntegration>) {
  ensureIntegrationsTable()
  const allowed = ['name', 'type', 'description', 'config', 'enabled']
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k} = @${k}`).join(', ')
  if (!updates) return
  getDb().prepare(`UPDATE agent_integrations SET ${updates} WHERE id = @id`).run({ ...fields, id })
}

export function deleteIntegration(id: number, agentId: string) {
  ensureIntegrationsTable()
  getDb().prepare('DELETE FROM agent_integrations WHERE id = ? AND agent_id = ?').run(id, agentId)
}

// Returns a formatted string describing all integrations for injection into system prompt
export function getIntegrationContext(agentId: string): string {
  const integrations = getIntegrations(agentId)
  if (!integrations.length) return ''
  const lines = integrations.map(i =>
    `- [${i.name}] (type: ${i.type}): ${i.description}`
  )
  return `You have access to the following integrations. To call one, output exactly:\n{{CALL:integration_name:json_payload}}\nWhere json_payload is the data to send (use {} if none).\n\nAvailable integrations:\n${lines.join('\n')}`
}

// ── API Keys (for inbound webhook triggers) ────────────────────────────────

export function ensureApiKeysTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      last_used TEXT
    )
  `)
}

export interface ApiKey { id: number; name: string; key_prefix: string; key_hash: string; created_at: string; last_used: string | null }

export function getApiKeys(): ApiKey[] {
  ensureApiKeysTable()
  return getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKey[]
}

export function createApiKey(name: string, keyPrefix: string, keyHash: string): ApiKey {
  ensureApiKeysTable()
  const info = getDb().prepare('INSERT INTO api_keys (name, key_prefix, key_hash) VALUES (?, ?, ?)').run(name, keyPrefix, keyHash)
  return getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(info.lastInsertRowid) as ApiKey
}

export function validateApiKey(raw: string): boolean {
  ensureApiKeysTable()
  const { createHash } = require('crypto')
  const hash = createHash('sha256').update(raw).digest('hex')
  const row = getDb().prepare('SELECT id FROM api_keys WHERE key_hash = ?').get(hash)
  if (row) {
    getDb().prepare("UPDATE api_keys SET last_used = datetime('now') WHERE key_hash = ?").run(hash)
    return true
  }
  return false
}

export function deleteApiKey(id: number) {
  ensureApiKeysTable()
  getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id)
}

// ── Task Templates ─────────────────────────────────────────────────────────

export interface TaskTemplate {
  id: number; agent_id: string | null; name: string
  title_template: string; description_template: string
  type: string; variables: string; created_at: string
}

export function ensureTemplatesTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      name TEXT NOT NULL,
      title_template TEXT NOT NULL,
      description_template TEXT NOT NULL,
      type TEXT DEFAULT 'general',
      variables TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

export function getTemplates(agentId?: string): TaskTemplate[] {
  ensureTemplatesTable()
  if (agentId) return getDb().prepare('SELECT * FROM task_templates WHERE agent_id = ? OR agent_id IS NULL ORDER BY name').all(agentId) as TaskTemplate[]
  return getDb().prepare('SELECT * FROM task_templates ORDER BY name').all() as TaskTemplate[]
}

export function createTemplate(data: Omit<TaskTemplate, 'id' | 'created_at'>): TaskTemplate {
  ensureTemplatesTable()
  const info = getDb().prepare(`
    INSERT INTO task_templates (agent_id, name, title_template, description_template, type, variables)
    VALUES (@agent_id, @name, @title_template, @description_template, @type, @variables)
  `).run(data)
  return getDb().prepare('SELECT * FROM task_templates WHERE id = ?').get(info.lastInsertRowid) as TaskTemplate
}

export function deleteTemplate(id: number) {
  ensureTemplatesTable()
  getDb().prepare('DELETE FROM task_templates WHERE id = ?').run(id)
}

// ── Pipelines ──────────────────────────────────────────────────────────────

export interface Pipeline {
  id: number; name: string; description: string
  steps: string; enabled: number; created_at: string
}

export function ensurePipelinesTable() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      steps TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
}

export function getPipelines(): Pipeline[] {
  ensurePipelinesTable()
  return getDb().prepare('SELECT * FROM pipelines ORDER BY created_at DESC').all() as Pipeline[]
}

export function getPipeline(id: number): Pipeline | null {
  ensurePipelinesTable()
  return (getDb().prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as Pipeline) ?? null
}

export function createPipeline(data: Omit<Pipeline, 'id' | 'created_at'>): Pipeline {
  ensurePipelinesTable()
  const info = getDb().prepare(`
    INSERT INTO pipelines (name, description, steps, enabled)
    VALUES (@name, @description, @steps, @enabled)
  `).run(data)
  return getDb().prepare('SELECT * FROM pipelines WHERE id = ?').get(info.lastInsertRowid) as Pipeline
}

export function updatePipeline(id: number, fields: Partial<Pipeline>) {
  ensurePipelinesTable()
  const allowed = ['name', 'description', 'steps', 'enabled']
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k} = @${k}`).join(', ')
  if (!updates) return
  getDb().prepare(`UPDATE pipelines SET ${updates} WHERE id = @id`).run({ ...fields, id })
}

export function deletePipeline(id: number) {
  ensurePipelinesTable()
  getDb().prepare('DELETE FROM pipelines WHERE id = ?').run(id)
}

// ── Analytics helpers ──────────────────────────────────────────────────────

export function getAnalytics() {
  const db = getDb()
  const summary = db.prepare(`
    SELECT
      COUNT(*) as total_tasks,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(tokens_used) as total_tokens,
      AVG(CASE WHEN status='completed' AND started_at IS NOT NULL
        THEN (julianday(completed_at) - julianday(started_at)) * 86400 END) as avg_duration_secs
    FROM tasks
  `).get() as any

  const byAgent = db.prepare(`
    SELECT a.name, a.accent, a.id,
      COUNT(t.id) as task_count,
      SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(t.tokens_used) as tokens
    FROM agents a LEFT JOIN tasks t ON t.agent_id = a.id
    GROUP BY a.id ORDER BY task_count DESC
  `).all() as any[]

  const byDay = db.prepare(`
    SELECT substr(created_at, 1, 10) as day, COUNT(*) as count,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
    FROM tasks
    WHERE created_at >= datetime('now', '-14 days')
    GROUP BY day ORDER BY day ASC
  `).all() as any[]

  const byType = db.prepare(`
    SELECT type, COUNT(*) as count FROM tasks GROUP BY type ORDER BY count DESC
  `).all() as any[]

  const costPerAgent = db.prepare(`
    SELECT agent_id, SUM(tokens_used) as tokens FROM tasks
    WHERE status='completed' GROUP BY agent_id ORDER BY tokens DESC
  `).all() as any[]

  return { summary, byAgent, byDay, byType, costPerAgent }
}

// ── Outbound Webhooks ──────────────────────────────────────────────────────

export interface OutboundWebhook {
  id: number; name: string; url: string; headers: string
  events: string; agent_filter: string | null; enabled: number; created_at: string
}

export function ensureWebhooksTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS outbound_webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, url TEXT NOT NULL,
    headers TEXT DEFAULT '{}',
    events TEXT DEFAULT 'task.completed',
    agent_filter TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

export function getWebhooks(): OutboundWebhook[] {
  ensureWebhooksTable()
  return getDb().prepare('SELECT * FROM outbound_webhooks WHERE enabled=1').all() as OutboundWebhook[]
}

export function getAllWebhooks(): OutboundWebhook[] {
  ensureWebhooksTable()
  return getDb().prepare('SELECT * FROM outbound_webhooks ORDER BY created_at DESC').all() as OutboundWebhook[]
}

export function createWebhook(data: Omit<OutboundWebhook, 'id' | 'created_at'>): OutboundWebhook {
  ensureWebhooksTable()
  const info = getDb().prepare(`INSERT INTO outbound_webhooks (name,url,headers,events,agent_filter,enabled) VALUES (@name,@url,@headers,@events,@agent_filter,@enabled)`).run(data)
  return getDb().prepare('SELECT * FROM outbound_webhooks WHERE id=?').get(info.lastInsertRowid) as OutboundWebhook
}

export function deleteWebhook(id: number) { ensureWebhooksTable(); getDb().prepare('DELETE FROM outbound_webhooks WHERE id=?').run(id) }

// ── Event Triggers ─────────────────────────────────────────────────────────

export interface EventTrigger {
  id: number; name: string; event_type: string
  config: string; action_type: string; action_id: string | null
  last_check: string | null; enabled: number; created_at: string
}

export function ensureTriggersTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS event_triggers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    action_type TEXT DEFAULT 'task',
    action_id TEXT,
    last_check TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

export function getTriggers(): EventTrigger[] {
  ensureTriggersTable()
  return getDb().prepare('SELECT * FROM event_triggers ORDER BY created_at DESC').all() as EventTrigger[]
}

export function getActiveTriggers(): EventTrigger[] {
  ensureTriggersTable()
  return getDb().prepare("SELECT * FROM event_triggers WHERE enabled=1").all() as EventTrigger[]
}

export function createTrigger(data: Omit<EventTrigger, 'id' | 'created_at' | 'last_check'>): EventTrigger {
  ensureTriggersTable()
  const info = getDb().prepare(`INSERT INTO event_triggers (name,event_type,config,action_type,action_id,enabled) VALUES (@name,@event_type,@config,@action_type,@action_id,@enabled)`).run(data)
  return getDb().prepare('SELECT * FROM event_triggers WHERE id=?').get(info.lastInsertRowid) as EventTrigger
}

export function updateTrigger(id: number, fields: Partial<EventTrigger>) {
  ensureTriggersTable()
  const allowed = ['enabled','last_check','name','config']
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k}=@${k}`).join(',')
  if (!updates) return
  getDb().prepare(`UPDATE event_triggers SET ${updates} WHERE id=@id`).run({ ...fields, id })
}

export function deleteTrigger(id: number) { ensureTriggersTable(); getDb().prepare('DELETE FROM event_triggers WHERE id=?').run(id) }

// ── Company Knowledge Base (shared across all agents) ─────────────────────

export interface CompanyKnowledge {
  id: number; filename: string; file_type: string; file_size: number; content: string; created_at: string
}

export function ensureCompanyKbTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS company_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL, file_type TEXT DEFAULT 'text',
    file_size INTEGER DEFAULT 0, content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

export function getCompanyKnowledge(): CompanyKnowledge[] {
  ensureCompanyKbTable()
  return getDb().prepare('SELECT id,filename,file_type,file_size,created_at FROM company_knowledge ORDER BY created_at DESC').all() as CompanyKnowledge[]
}

export function getCompanyKnowledgeContent(): string {
  ensureCompanyKbTable()
  const rows = getDb().prepare('SELECT filename,content FROM company_knowledge ORDER BY created_at DESC').all() as { filename: string; content: string }[]
  if (!rows.length) return ''
  return rows.map(r => `--- Company KB: ${r.filename} ---\n${r.content.slice(0, 5000)}`).join('\n\n')
}

export function saveCompanyKnowledge(filename: string, fileType: string, fileSize: number, content: string): CompanyKnowledge {
  ensureCompanyKbTable()
  const info = getDb().prepare('INSERT INTO company_knowledge (filename,file_type,file_size,content) VALUES (?,?,?,?)').run(filename, fileType, fileSize, content)
  return getDb().prepare('SELECT * FROM company_knowledge WHERE id=?').get(info.lastInsertRowid) as CompanyKnowledge
}

export function deleteCompanyKnowledge(id: number) { ensureCompanyKbTable(); getDb().prepare('DELETE FROM company_knowledge WHERE id=?').run(id) }

// ── Drive Sync Configs ─────────────────────────────────────────────────────

export interface DriveSyncConfig {
  id: number; agent_id: string | null; name: string
  folder_id: string; service_account_json: string
  last_synced: string | null; enabled: number; created_at: string
}

export function ensureDriveSyncTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS drive_sync_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT, name TEXT NOT NULL, folder_id TEXT NOT NULL,
    service_account_json TEXT NOT NULL,
    last_synced TEXT, enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

export function getDriveSyncConfigs(): DriveSyncConfig[] {
  ensureDriveSyncTable()
  return getDb().prepare('SELECT * FROM drive_sync_configs ORDER BY created_at DESC').all() as DriveSyncConfig[]
}

export function createDriveSyncConfig(data: Omit<DriveSyncConfig, 'id' | 'created_at' | 'last_synced'>): DriveSyncConfig {
  ensureDriveSyncTable()
  const info = getDb().prepare(`INSERT INTO drive_sync_configs (agent_id,name,folder_id,service_account_json,enabled) VALUES (@agent_id,@name,@folder_id,@service_account_json,@enabled)`).run(data)
  return getDb().prepare('SELECT * FROM drive_sync_configs WHERE id=?').get(info.lastInsertRowid) as DriveSyncConfig
}

export function updateDriveSyncConfig(id: number, fields: Partial<DriveSyncConfig>) {
  ensureDriveSyncTable()
  const allowed = ['enabled','last_synced']
  const updates = Object.entries(fields).filter(([k]) => allowed.includes(k)).map(([k]) => `${k}=@${k}`).join(',')
  if (!updates) return
  getDb().prepare(`UPDATE drive_sync_configs SET ${updates} WHERE id=@id`).run({ ...fields, id })
}

export function deleteDriveSyncConfig(id: number) { ensureDriveSyncTable(); getDb().prepare('DELETE FROM drive_sync_configs WHERE id=?').run(id) }
