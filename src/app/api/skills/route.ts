import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { getAllSkills, createSkill, deleteSkill } from '@/lib/db'
import OpenAI from 'openai'

export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  return NextResponse.json(getAllSkills())
}
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  const b = await req.json()
  if (b.action === 'test') {
    try {
      const client = new OpenAI({ baseURL: b.base_url, apiKey: b.api_key || 'none', timeout: 15000 })
      const r = await client.chat.completions.create({ model: b.model, max_completion_tokens: 10, messages: [{ role: 'user', content: 'say hi' }] })
      return NextResponse.json({ ok: true, response: r.choices[0].message.content })
    } catch (e: any) { return NextResponse.json({ ok: false, error: e.message }) }
  }
  if (b.action === 'call') {
    try {
      const client = new OpenAI({ baseURL: b.base_url, apiKey: b.api_key || 'none', timeout: 30000 })
      const messages: any[] = []
      if (b.system_prompt) messages.push({ role: 'system', content: b.system_prompt })
      messages.push({ role: 'user', content: b.prompt })
      const r = await client.chat.completions.create({ model: b.model, max_completion_tokens: 2048, messages })
      return NextResponse.json({ ok: true, content: r.choices[0].message.content, tokens: r.usage?.total_tokens || 0 })
    } catch (e: any) { return NextResponse.json({ ok: false, error: e.message }) }
  }
  const skill = createSkill({ name: b.name, description: b.description, base_url: b.base_url, api_key: b.api_key || '', model: b.model, system_prompt: b.system_prompt || '', enabled: 1 })
  return NextResponse.json(skill, { status: 201 })
}
export async function DELETE(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error
  deleteSkill(parseInt(req.nextUrl.searchParams.get('id') || '0'))
  return NextResponse.json({ ok: true })
}
