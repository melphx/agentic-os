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
      type TEXT DEFAULT 'general' CHECK(type IN ('code','scrape','file','api','general')),
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

    -- Seed default agents if table is empty
    INSERT OR IGNORE INTO agents (id, name, short, description, accent, accent_dark) VALUES
      ('research',  'Research Agent',  'RES', 'Web research, data gathering, and summarisation', '#06b6d4', '#0e7490'),
      ('code',      'Code Engineer',   'ENG', 'Code generation, debugging, and review',          '#6366f1', '#4338ca'),
      ('data',      'Data Analyst',    'DAT', 'Data analysis, SQL queries, and visualisation',   '#10b981', '#047857'),
      ('writer',    'Content Writer',  'WRT', 'Blog posts, emails, and marketing copy',          '#f59e0b', '#b45309'),
      ('email',     'Email Manager',   'EML', 'Inbox management and automated responses',        '#f43f5e', '#be123c'),
      ('security',  'Security Analyst','SEC', 'Vulnerability scanning and threat analysis',      '#a855f7', '#7c3aed');
  `)
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

export function addLog(taskId: number, agentId: string, level: TaskLog['level'], message: string) {
  getDb().prepare(`
    INSERT INTO task_logs (task_id, agent_id, level, message) VALUES (?, ?, ?, ?)
  `).run(taskId, agentId, level, message)
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
