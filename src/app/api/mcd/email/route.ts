/**
 * /api/mcd/email — send a saved MCD report via N8N email webhook
 *
 * POST { report_id: number }
 *   Fetches the report, renders it as a styled HTML email, and POSTs
 *   the payload to MCD_N8N_EMAIL_WEBHOOK. N8N handles actual sending.
 */

import { NextRequest, NextResponse } from 'next/server'
import { sendMcdEmail } from '@/lib/mcd-email'

export async function POST(req: NextRequest) {
  try {
    const { report_id } = await req.json() as { report_id: number }
    if (!report_id) {
      return NextResponse.json({ error: 'report_id is required' }, { status: 400 })
    }
    const result = await sendMcdEmail(report_id)
    if (!result.ok) {
      const status = result.error?.includes('not configured') ? 503
                   : result.error?.includes('not found')     ? 404
                   : 502
      return NextResponse.json({ error: result.error }, { status })
    }
    return NextResponse.json({ ok: true, message: result.message, subject: result.subject })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
