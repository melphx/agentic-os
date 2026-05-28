# ⬡ Claude OS — Mission Control

A gorgeous, dopamine-inducing AI operating system for managing Claude and your agent fleet.  
Built with **Next.js 14**, **Tailwind CSS**, and **Framer Motion**.

---

## Quick Start

### 1. Prerequisites

- Node.js 18+ — [nodejs.org](https://nodejs.org)
- An Anthropic API key — [console.anthropic.com](https://console.anthropic.com)

### 2. Install dependencies

```bash
cd claude-os
npm install
```

### 3. Add your API key

```bash
cp .env.local.example .env.local
```

Open `.env.local` and replace the placeholder with your real key:

```
ANTHROPIC_API_KEY=sk-ant-api03-your-actual-key-here
```

> **Alternatively** — skip `.env.local` and enter your key directly in the app  
> via **Settings** (gear icon in the sidebar). It's saved to localStorage.

### 4. Run

```bash
npm run dev
```

Open **http://localhost:3000** — you'll see Mission Control.

---

## Features

| Panel | What it does |
|---|---|
| **Dashboard** | Live metrics, 6-agent fleet cards, real-time activity stream |
| **Agents** | Deep-dive view for each agent — tasks, tokens, uptime, progress |
| **Tasks** | Prioritised task queue across all agents |
| **Terminal** | ASCII art terminal with real commands (`help`, `status`, `agents`, `deploy`) |
| **Settings** | API key + model selector, saved to localStorage |
| **Chat** | Right-side panel — direct conversation with Claude, fully wired to the API |

---

## Customising Agents

Edit the `AGENTS` array in `src/app/page.tsx` to add real agents or change the demo data.  
Each agent card supports: name, description, icon, status, current task, tokens, progress, and a custom accent colour.

---

## Tech Stack

- **Next.js 14** (App Router)
- **Tailwind CSS** — utility-first styling
- **Framer Motion** — all animations and transitions
- **Lucide React** — icon set
- **Anthropic SDK** — Claude API integration
- **Canvas API** — particle & grid background

---

## Build for Production

```bash
npm run build
npm start
```

---

*Made with Claude · Anthropic*
