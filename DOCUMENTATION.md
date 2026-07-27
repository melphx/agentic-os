# Claude OS — Complete Documentation

**Claude OS** is an AI agent control center built for Phoenix Home Remodeling. It lets you create, train, and manage AI agents that can research, write, automate, and connect to your existing tools — all from one dashboard.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [The Dashboard](#the-dashboard)
3. [Agents](#agents)
4. [Running Tasks](#running-tasks)
5. [Training an Agent](#training-an-agent)
6. [Integrations](#integrations)
7. [Pipelines](#pipelines)
8. [Analytics](#analytics)
9. [Schedules](#schedules)
10. [API Access](#api-access)
11. [Settings](#settings)
12. [Deployment & Server](#deployment--server)
13. [Troubleshooting](#troubleshooting)
14. [Feature Roadmap](#feature-roadmap)

---

## Getting Started

### Accessing the App

Open your browser and go to:
```
https://ai.phoenixhomeremodeling.net
```

You'll be prompted to log in. Use the credentials set in your `.env.local` file on the server (`ADMIN_EMAIL` and `ADMIN_PASSWORD`).

### First Time Setup

1. Log in to the dashboard
2. You'll see 6 default agents ready to use
3. Go to **Settings** and generate your first API key if you plan to connect GHL or N8N
4. Open any agent and go to the **Train** tab to add a system prompt and upload files

---

## The Dashboard

The main screen shows you everything at a glance:

- **Active agents** — how many agents are currently running tasks
- **Tasks completed** — total tasks done across all agents
- **Tokens used** — how much AI processing has been consumed
- **Recent activity** — a live feed of what your agents are doing

The **left sidebar** is your main navigation:

| Icon | Section | What it's for |
|------|---------|---------------|
| Grid | Dashboard | Overview and activity feed |
| Robot | Agents | View and manage all agents |
| List | Tasks | See all tasks across all agents |
| Branch | Pipelines | Chain agents together |
| Chart | Analytics | Stats, costs, performance |
| Terminal | Terminal | Command-line interface |
| Clock | Schedules | Recurring automated tasks |
| Settings | Settings | API keys, configuration |

The **right side** has a chat panel called **Hermes** — your AI assistant that controls the whole system. You can type natural language commands like "Run the research agent on Phoenix home remodeling competitors" and it will create and dispatch the task for you.

---

## Agents

### Default Agents

Claude OS comes with 6 pre-built agents:

| Agent | What it does |
|-------|-------------|
| **Research Agent** | Web research, data gathering, summarisation |
| **Code Engineer** | Write, debug, and review code |
| **Data Analyst** | Analyse data, write SQL, create reports |
| **Content Writer** | Blog posts, emails, marketing copy |
| **Email Manager** | Draft and manage email communications |
| **Security Analyst** | Vulnerability scanning, threat analysis |

### Viewing an Agent

Click any agent card to open its detail view. You'll see three tabs on the left:

- **Tasks** — all tasks this agent has run, click any to open the full conversation
- **Train** — upload knowledge files and edit the agent's system prompt
- **Tools** — configure external integrations like GHL, N8N, webhooks

The right panel shows the selected task thread or the train/tools panel.

### Creating a New Agent

Use the Hermes chat panel and type:
> "Create a new agent called Lead Qualifier that specialises in qualifying home remodeling leads"

Hermes will create the agent immediately. You can then go to its Train tab to customise it.

### Agent Status

Each agent shows a status indicator:

- 🟢 **Active** — currently running a task
- ⚪ **Idle** — ready to accept tasks
- 🔴 **Error** — last task failed
- ⚫ **Offline** — not available

---

## Running Tasks

### From the Agent View

1. Click on an agent
2. Click the **+ New Task** button in the top of the left sidebar
3. Fill in the task title and description
4. Choose a task type (see below)
5. Set priority (High / Normal / Low)
6. Click **Run Task**

### Task Types

| Type | Best for |
|------|---------|
| **General** | Writing, analysis, Q&A, anything conversational |
| **Search** | Research tasks that need live web information |
| **Browser** | Tasks that require visiting and reading a website |
| **Code** | Writing or executing scripts and programs |
| **Scrape** | Extracting data from a specific URL |
| **File** | Reading or writing files on the server |
| **API** | Making HTTP requests to external services |
| **Security** | Running security scans on a target |

### Watching a Task Run

When a task starts, the right panel shows the conversation thread. You'll see the result **stream in as it's being written** — you don't have to wait until it's done.

A task can have these statuses:

- **Pending** — queued, waiting to start
- **Running** — actively being processed (you'll see the response streaming)
- **Completed** — finished successfully, result is shown
- **Failed** — something went wrong, error message is shown
- **Cancelled** — you or the system stopped it

### Cancelling a Task

If a task is running or pending, a red **✕ Cancel** button appears in the task header. Click it to stop the task immediately.

### Refining Results

Once a task is completed, a chat input appears at the bottom of the task thread. You can type follow-up messages like:

> "Make it shorter"
> "Focus more on the pricing section"
> "Rewrite this in a more casual tone"

The agent will respond in the same thread, and your conversation history is saved — even if you click away and come back.

### Copying and Exporting Results

In the task header you'll find:
- **Copy** button — copies the result to your clipboard
- **Export** button — downloads the result as a `.md` (Markdown) file

---

## Training an Agent

Training tells the agent who it is, what it knows, and how it should behave. There are two parts:

### System Prompt

The system prompt is the agent's core instructions. It shapes every single response it gives.

**To edit it:**
1. Click on an agent
2. Go to the **Train** tab
3. Scroll down to **System Prompt**
4. Edit the text and click **Save Prompt**

The prompt is saved to the server immediately and affects the agent's very next task.

**Example system prompt for a home remodeling sales agent:**
```
You are a sales specialist for Phoenix Home Remodeling. You understand our 
service areas across Phoenix, Scottsdale, and surrounding cities. Our services 
include kitchen remodeling, bathroom renovation, room additions, and flooring. 
Always be professional, empathetic, and focus on understanding the customer's 
vision before discussing costs. When analysing leads, prioritise homeowners 
with budgets above $15,000.
```

### Knowledge Base (File Upload)

You can upload files that the agent will reference in every task. Think of it as giving the agent a reference library.

**Supported file types:** PDF, TXT, CSV, JSON, HTML, Markdown (.md)

**To upload:**
1. Go to the **Train** tab
2. Drag and drop files into the upload area, or click to browse
3. Files are processed and stored — you'll see them listed with filename, size, and upload date

**Good things to upload:**
- Your service catalogue or price list
- GHL pipeline export as CSV
- FAQs document
- Service area descriptions
- Past project case studies
- Company policies or procedures

**File size limit:** 2MB per file. For larger files, split them into sections.

### How Training Affects Tasks

When an agent runs a task:
1. Its system prompt is loaded first
2. Uploaded knowledge files are injected into context
3. Recent task memory (last 5 summaries) is added
4. Active integrations are listed as available tools
5. Then the task description is processed

---

## Integrations

Integrations let your agents connect to external services — reading data from GHL, triggering N8N workflows, writing to Google Sheets, and more.

### Setting Up an Integration

1. Click on an agent
2. Go to the **Tools** tab (the ⚡ icon in the sidebar)
3. Click **Add** in the top right
4. Choose a type, fill in the details, click **Save Integration**

### Available Integration Types

#### Webhook / N8N
For calling any HTTP endpoint or triggering an N8N workflow.

| Field | Description |
|-------|-------------|
| URL | The webhook URL |
| Method | GET or POST (usually POST) |
| API Key | Optional Bearer token for auth |
| Body Template | Optional JSON template to send |

**N8N example:** Set URL to your N8N webhook URL. When the agent calls it, N8N fires and can do anything — send an email, update a CRM, send a Slack message.

#### GHL Read
Reads data from your GoHighLevel account.

| Field | Description |
|-------|-------------|
| GHL API Key | From GHL Settings → API |
| Location ID | Your GHL location/sub-account ID |
| Resource | `contacts`, `opportunities`, `pipelines`, `conversations`, `calendars` |
| Limit | How many records to fetch (default 20) |

#### GHL Write
Creates or updates records in GoHighLevel.

| Field | Description |
|-------|-------------|
| GHL API Key | From GHL Settings → API |
| Location ID | Your GHL location ID |
| Action | `create_contact`, `add_note`, or `create_opportunity` |

#### Google Sheets
Read from or write to a Google Spreadsheet.

| Field | Description |
|-------|-------------|
| Spreadsheet ID | The ID from the Google Sheets URL |
| Range | Cell range e.g. `Sheet1!A1:Z100` |
| Action | `read` or `write` |
| Service Account JSON | JSON credentials from Google Cloud Console |

#### Google Docs
Read from or append text to a Google Doc.

| Field | Description |
|-------|-------------|
| Document ID | The ID from the Google Docs URL |
| Action | `read` or `append` |
| Service Account JSON | JSON credentials from Google Cloud Console |

#### Obsidian Vault
Connect to your Obsidian notes.

| Field | Description |
|-------|-------------|
| REST API URL | URL of the Obsidian Local REST API plugin (via ngrok) |
| API Key | Key from the REST API plugin settings |
| Vault Path | Path on the server if synced via git (e.g. `/root/my-vault`) |
| Default Action | `search`, `read`, `write`, `append`, or `list` |

### How Agents Use Integrations

When an agent has integrations configured, it automatically knows they exist. If a task description mentions something relevant — like "get the latest GHL contacts" or "trigger the lead follow-up workflow" — the agent will call the integration using the syntax:

```
{{CALL:Integration Name:{"key":"value"}}}
```

The result comes back to the agent, which then uses it to complete the task. An agent can make up to 3 integration calls per task.

### Testing an Integration

Click the **▶ Test** button on any integration card to fire it with an empty payload and see the response. Green means it worked. Red shows the error.

---

## Pipelines

Pipelines let you chain multiple agents together so the output of one becomes the input of the next.

**Example pipeline:**
```
Step 1: Research Agent → "Research the top 5 home remodeling trends in Phoenix"
Step 2: Content Writer → "Write a blog post based on the research above"
Step 3: Email Manager → "Draft a newsletter email from this blog post"
```

### Creating a Pipeline

1. Go to **Pipelines** in the sidebar
2. Click **New Pipeline**
3. Give it a name and optional description
4. Add steps:
   - Choose which agent runs each step
   - Set the task title and description
   - Use `{{variable_name}}` for dynamic inputs (filled in at run time)
   - Toggle "Pass previous step output" to feed results forward
5. Click **Create Pipeline**

### Running a Pipeline

Click the **▶ Run** button on a pipeline card. Steps execute one at a time, in order. Each completed step feeds its output into the next step's context.

You can watch individual task threads in the Agents view to see each step's progress.

### Variables

Use `{{variable}}` placeholders in step descriptions. When you run a pipeline programmatically via the API, pass variable values in the request body:

```json
{
  "variables": {
    "lead_name": "John Smith",
    "property_address": "123 Main St, Phoenix"
  }
}
```

---

## Analytics

The Analytics view shows you how your agents are performing.

**Available metrics:**

- **Total Tasks** — all tasks ever run
- **Success Rate** — percentage that completed without error
- **Tokens Used** — total AI tokens consumed
- **Estimated Cost** — approximate dollar cost based on token usage
- **Average Duration** — how long tasks typically take
- **Failed** — tasks that errored

**Charts and breakdowns:**

- **14-day task chart** — bar chart showing task volume per day
- **By Agent** — which agents are doing the most work
- **By Type** — breakdown of task types (general, search, browser, etc.)

---

## Schedules

Schedules let you run tasks automatically on a recurring basis without any manual input.

### Creating a Schedule

1. Go to **Schedules** in the sidebar
2. Click **New Schedule**
3. Fill in:
   - **Agent** — which agent runs the task
   - **Title** — name of the scheduled task
   - **Description** — what the agent should do
   - **Type** — task type
   - **Cron expression** — when to run it

### Cron Expression Guide

Cron expressions follow the format: `minute hour day month weekday`

| Expression | Meaning |
|-----------|---------|
| `0 9 * * *` | Every day at 9:00 AM |
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 9,17 * * *` | Every day at 9 AM and 5 PM |
| `0 8 1 * *` | First day of every month at 8 AM |
| `*/30 * * * *` | Every 30 minutes |

### Managing Schedules

Each schedule card shows:
- Next scheduled run time
- Last run time
- Enable/disable toggle

---

## API Access

You can trigger your agents from external systems — GoHighLevel workflows, N8N automations, Zapier, Make, or any tool that can send an HTTP request.

### Getting an API Key

1. Go to **Settings**
2. Under **API Keys**, type a name for the key (e.g. "GHL Webhook")
3. Click **Generate Key**
4. **Copy the key immediately** — it's only shown once

### Triggering a Task

Send a POST request to your trigger endpoint:

```
POST https://ai.phoenixhomeremodeling.net/api/trigger
```

**Headers:**
```
x-api-key: cos_live_your_key_here
Content-Type: application/json
```

**Body:**
```json
{
  "agent_id": "writer",
  "title": "Write follow-up email",
  "description": "Write a follow-up email for a new lead named John Smith who is interested in kitchen remodeling. Budget: $25,000.",
  "type": "general",
  "priority": 1
}
```

**Response:**
```json
{
  "ok": true,
  "task_id": 42,
  "status": "queued"
}
```

### Agent IDs

| Agent | ID to use |
|-------|-----------|
| Research Agent | `research` |
| Code Engineer | `code` |
| Data Analyst | `data` |
| Content Writer | `writer` |
| Email Manager | `email` |
| Security Analyst | `security` |

Custom agents use the name lowercased with spaces replaced by dashes (e.g. "Lead Qualifier" → `lead-qualifier`).

### Priority Values

| Value | Meaning |
|-------|---------|
| `1` | High — runs first |
| `2` | Normal — default |
| `3` | Low — runs last |

---

## Settings

### API Keys
Generate and manage API keys for external integrations. Keys are hashed on the server — the full key is only shown once at creation time.

### Model Configuration
The AI model used by all agents is set in the server's `.env.local` file:
```
OPENAI_MODEL=gpt-5.4
```

Restart the server after changing this value.

---

## Deployment & Server

### Server Details

| Item | Value |
|------|-------|
| Provider | VPS |
| Domain | ai.phoenixhomeremodeling.net |
| App Directory | `/root/agentic-os` |
| Database | `/root/agentic-os/data/claude-os.db` |
| Process Manager | PM2 |
| Port | 7432 (proxied via Nginx on 443) |

### Environment Variables

Located at `/root/agentic-os/.env.local`:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Your OpenAI API key |
| `OPENAI_MODEL` | Model to use (e.g. `gpt-5.4`) |
| `OPENAI_BASE_URL` | API endpoint (default: OpenAI) |
| `JWT_SECRET` | Secret for login tokens |
| `ADMIN_EMAIL` | Login email |
| `ADMIN_PASSWORD` | Login password |
| `INTERNAL_URL` | Internal server URL (default: `http://localhost:3000`) |
| `TAVILY_API_KEY` | For web search tasks |
| `DB_PATH` | Custom database directory |

### Deploying Updates

```bash
# On the VPS
cd /root/agentic-os
git pull
npm run build
pm2 restart claude-os
```

### Useful Server Commands

```bash
# View live logs
pm2 logs claude-os

# Check status
pm2 status

# Restart the app
pm2 restart claude-os

# Stop the app
pm2 stop claude-os

# Clear stuck tasks
node -e "
const db = require('better-sqlite3')('data/claude-os.db');
db.prepare(\"UPDATE tasks SET status='failed', error='Manually cleared', completed_at=datetime('now') WHERE status='running' OR status='pending'\").run();
db.prepare(\"UPDATE agents SET status='idle', current_task=NULL, progress=0\").run();
console.log('Done');
"
```

### Database Backup

```bash
# On the VPS — create a backup
cp /root/agentic-os/data/claude-os.db /root/agentic-os/data/claude-os-backup-$(date +%Y%m%d).db
```

---

## Troubleshooting

### Task is stuck on "Running"

The task runner crashed mid-execution. Run the clear command above under Useful Server Commands, then retry the task.

### Build fails with TypeScript errors

Usually a truncated file. Check which file is mentioned in the error, then:
```bash
cd /root/agentic-os
git checkout -- src/path/to/file.ts
git pull
npm run build
```

### Agent says it doesn't know about uploaded files

1. Check the file was actually saved:
```bash
cd /root/agentic-os
node -e "const db = require('better-sqlite3')('data/claude-os.db'); console.log(db.prepare('SELECT id, agent_id, filename, length(content) as chars FROM agent_knowledge').all())"
```
2. If the `chars` value is small (under 100), the file wasn't extracted properly. Delete it and re-upload.
3. Make sure you're uploading to the correct agent.

### OpenAI API errors

Test the connection directly:
```bash
cd /root/agentic-os
export $(grep -E "^OPENAI_API_KEY|^OPENAI_MODEL" .env.local | xargs)
node -e "
const OpenAI = require('openai').default;
new OpenAI({ apiKey: '${OPENAI_API_KEY}', timeout: 10000 })
  .chat.completions.create({ model: '${OPENAI_MODEL}', max_completion_tokens: 5, messages:[{role:'user',content:'hi'}] })
  .then(r => console.log('✅', r.choices[0].message.content))
  .catch(e => console.error('❌', e.message));
"
```

### Login not working

Check your credentials in `.env.local`:
```bash
grep -E "ADMIN_EMAIL|ADMIN_PASSWORD" /root/agentic-os/.env.local
```

---

## Feature Roadmap

Features planned for future development:

**Agent Intelligence**
- Long-term vector memory — agents remember context across weeks
- Agent-to-agent communication — agents collaborate on complex tasks
- Confidence scoring — agent flags uncertainty and requests human review
- Auto-retry with different approach on failure

**Automation**
- Event triggers — fire pipelines automatically when GHL gets a new lead
- Conditional pipeline branching — if/else logic between steps
- Webhook notifications — POST results to external systems on completion

**Knowledge & Training**
- Semantic search across knowledge base
- Live data sources — connect GHL or Google Drive as always-fresh knowledge
- Auto-learning from completed tasks

**UI & Experience**
- Bulk task dispatch from CSV
- Voice input for task creation
- Mobile app with push notifications
- Side-by-side result comparison

**Platform**
- Multi-user with role-based access
- Per-agent token budgets and cost limits
- Audit log
- White-label support

**Integrations**
- OpenClaw bridge — access 100+ built-in skills
- Slack/WhatsApp bot
- Zapier / Make native connector
- Auto-write task results to GHL contact notes

---

*Last updated: June 2026*
*Built for Phoenix Home Remodeling*
