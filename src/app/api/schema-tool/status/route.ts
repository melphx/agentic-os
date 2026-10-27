/**
 * /api/schema-tool/status
 * GET  ?ping=1   → site/AI configuration, settings, optional connectivity check
 * POST { auto_apply_max?, rules?, effort?, context?, notes? } → save settings
 */
import { NextRequest, NextResponse } from 'next/server'
import { getAiProvider, getConfig } from '@/lib/schema-tool/config'
import { DEFAULT_CONTEXT, DEFAULT_RULES, getSettings, saveSettings, usageSummary } from '@/lib/schema-tool/store'
import { ping } from '@/lib/schema-tool/wp'
import { fail, guard } from '@/lib/schema-tool/http'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const c = getConfig()
    const ai = getAiProvider()
    const doPing = new URL(req.url).searchParams.get('ping') === '1'
    return NextResponse.json({
      site: { url: c.siteUrl, label: c.siteLabel, prodOrigin: c.prodOrigin, configured: c.configured },
      ai,
      settings: getSettings(),
      usage30d: usageSummary(30),
      defaultRules: DEFAULT_RULES,
      defaultContext: DEFAULT_CONTEXT,
      ping: doPing && c.configured ? await ping() : null,
    })
  } catch (e) { return fail(e) }
}

export async function POST(req: NextRequest) {
  const { error } = await guard(req); if (error) return error
  try {
    const body = await req.json()
    saveSettings({ auto_apply_max: body.auto_apply_max, rules: body.rules, effort: body.effort, context: body.context, notes: body.notes })
    return NextResponse.json({ settings: getSettings() })
  } catch (e) { return fail(e) }
}
