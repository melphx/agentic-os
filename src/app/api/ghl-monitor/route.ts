import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { spawn } from 'child_process'
import pathModule from 'path'
import {
  saveGhlMonitorRun,
  getLatestGhlMonitorRun,
  getGhlMonitorHistory,
} from '@/lib/db'

const SCRIPTS_DIR = process.env.MCD_SCRIPTS_DIR || '/root/agentic-os/mcd/scripts'
const VENV_PYTHON = process.env.MCD_VENV_PYTHON  || '/root/agentic-os/mcd/venv/bin/python3'

function runMonitor(): Promise<{ data: any; ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const proc = spawn(VENV_PYTHON, [pathModule.join(SCRIPTS_DIR, 'ghl_monitor.py')], {
      env: { ...process.env },
      timeout: 120_000,
    })
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d.toString() })
    proc.stderr.on('data', d => { err += d.toString() })
    proc.on('close', code => {
      if (code === 0 && out.trim()) {
        try {
          resolve({ data: JSON.parse(out.trim()), ok: true })
        } catch {
          resolve({ data: null, ok: false, error: 'Invalid JSON from ghl_monitor.py' })
        }
      } else {
        resolve({ data: null, ok: false, error: err.slice(0, 500) || 'No output' })
      }
    })
    proc.on('error', e => resolve({ data: null, ok: false, error: e.message }))
  })
}

// GET — return latest run + recent history
export async function GET(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const action = req.nextUrl.searchParams.get('action')
  if (action === 'history') {
    return NextResponse.json({ runs: getGhlMonitorHistory(20) })
  }
  return NextResponse.json({ run: getLatestGhlMonitorRun() })
}

// POST — trigger a new run
export async function POST(req: NextRequest) {
  const { error } = await requireAuth(req)
  if (error) return error

  const body = await req.json().catch(() => ({}))
  const triggeredBy = body.triggered_by || 'manual'

  const { data, ok, error: runErr } = await runMonitor()
  if (!ok) {
    return NextResponse.json({ error: runErr }, { status: 502 })
  }

  const run = saveGhlMonitorRun({
    run_at:        data.run_at || new Date().toISOString(),
    triggered_by:  triggeredBy,
    status:        data.status || 'error',
    findings_json: JSON.stringify(data.findings || []),
    summary:       data.summary || '',
    duration_ms:   data.duration_ms || 0,
  })

  return NextResponse.json({ ok: true, run })
}
