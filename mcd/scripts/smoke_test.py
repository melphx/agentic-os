#!/usr/bin/env python3
"""PHR MCD smoke test (spec Section 15): pull one known metric per connector,
print it beside the date range, report PASS / FAIL / SKIP. Read-only. Re-runnable."""
import subprocess, json, os, urllib.request

P = "/root/.hermes/profiles/mcd"; SK = f"{P}/skills"
SYS = "python3"; VENV = "/usr/local/lib/hermes-agent/venv/bin/python3"
FROM, TO = "2026-06-15", "2026-06-21"
ok = True

def run(cmd):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        return p.returncode, p.stdout, p.stderr
    except Exception as e:
        return 1, "", str(e)

def report(name, status, detail):
    global ok
    if status == "FAIL": ok = False
    print(f"  {status:5s} {name:20s} {detail}")

def check(name, cmd, extract, required=True):
    rc, out, err = run(cmd)
    try: d = json.loads(out)
    except Exception: d = None
    if rc == 0 and d is not None:
        try: report(name, "PASS", extract(d)); return
        except Exception as e: report(name, "FAIL", f"parse error: {e}"); return
    tail = (err.strip() or out.strip() or "no output").splitlines()
    report(name, "FAIL" if required else "SKIP", (tail[-1] if tail else "")[:110])

def mcp_check():
    url = os.environ.get("SEOUTILS_MCP_URL", "http://localhost:19515/mcp")
    tok = os.environ.get("MCP_SEO_UTILS_API_KEY", "")
    def post(body, sid=None):
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
              headers={"Content-Type": "application/json",
                       "Accept": "application/json, text/event-stream",
                       "Authorization": "Bearer " + tok})
        if sid: req.add_header("Mcp-Session-Id", sid)
        r = urllib.request.urlopen(req, timeout=30)
        return r.headers.get("Mcp-Session-Id"), r.read().decode()
    try:
        sid, _ = post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                  "clientInfo": {"name": "smoke", "version": "1"}}})
        post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        _, raw = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, sid)
        p = json.loads(raw) if raw.strip().startswith("{") else None
        if p is None:
            for ln in raw.splitlines():
                if ln.strip().startswith("data:"):
                    try: p = json.loads(ln.strip()[5:].strip())
                    except Exception: pass
        n = len(p["result"]["tools"]) if p and p.get("result") else "?"
        report("seoutils-mcp", "PASS", f"MCP reachable via tunnel, tools={n}")
    except Exception as e:
        report("seoutils-mcp", "FAIL", f"tunnel/MCP unreachable: {str(e)[:80]}")

print(f"=== PHR MCD smoke test  |  window {FROM}..{TO} ===")
check("ghl-reader", [SYS, f"{SK}/ghl-reader/scripts/ghl_client.py", "leads", "--from", FROM, "--to", TO],
      lambda d: f"New Qualified Leads={d.get('qualified_lead_count')} of {d.get('total_contacts_created')} contacts [{FROM}..{TO}]")
check("ga4-reader", [VENV, f"{SK}/ga4-reader/scripts/ga4_client.py", "channels", "--from", FROM, "--to", TO],
      lambda d: f"{d['rows'][0]['sessionDefaultChannelGroup']} sessions={d['rows'][0]['sessions']} [{FROM}..{TO}]")
check("gsc-reader", [VENV, f"{SK}/gsc-reader/scripts/gsc_client.py", "wow", "--week-ending", TO],
      lambda d: f"clicks this week={d['rows'][0]['clicks_this_week']} [wk ending {TO}]")
check("gtm-reader", [VENV, f"{SK}/gtm-reader/scripts/gtm_client.py", "live"],
      lambda d: f"live tags={d['counts']['tags']} (version: {d.get('version_name')})")
check("initiatives-reader", [VENV, f"{SK}/initiatives-reader/scripts/initiatives_client.py", "priorities"],
      lambda d: f"mode={d.get('mode')} sections={d.get('section_count')}")
check("wp-rankmath-reader", [SYS, f"{SK}/wp-rankmath-reader/scripts/wp_client.py", "content", "--modified-after", "2026-06-01"],
      lambda d: f"items={d.get('count')}", required=False)
check("call-feedback-reader", [VENV, f"{SK}/call-feedback-reader/scripts/calls_client.py", "ratings", "--from", FROM, "--to", TO],
      lambda d: f"justin rated calls={d.get('rated_calls')} avg={d.get('avg_rating')} [{FROM}..{TO}]")
mcp_check()
check("wp-rankmath-reader:analytics", [SYS, f"{SK}/wp-rankmath-reader/scripts/wp_client.py", "analytics"],
      lambda d: f"RankMath live, keys={len((d.get('analytics') or {}))}")

check("sales-sheet-reader", [VENV, f"{SK}/sales-sheet-reader/scripts/sales_sheet_client.py", "baselines", "--year", "2026"],
      lambda d: f"PHR sales sheet readable, baseline rows={len((d.get('baselines') or {}))}")

check("client-survey-reader", [VENV, f"{SK}/client-survey-reader/scripts/survey_client.py", "summary"],
      lambda d: f"survey readable, respondents={d.get('respondents')}, latest={d.get('latest')}")

check("spend-reader", [VENV, f"{SK}/spend-reader/scripts/spend_client.py", "months"],
      lambda d: f"spend sheet readable, months={len(d.get('months') or [])}")

check("google-ads-reader", [VENV, f"{SK}/google-ads-reader/scripts/gads_client.py", "status"],
      lambda d: "CONFIGURED" if d.get("configured") else f"built, not connected yet ({len(d.get('missing') or [])} items outstanding)")

check("fireflies-reader", [SYS, f"{SK}/fireflies-reader/scripts/fireflies_client.py", "meetings", "--from", "2026-07-01", "--to", "2026-08-22", "--type", "proposal"],
      lambda d: f"Fireflies live, proposal reviews={d.get('count')}")

print("=== RESULT:", "ALL REQUIRED CONNECTORS PASSED ===" if ok else "SOME REQUIRED CONNECTORS FAILED ===")
import sys; sys.exit(0 if ok else 1)
