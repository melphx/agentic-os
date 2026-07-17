import { NextResponse } from 'next/server'
import { updateMcdMemory, deleteMcdMemory } from '@/lib/db'

type Params = { params: { id: string } }

export async function PATCH(req: Request, { params }: Params) {
  try {
    const id = parseInt(params.id, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    const body = await req.json()
    const value      = typeof body.value      === 'string'  ? body.value.slice(0, 500) : null
    const importance = [1, 2, 3].includes(body.importance) ? body.importance           : null

    if (value === null || importance === null) {
      return NextResponse.json({ error: 'value and importance required' }, { status: 400 })
    }

    updateMcdMemory(id, value, importance as 1 | 2 | 3)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const id = parseInt(params.id, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

    deleteMcdMemory(id)
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
