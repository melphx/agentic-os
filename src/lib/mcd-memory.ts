/**
 * mcd-memory.ts — Dynamic semantic memory for MCD.
 *
 * Two responsibilities:
 *
 * 1. EXTRACTION (background, after each exchange)
 *    extractAndStoreMemory(convId) — reads recent messages, calls LLM to
 *    extract structured facts, batch-embeds them, upserts into mcd_memory.
 *
 * 2. RETRIEVAL (at query time, before building system prompt)
 *    getRelevantMemoriesBlock(query, topK) — embeds the user's message,
 *    scores all stored memories by cosine similarity + importance, returns
 *    a formatted prompt block of the most relevant facts.
 *
 * Embedding model: text-embedding-3-small (1536 dims, ~$0.02/1M tokens)
 * Similarity: cosine, blended with importance weight so critical facts
 *             always surface regardless of query phrasing.
 */

import OpenAI from 'openai'
import {
  getMcdRecentMessages,
  getMcdMemoriesForRetrieval,
  upsertMcdMemory,
  formatMemoryBlock,
  getMcdMemoryBlock,
  type McdMemory,
} from '@/lib/db'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! })
const EMBED_MODEL = 'text-embedding-3-small'

const CATEGORIES = ['preference', 'metric', 'person', 'decision', 'initiative', 'context', 'constraint']

interface ExtractedFact {
  key:        string
  value:      string
  category:   string
  importance: 1 | 2 | 3
}

// ── Embedding helpers ────────────────────────────────────────────────────────

async function embedText(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text })
  return res.data[0].embedding
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts })
  return res.data.map(d => d.embedding)
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, nA = 0, nB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    nA  += a[i] * a[i]
    nB  += b[i] * b[i]
  }
  const denom = Math.sqrt(nA) * Math.sqrt(nB)
  return denom === 0 ? 0 : dot / denom
}

// ── Extraction ───────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a memory extractor for MCD — an AI Marketing and Conversions Director for Phoenix Home Remodeling (PHR).

Given a recent conversation, extract facts MCD should remember for future conversations.

Categories:
- preference: how the user wants data, format, communication style
- metric: KPIs, targets, actuals (CPL, conversion rates, revenue, etc.)
- person: employee roles, names, responsibilities
- decision: strategic choices, tool decisions, priorities chosen
- initiative: current projects, campaigns, active focus areas
- context: business situation, market context, background info
- constraint: limits, blockers, known problems

Rules:
- key: unique, stable, snake_case, descriptive (e.g. "jeremy_prefers_tables", "phr_target_cpl")
- value: one clear factual sentence. No hedging ("might", "seems").
- importance: 1=contextual, 2=operationally useful, 3=critical (affects every response)
- Only extract genuinely new or updated information
- Return valid JSON array only — no markdown, no commentary
- Return [] if nothing worth storing

Output format: [{"key":"...","value":"...","category":"...","importance":2}]`

/**
 * Extract structured memories from a conversation and store with embeddings.
 * Safe to call fire-and-forget — catches all errors.
 */
export async function extractAndStoreMemory(conversationId: number): Promise<void> {
  try {
    const messages = getMcdRecentMessages(conversationId, 16)
    if (messages.length < 2) return

    const transcript = messages.map(m => {
      const cap = m.role === 'assistant' ? 600 : 300
      const c   = m.content.length > cap ? m.content.slice(0, cap) + '…' : m.content
      return `${m.role === 'user' ? 'User' : 'MCD'}: ${c}`
    }).join('\n\n')

    // LLM extraction
    const completion = await openai.chat.completions.create({
      model:                 process.env.OPENAI_MODEL || 'gpt-5.4-mini',
      max_completion_tokens: 600,
      temperature:           0.1,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user',   content: `Conversation:\n\n${transcript}\n\nExtract as JSON array:` },
      ],
    })

    const raw = completion.choices[0]?.message?.content?.trim() ?? ''
    if (!raw || raw === '[]') return

    let facts: ExtractedFact[]
    try {
      facts = JSON.parse(raw)
    } catch {
      const match = raw.match(/\[[\s\S]*\]/)
      if (!match) return
      try { facts = JSON.parse(match[0]) } catch { return }
    }

    if (!Array.isArray(facts) || facts.length === 0) return

    // Validate + sanitize
    const valid = facts.filter(f => f.key && f.value && f.category).map(f => ({
      key:        String(f.key).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 80),
      value:      String(f.value).slice(0, 500),
      category:   CATEGORIES.includes(f.category) ? f.category : 'context',
      importance: ([1, 2, 3].includes(f.importance) ? f.importance : 2) as 1 | 2 | 3,
    }))

    if (valid.length === 0) return

    // Batch-embed all facts in one API call
    const embeddings = await embedBatch(valid.map(f => f.value))

    for (let i = 0; i < valid.length; i++) {
      const f   = valid[i]
      const emb = JSON.stringify(embeddings[i])
      upsertMcdMemory(f.key, f.value, f.category, f.importance, conversationId, emb)
    }
  } catch (e) {
    console.error('[mcd-memory] extraction error:', (e as Error).message)
  }
}

// ── Retrieval ────────────────────────────────────────────────────────────────

/**
 * Retrieve the most relevant memories for a given query using cosine similarity.
 * Critical (importance=3) memories are always included.
 * Returns a formatted prompt block, or '' if memory is empty.
 */
export async function getRelevantMemoriesBlock(
  query: string,
  topK = 15,
): Promise<string> {
  const all = getMcdMemoriesForRetrieval()
  if (all.length === 0) return ''

  // Separate memories: those with embeddings vs those without
  const withEmb:    McdMemory[] = all.filter(m => m.embedding)
  const withoutEmb: McdMemory[] = all.filter(m => !m.embedding)

  if (withEmb.length === 0) {
    // No embeddings yet — fall back to static block
    return getMcdMemoryBlock()
  }

  // Embed the query
  const queryEmb = await embedText(query)

  // Score each embedded memory
  const scored = withEmb.map(m => {
    const emb  = JSON.parse(m.embedding!) as number[]
    const sim  = cosineSim(queryEmb, emb)
    // Blend: 70% semantic similarity + 30% importance signal
    const score = sim * 0.7 + (m.importance / 3) * 0.3
    return { mem: m, score, sim }
  })

  // Always include importance=3, fill remaining slots by score
  const critical  = scored.filter(s => s.mem.importance === 3)
  const rest      = scored
    .filter(s => s.mem.importance < 3 && s.sim > 0.25)   // min relevance threshold
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK - critical.length))

  // Memories without embeddings yet — include importance≥2
  const fallback  = withoutEmb.filter(m => m.importance >= 2)

  const selected  = [...critical, ...rest, ...fallback]
  if (selected.length === 0) return ''

  return formatMemoryBlock(selected.map(s => (s as { mem: McdMemory }).mem ?? s as unknown as McdMemory))
}
