import { NextResponse } from 'next/server'
import { getMcdMemoriesForRetrieval } from '@/lib/db'

export async function GET() {
  try {
    const memories = getMcdMemoriesForRetrieval()
    return NextResponse.json({ memories })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
