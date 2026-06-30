/**
 * /api/mcd/connector — executes a PHR MCD Python connector script
 * and returns its JSON output.
 *
 * POST body:
 *   { connector: 'ghl'|'ga4'|'gsc'|'gtm'|'wp'|'initiatives', args: string[] }
 *
 * Connectors that need the venv python (Google auth):
 *   ga4, gsc, gtm, initiatives
 * Connectors that use system python3 (stdlib only):
 *   ghl, wp
 *
 * All credentials are read from the server environment — never from the request.
 * This route is auth-gated via middleware (cookie required).
 */

import { NextRequest, NextResponse } from 'next/server'
import { spawn } from 'child_process'
import path from 'path'

const SCRIPTS_DIR = process.env.MCD_SCRIPTS_DIR || '/root/agentic-os/mcd/scripts'
const VENV_PYTHON = process.env.MCD_VENV_PYTHON || '/root/agentic-os/mcd/venv/bin/python3'

// Map connector name → { script, python }
const CONNECTORS: Record<string, { script: string; useVenv: boolean }> = {
  ghl:         { script: 'ghl_client.py',          useVenv: false },
  ga4:         { script: 'ga4_client.py',           useVenv: true  },
  gsc:         { script: 'gsc_client.py',           useVenv: true  },
  gtm:         { script: 'gtm_client.py',           useVenv: true  },
  wp:          { script: 'wp_client.py',            useVenv: false },
  initiatives: { script: 'initiatives_client.py',   useVenv: true  },
}

function runScript(
  python: string,
  scriptPath: string,
  args: string[],
  env: Record<string, string>
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn(python, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      timeout: 60_000, // 60s per connector call
    })

    proc.stdout.on('data', (d) => { stdout += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 })
    })

    proc.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, exitCode: 1 })
    })
  })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { connector, args = [] } = body as { connector: string; args: string[] }

    if (!connector || !CONNECTORS[connector]) {
      return NextResponse.json(
        { error: `Unknown connector: ${connector}. Valid: ${Object.keys(CONNECTORS).join(', ')}` },
        { status: 400 }
      )
    }

    const { script, useVenv } = CONNECTORS[connector]
    const scriptPath = path.join(SCRIPTS_DIR, script)
    const python = useVenv ? VENV_PYTHON : 'python3'

    // Pass all MCD env vars to the subprocess — they live in process.env via .env.local
    const connectorEnv: Record<string, string> = {}
    const passthrough = [
      'GHL_API_KEY', 'GHL_LOCATION_ID',
      'GA4_SA_JSON', 'GA4_PROPERTY_ID', 'GA4_KEYWORD_HERO_PROPERTY_ID',
      'GA4_KH_KEYWORD_DIMENSION', 'GA4_FORM_EVENT',
      'GSC_SA_JSON', 'GSC_SITE_URL',
      'GTM_SA_JSON', 'GTM_ACCOUNT_ID', 'GTM_CONTAINER_ID',
      'INITIATIVES_SA_JSON', 'INITIATIVES_DOC_ID',
    ]
    for (const key of passthrough) {
      if (process.env[key]) connectorEnv[key] = process.env[key]!
    }

    const { stdout, stderr, exitCode } = await runScript(python, scriptPath, args, connectorEnv)

    if (exitCode !== 0) {
      return NextResponse.json(
        { error: `Connector ${connector} exited ${exitCode}`, detail: stderr.slice(0, 2000) },
        { status: 500 }
      )
    }

    // Parse JSON from stdout (connectors always return JSON)
    let data: unknown
    try {
      data = JSON.parse(stdout)
    } catch {
      // Return raw text if not valid JSON
      data = { raw: stdout }
    }

    return NextResponse.json({ connector, args, data })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// GET — list available connectors and their status
export async function GET() {
  return NextResponse.json({
    connectors: Object.entries(CONNECTORS).map(([name, { useVenv }]) => ({
      name,
      script: CONNECTORS[name].script,
      python: useVenv ? 'venv' : 'system',
      script_path: path.join(SCRIPTS_DIR, CONNECTORS[name].script),
    })),
    scripts_dir: SCRIPTS_DIR,
    venv_python: VENV_PYTHON,
  })
}
