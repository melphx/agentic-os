import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getDb, getEmbeddings, saveEmbedding } from '@/lib/db'
import OpenAI from 'openai'

const client = new OpenAI({ baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY || '', timeout: 30000 })

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { query, limit = 10 } = await req.json()
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  try {
    const embRes = await client.embeddings.create({ model: 'text-embedding-3-small', input: query })
    const queryVec = embRes.data[0].embedding

    const all = getEmbeddings()
    const scores = all.map(e => ({ task_id: e.task_id, score: cosineSim(queryVec, JSON.parse(e.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    const db = getDb()
    const results = scores.map(s => {
      const task = db.prepare('SELECT id,title,status,type,result,created_at,agent_id FROM tasks WHERE id=?').get(s.task_id) as any
      return task ? { ...task, score: Math.round(s.score * 100) } : null
    }).filter(Boolean)

    return NextResponse.json(results)
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

// Index a task result for semantic search
export async function PUT(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const { task_id, text } = await req.json()
  try {
    const embRes = await client.embeddings.create({ model: 'text-embedding-3-small', input: text.slice(0, 8000) })
    saveEmbedding(task_id, embRes.data[0].embedding)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
