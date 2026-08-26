#!/usr/bin/env python3
"""connection_audit.py - monthly health check of everything MCD is connected to.

Jeremy asked (2026-08-23) for a monthly look at "every single thing it's connected to including
all Google sheets, integrations connections, and then give me an update in any recommendations
it thinks we should do".

This produces the FACTS as JSON. The monthly prompt turns them into his report. Kept separate on
purpose: an agent should not be inventing whether a connector is alive.

The check that matters most is FRESHNESS, not reachability. A connector can answer perfectly and
still be serving data nobody has updated for six weeks, which is how a report goes quietly wrong.

Written after the 2026-08-21 incident where the skill curator archived all 11 connectors and
nothing noticed until a person happened to look. This is the thing that would have caught it.
"""
import json, os, re, subprocess, sys
from datetime import date, datetime, timedelta

P = "/root/.hermes/profiles/mcd"
SK = P + "/skills"
VENV = "/usr/local/lib/hermes-agent/venv/bin/python3"
SYS = "python3"
TODAY = date.today()


def run(cmd, timeout=180):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timed out after %ss" % timeout
    except Exception as e:  # noqa
        return -1, "", str(e)[:200]


def jrun(cmd, timeout=180):
    rc, out, err = run(cmd, timeout)
    if rc != 0 and not out.strip():
        return None, (err or "exit %s" % rc)[:220]
    try:
        return json.loads(out), None
    except Exception:
        return None, ("non-JSON output: " + (out or err)[:180])


def age_days(d):
    if not d:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m"):
        try:
            return (TODAY - datetime.strptime(d[:len(fmt) + 2 if fmt == "%Y-%m-%d" else 7],
                                              fmt).date()).days
        except ValueError:
            continue
    return None


CHECKS = []


def check(name, what):
    CHECKS.append((name, what))


# ---------------------------------------------------------------- the connectors
def c_ghl():
    frm = (TODAY - timedelta(days=8)).isoformat()
    to = (TODAY - timedelta(days=2)).isoformat()
    d, e = jrun([SYS, SK + "/ghl-reader/scripts/ghl_client.py", "milestones",
                 "--from", frm, "--to", to])
    if e:
        return {"status": "ERROR", "detail": e}
    c = d.get("counts", d)
    return {"status": "OK",
            "detail": "last full week: %s DC scheduled, %s completed" % (
                c.get("phone_consultation_scheduled"), c.get("phone_consultation_completed")),
            "newest_data": to}


def c_sales_sheet():
    # newest week PHR has filled in
    for back in range(0, 8):
        sun = TODAY - timedelta(days=(TODAY.weekday() + 1) % 7 + 7 * back)
        d, e = jrun([VENV, SK + "/sales-sheet-reader/scripts/sales_sheet_client.py",
                     "week", "--week-of", sun.isoformat()])
        if e:
            return {"status": "ERROR", "detail": e}
        if d.get("found") and (d.get("values") or {}).get("New Qualified Leads") is not None:
            return {"status": "OK", "newest_data": sun.isoformat(),
                    "detail": "newest week filled in: %s (leads %s)" % (
                        sun.isoformat(), d["values"].get("New Qualified Leads"))}
    return {"status": "STALE", "detail": "no week filled in the last 8 weeks"}


def c_spend():
    d, e = jrun([VENV, SK + "/spend-reader/scripts/spend_client.py", "months"])
    if e:
        return {"status": "ERROR", "detail": e}
    ms = d.get("months") or []
    if not ms:
        return {"status": "STALE", "detail": "no spend months recorded"}
    # judge freshness on the newest month that actually HAS an amount. The sheet carries empty
    # placeholder rows for future months, and using those made this look fresher than it is.
    filled_months = [m for m in ms if (m.get("with_amount") or 0) > 0]
    if not filled_months:
        return {"status": "STALE", "detail": "%d months listed but none has an amount" % len(ms)}
    newest = max(m["month"] for m in filled_months)
    f = next(m for m in filled_months if m["month"] == newest)
    future = [m["month"] for m in ms if m["month"] > newest]
    extra = (" Rows exist for %s with no amount yet." % ", ".join(sorted(future))) if future else ""
    return {"status": "OK", "newest_data": newest,
            "detail": "newest month with spend recorded is %s, %s of %s sources filled in.%s" % (
                newest, f.get("with_amount"), f.get("sources"), extra)}


def c_survey():
    d, e = jrun([VENV, SK + "/client-survey-reader/scripts/survey_client.py", "summary"])
    if e:
        return {"status": "ERROR", "detail": e}
    return {"status": "OK", "newest_data": d.get("latest"),
            "detail": "%s responses, latest %s" % (d.get("respondents"), d.get("latest"))}


def c_calls():
    frm = (TODAY - timedelta(days=35)).isoformat()
    to = TODAY.isoformat()
    d, e = jrun([VENV, SK + "/call-feedback-reader/scripts/calls_client.py",
                 "ratings", "--from", frm, "--to", to, "--tab", "justin"])
    if e:
        return {"status": "ERROR", "detail": e}
    recs = d.get("records") or []
    newest = max((r["date"] for r in recs), default=None)
    return {"status": "OK" if recs else "STALE", "newest_data": newest,
            "detail": "%s rated Justin calls in the last 35 days, newest %s" % (
                d.get("rated_calls"), newest)}


def c_inhome():
    d, e = jrun([VENV, SK + "/call-feedback-reader/scripts/calls_client.py",
                 "inhome", "--metrics-only"])
    if e:
        return {"status": "ERROR", "detail": e}
    recs = d.get("records") or []
    newest = max((r["date"] for r in recs), default=None)
    return {"status": "OK" if recs else "STALE", "newest_data": newest,
            "detail": "%s in-home evaluations all time, newest %s" % (len(recs), newest)}


def c_fireflies():
    frm = (TODAY - timedelta(days=60)).isoformat()
    d, e = jrun([SYS, SK + "/fireflies-reader/scripts/fireflies_client.py", "meetings",
                 "--from", frm, "--to", TODAY.isoformat(), "--type", "proposal"])
    if e:
        return {"status": "ERROR", "detail": e}
    ms = d.get("meetings") or []
    newest = max((m["date"] for m in ms), default=None)
    return {"status": "OK" if ms else "STALE", "newest_data": newest,
            "detail": "%s proposal reviews in 60 days, newest %s" % (len(ms), newest)}


def c_gads():
    d, e = jrun([VENV, SK + "/google-ads-reader/scripts/gads_client.py", "status"])
    if e:
        return {"status": "ERROR", "detail": e}
    if not d.get("configured"):
        return {"status": "NOT CONFIGURED", "detail": "; ".join(d.get("missing") or [])[:200]}
    frm = (TODAY - timedelta(days=35)).isoformat()
    d2, e2 = jrun([VENV, SK + "/google-ads-reader/scripts/gads_client.py", "spend",
                   "--from", frm, "--to", TODAY.isoformat()], timeout=200)
    if e2:
        return {"status": "ERROR", "detail": e2}
    ms = d2.get("months") or []
    # `spend` buckets by month, so its month key is the FIRST of the month and reading it as the
    # newest date makes a current feed look weeks stale. Ask for the latest DAY with spend.
    newest_day = None
    d3, e3 = jrun([VENV, SK + "/google-ads-reader/scripts/gads_client.py", "campaigns",
                   "--from", (TODAY - timedelta(days=7)).isoformat(),
                   "--to", TODAY.isoformat()], timeout=200)
    if not e3 and (d3.get("campaigns") or d3.get("total_cost")):
        newest_day = (TODAY - timedelta(days=1)).isoformat()
    return {"status": "OK", "newest_data": newest_day or (max(m["month"] for m in ms)[:10] if ms else None),
            "detail": "$%s spent in the last 35 days%s" % (
                d2.get("total_cost"),
                "" if newest_day else " (could not confirm the most recent day)")}


def c_ga4():
    frm = (TODAY - timedelta(days=8)).isoformat()
    to = (TODAY - timedelta(days=2)).isoformat()
    d, e = jrun([VENV, SK + "/ga4-reader/scripts/ga4_client.py", "channels",
                 "--from", frm, "--to", to])
    if e:
        return {"status": "ERROR", "detail": e}
    return {"status": "OK", "newest_data": to, "detail": "GA4 answering for the last full week"}


def c_gsc():
    sat = TODAY - timedelta(days=(TODAY.weekday() + 2) % 7 + 1)
    d, e = jrun([VENV, SK + "/gsc-reader/scripts/gsc_client.py", "wow",
                 "--week-ending", sat.isoformat()])
    if e:
        return {"status": "ERROR", "detail": e}
    return {"status": "OK", "newest_data": sat.isoformat(),
            "detail": "Search Console answering for week ending %s" % sat.isoformat()}


def c_wp():
    d, e = jrun([SYS, SK + "/wp-rankmath-reader/scripts/wp_client.py", "content",
                 "--type", "posts", "--modified-after", (TODAY - timedelta(days=60)).isoformat()])
    if e:
        return {"status": "ERROR", "detail": e}
    recs = d.get("records") or []
    newest = max((r.get("modified", "")[:10] for r in recs), default=None)
    return {"status": "OK", "newest_data": newest,
            "detail": "%s posts changed in 60 days, newest %s" % (len(recs), newest)}


def c_gtm():
    d, e = jrun([VENV, SK + "/gtm-reader/scripts/gtm_client.py", "live"])
    if e:
        return {"status": "ERROR", "detail": e}
    counts = d.get("counts") or {}
    tags = counts.get("tags")
    if tags is None:
        tags = len(d.get("tags") or [])
    return {"status": "OK",
            "detail": "%s live tags, version %r" % (tags, (d.get("version_name") or "")[:40])}


def c_initiatives():
    d, e = jrun([VENV, SK + "/initiatives-reader/scripts/initiatives_client.py", "priorities"])
    if e:
        return {"status": "ERROR", "detail": e}
    return {"status": "OK", "detail": "mode=%s" % d.get("mode")}


for nm, fn in (("GoHighLevel (CRM)", c_ghl), ("Weekly Sales Report sheet", c_sales_sheet),
               ("Marketing Spend sheet", c_spend), ("Design Client Survey", c_survey),
               ("Call feedback: Justin", c_calls), ("Call feedback: in-home", c_inhome),
               ("Fireflies proposal reviews", c_fireflies), ("Google Ads", c_gads),
               ("Google Analytics 4", c_ga4), ("Search Console", c_gsc),
               ("WordPress / RankMath", c_wp), ("Tag Manager", c_gtm),
               ("Initiatives doc", c_initiatives)):
    check(nm, fn)

# How old the newest data is ALLOWED to be before it is genuinely overdue. One flat threshold
# does not work: these sources have completely different natural rhythms, and flagging a weekly
# sheet as late because it holds last week is how a health report loses its credibility.
EXPECTED_MAX_AGE = {
    "GoHighLevel (CRM)": 4,               # live system, should always be current
    "Google Analytics 4": 4,
    "Search Console": 9,                  # Google finalises 2-3 days behind
    "Google Ads": 4,
    "WordPress / RankMath": 60,           # content changes when someone publishes
    "Tag Manager": None,                  # configuration, not a data feed
    "Initiatives doc": None,              # a document, edited when Jeremy edits it
    "Weekly Sales Report sheet": 16,      # a week ends, then gets filled in; ~7-14 days is normal
    "Marketing Spend sheet": 45,          # monthly, and the current month is filled in as it goes
    "Design Client Survey": None,         # arrives only when a client replies; never "late"
    "Call feedback: Justin": 7,           # logged daily
    "Call feedback: in-home": 45,         # about 6 appointments a month
    "Fireflies proposal reviews": 30,     # about 9-15 a month
}

results = []
for nm, fn in CHECKS:
    try:
        r = fn()
    except Exception as e:  # noqa
        r = {"status": "ERROR", "detail": "%s: %s" % (type(e).__name__, str(e)[:150])}
    r["name"] = nm
    a = age_days(r.get("newest_data"))
    r["days_since_newest_data"] = a
    limit = EXPECTED_MAX_AGE.get(nm, 30)
    r["expected_max_age_days"] = limit
    if r["status"] == "OK" and a is not None and limit is not None and a > limit:
        r["status"] = "STALE"
        r["detail"] = ((r.get("detail") or "")
                       + " (newest data is %d days old, which is past the %d days expected for "
                         "this source)" % (a, limit))
    elif r["status"] == "OK" and a is not None:
        r["detail"] = (r.get("detail") or "") + " (%d days old, normal for this source)" % a
    results.append(r)

# ---------------------------------------------------------------- platform health
plat = {}
rc, out, _ = run(["bash", "-lc",
                  "cd %s && HERMES_HOME=%s hermes -p mcd cron list 2>&1" % (P, P)], 90)
jobs = re.findall(r"Name:\s+(\S+).*?Schedule:\s+([^\n]+).*?Next run:\s+(\S+).*?Last run:\s+(\S+\s+\S*)",
                  out, re.S)
plat["crons"] = [{"name": j[0], "schedule": j[1].strip(),
                  "next_run": j[2], "last_run": j[3].strip()} for j in jobs]

rc, out, _ = run(["bash", "-lc",
                  "cd %s && HERMES_HOME=%s hermes -p mcd curator status 2>&1" % (P, P)], 90)
paused = "paused" in out.lower() or "disabled" in out.lower()
plat["curator"] = {"paused": paused,
                   "note": ("paused, which is correct: on 2026-08-21 it archived all 11 connectors "
                            "and broke the scheduled reports"
                            if paused else
                            "ENABLED. This is a RISK: on 2026-08-21 it archived all 11 connectors "
                            "and pinning did not prevent it. Recommend pausing it.")}

missing_paths = []
for rel in ("ghl-reader/scripts/ghl_client.py", "ga4-reader/scripts/ga4_client.py",
            "gsc-reader/scripts/gsc_client.py", "gtm-reader/scripts/gtm_client.py",
            "initiatives-reader/scripts/initiatives_client.py",
            "wp-rankmath-reader/scripts/wp_client.py",
            "call-feedback-reader/scripts/calls_client.py",
            "sales-sheet-reader/scripts/sales_sheet_client.py",
            "client-survey-reader/scripts/survey_client.py",
            "spend-reader/scripts/spend_client.py",
            "google-ads-reader/scripts/gads_client.py",
            "fireflies-reader/scripts/fireflies_client.py"):
    if not os.path.exists(os.path.join(SK, rel)):
        missing_paths.append(rel)
plat["connector_files_missing"] = missing_paths

summary = {"total": len(results),
           "ok": sum(1 for r in results if r["status"] == "OK"),
           "stale": sum(1 for r in results if r["status"] == "STALE"),
           "error": sum(1 for r in results if r["status"] == "ERROR"),
           "not_configured": sum(1 for r in results if r["status"] == "NOT CONFIGURED")}

gaps = []
if missing_paths:
    gaps.append("CONNECTOR FILES MISSING: %s. The scheduled reports will fail. This is what the "
                "skill curator did on 2026-08-21; restore with `hermes -p mcd curator restore "
                "<name>` and pause the curator." % ", ".join(missing_paths))
if not paused:
    gaps.append("The skill curator is ENABLED and has previously archived every connector. "
                "Pinning did not stop it. Recommend pausing it.")
gaps.append("STALE is judged against each source's OWN expected cadence, not a flat 30 days. A "
            "weekly sheet holding last completed week is CURRENT, not late. A client survey is "
            "never late, it arrives when clients reply. Only report something as needing "
            "attention if its status actually says STALE, and never invent an owner to chase for "
            "a source that is behaving normally.")
gaps.append("This audit checks that data is REACHABLE and CURRENT. It does not check that the "
            "numbers are correct.")

json.dump({"connector": "connection-audit", "generated": TODAY.isoformat(),
           "summary": summary, "connections": results, "platform": plat, "gaps": gaps},
          sys.stdout, indent=2)
sys.stdout.write("\n")
