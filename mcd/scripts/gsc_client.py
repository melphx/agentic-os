#!/usr/bin/env python3
"""
gsc_client.py - read-only Google Search Console connector for the PHR MCD agent.

MUST run with the Hermes venv Python (system python3 lacks the Google libs):
  /usr/local/lib/hermes-agent/venv/bin/python3 gsc_client.py <command> ...

Shared contract (every command):
  1. Read-only creds from env: GSC_SA_JSON (path to Viewer service-account key),
     GSC_SITE_URL (URL-prefix property or 'sc-domain:example.com').
  2. Structured JSON on stdout.
  3. The raw query + date range echoed back.
  4. Loud failure: any auth/API error prints a JSON error to stderr, exits 1.
  5. Gaps reported as gaps.
  6. Data freshness labeled (GSC lags ~2 days; recent days are partial).

Commands: search | wow | coverage
"""

import argparse
import json
import os
import sys
import urllib.parse
from datetime import datetime, timedelta

GSC_HOST = "https://www.googleapis.com"  # officially documented host for /webmasters/v3
SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
CONNECTOR = "gsc-reader"


class GSCError(Exception):
    def __init__(self, message, status=None, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def _site_url():
    s = os.environ.get("GSC_SITE_URL", "").strip()
    if not s:
        raise GSCError("GSC_SITE_URL is not set in the environment.")
    return s


def _session():
    sa_path = os.environ.get("GSC_SA_JSON", "").strip()
    if not sa_path:
        raise GSCError("GSC_SA_JSON is not set in the environment.")
    if not os.path.isfile(sa_path):
        raise GSCError(f"GSC_SA_JSON points to a missing file: {sa_path}")
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except Exception as e:
        raise GSCError(f"Google auth libs not importable — run with the venv python: {e}")
    try:
        creds = service_account.Credentials.from_service_account_file(sa_path, scopes=[SCOPE])
        return AuthorizedSession(creds)
    except Exception as e:
        raise GSCError(f"Failed to load service-account credentials: {e}")


def _enc_site():
    return urllib.parse.quote(_site_url(), safe="")


def _query(body):
    """POST searchAnalytics/query. Returns parsed JSON. Loud on error."""
    sess = _session()
    url = f"{GSC_HOST}/webmasters/v3/sites/{_enc_site()}/searchAnalytics/query"
    try:
        resp = sess.post(url, json=body, timeout=60)
    except Exception as e:
        raise GSCError(f"Network error reaching GSC API: {e}")
    if resp.status_code != 200:
        raise GSCError(f"HTTP {resp.status_code} from GSC API", status=resp.status_code,
                       detail=resp.text[:800])
    return resp.json()


def _get(path):
    sess = _session()
    url = f"{GSC_HOST}{path}"
    try:
        resp = sess.get(url, timeout=60)
    except Exception as e:
        raise GSCError(f"Network error reaching GSC API: {e}")
    if resp.status_code != 200:
        raise GSCError(f"HTTP {resp.status_code} from GSC API", status=resp.status_code,
                       detail=resp.text[:800])
    return resp.json()


def _shift(date_str, days):
    d = datetime.strptime(date_str, "%Y-%m-%d").date() - timedelta(days=days)
    return d.strftime("%Y-%m-%d")


def _sa_rows(frm, to, dimensions, limit, data_state):
    limit = max(1, min(int(limit), 25000))  # GSC rowLimit max is 25,000
    body = {"startDate": frm, "endDate": to, "rowLimit": limit, "dataState": data_state}
    if dimensions:
        body["dimensions"] = dimensions
    rep = _query(body)
    rows = []
    for r in rep.get("rows", []) or []:
        rows.append({
            "keys": r.get("keys", []),
            "clicks": r.get("clicks"),
            "impressions": r.get("impressions"),
            "ctr": r.get("ctr"),
            "position": r.get("position"),
        })
    return rows


def _envelope(command, query, rows, gaps=None, data_state=None, extra=None):
    out = {
        "connector": CONNECTOR,
        "command": command,
        "site_url": _site_url(),
        "query": query,
        "count": len(rows),
        "rows": rows,
        "gaps": gaps or [],
    }
    if data_state:
        out["data_state"] = data_state
    if extra:
        out.update(extra)
    return out


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_search(args):
    rows = _sa_rows(args.frm, args.to, [args.dimension], args.limit, args.data_state)
    return _envelope("search",
                     {"from": args.frm, "to": args.to, "dimension": args.dimension, "limit": args.limit},
                     rows, data_state=args.data_state)


def cmd_wow(args):
    e = args.week_ending
    w1_from, w1_to = _shift(e, 6), e
    w2_from, w2_to = _shift(e, 13), _shift(e, 7)
    gaps = []
    try:
        from datetime import date, datetime
        _days = (date.today() - datetime.strptime(e, "%Y-%m-%d").date()).days
        if _days < 3:
            gaps.append(
                "PROVISIONAL: pulled %d day(s) after the window ended; GSC finalizes ~2-3 "
                "days behind, so clicks for the last days of this window WILL restate "
                "(usually upward). Label the WoW change as provisional, not final." % max(_days, 0))
    except Exception:
        pass
    if args.dimension == "page":
        r1 = {tuple(x["keys"]): x for x in _sa_rows(w1_from, w1_to, ["page"], 25000, args.data_state)}
        r2 = {tuple(x["keys"]): x for x in _sa_rows(w2_from, w2_to, ["page"], 25000, args.data_state)}
        rows = []
        for k in sorted(set(r1) | set(r2), key=lambda kk: -(r1.get(kk, {}).get("clicks") or 0)):
            c1 = (r1.get(k, {}) or {}).get("clicks") or 0
            c2 = (r2.get(k, {}) or {}).get("clicks") or 0
            rows.append({"page": k[0] if k else None, "clicks_this_week": c1,
                         "clicks_prior_week": c2, "delta": c1 - c2})
        return _envelope("wow",
                         {"week_ending": e, "this_week": [w1_from, w1_to],
                          "prior_week": [w2_from, w2_to], "dimension": "page"},
                         rows, gaps=gaps, data_state=args.data_state)
    # site-wide: no dimensions -> single aggregate row
    a1 = _sa_rows(w1_from, w1_to, [], 1, args.data_state)
    a2 = _sa_rows(w2_from, w2_to, [], 1, args.data_state)
    c1 = (a1[0]["clicks"] if a1 else 0) or 0
    c2 = (a2[0]["clicks"] if a2 else 0) or 0
    summary = {"clicks_this_week": c1, "clicks_prior_week": c2, "delta": c1 - c2,
               "pct_change": (round((c1 - c2) / c2 * 100, 1) if c2 else None)}
    return _envelope("wow",
                     {"week_ending": e, "this_week": [w1_from, w1_to],
                      "prior_week": [w2_from, w2_to], "dimension": "site-wide"},
                     [summary], gaps=gaps, data_state=args.data_state)


def cmd_coverage(args):
    """Index-coverage signal. The full Coverage report is NOT exposed by the API;
    report sitemap submitted/indexed counts and say what is missing."""
    gaps = ["GSC's Index Coverage report is not exposed by the API. This command "
            "reports sitemap-level submitted/indexed counts only. For per-URL index "
            "status use the URL Inspection API (per-URL, rate-limited) separately."]
    rows = []
    try:
        sm = _get(f"/webmasters/v3/sites/{_enc_site()}/sitemaps")
        for s in sm.get("sitemap", []) or []:
            contents = s.get("contents", []) or []
            submitted = sum(int(c.get("submitted", 0) or 0) for c in contents)
            indexed = sum(int(c.get("indexed", 0) or 0) for c in contents)
            rows.append({"path": s.get("path"), "lastSubmitted": s.get("lastSubmitted"),
                         "isPending": s.get("isPending"), "errors": s.get("errors"),
                         "warnings": s.get("warnings"), "submitted": submitted, "indexed": indexed})
    except GSCError as ex:
        gaps.append(f"sitemaps.list failed: {ex}")
    return _envelope("coverage", {"scope": "sitemaps"}, rows, gaps=gaps,
                     extra={"verify_live": ["confirm sitemap 'contents' submitted/indexed fields against the live property"]})


def main():
    p = argparse.ArgumentParser(prog="gsc_client.py", description="Read-only GSC connector (PHR MCD)")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("search")
    sp.add_argument("--from", dest="frm", required=True, help="YYYY-MM-DD")
    sp.add_argument("--to", dest="to", required=True, help="YYYY-MM-DD")
    sp.add_argument("--dimension", default="query", choices=["query", "page", "date", "country", "device", "searchAppearance"])
    sp.add_argument("--limit", type=int, default=1000)
    sp.add_argument("--data-state", dest="data_state", default="final", choices=["final", "all"])

    sp = sub.add_parser("wow")
    sp.add_argument("--week-ending", dest="week_ending", required=True, help="YYYY-MM-DD (last day of the recent week)")
    sp.add_argument("--dimension", default="site-wide", choices=["site-wide", "page"])
    sp.add_argument("--data-state", dest="data_state", default="final", choices=["final", "all"])

    sub.add_parser("coverage")

    args = p.parse_args()
    handlers = {"search": cmd_search, "wow": cmd_wow, "coverage": cmd_coverage}
    try:
        print(json.dumps(handlers[args.command](args), indent=2))
        return 0
    except GSCError as e:
        print(json.dumps({"connector": CONNECTOR, "command": args.command,
                          "error": str(e), "status": e.status, "detail": e.detail},
                         indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
