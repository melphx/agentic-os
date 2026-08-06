#!/usr/bin/env python3
"""
ga4_client.py - read-only GA4 (Data API) connector for the PHR MCD agent.

MUST run with the Hermes venv Python (system python3 lacks the Google libs):
  /usr/local/lib/hermes-agent/venv/bin/python3 ga4_client.py <command> ...

Deterministic data pulls; the model does judgment. Stdlib + google-auth +
requests (all present in the Hermes venv).

Shared contract (every command):
  1. Read-only creds from env: GA4_SA_JSON (path to Viewer service-account key),
     GA4_PROPERTY_ID, GA4_KEYWORD_HERO_PROPERTY_ID.
  2. Structured JSON on stdout.
  3. The raw query + date range echoed back.
  4. Loud failure: any auth/API error prints a JSON error to stderr, exits 1.
  5. Gaps reported as gaps.
  6. The property a number came from is always named in the output.

HARD RULE (Keyword Hero lag, enforced here in code, not by the model):
  Keyword Hero data lags ~3 days. Any query against the Keyword Hero property
  shifts the requested window back KH_LAG_DAYS and labels the true data window.

Commands: channels | forms | keywords
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

ANALYTICS_DATA_HOST = "https://analyticsdata.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
CONNECTOR = "ga4-reader"
KH_LAG_DAYS = 3

# Uncertain API names — overridable by env, defaults flagged verify_live:
FORM_EVENT = os.environ.get("GA4_FORM_EVENT", "form_submit")
KEY_EVENT_METRIC = os.environ.get("GA4_KEY_EVENT_METRIC", "keyEvents")  # GA4 renamed 'conversions' -> 'keyEvents'
KH_KEYWORD_DIMENSION = os.environ.get("GA4_KH_KEYWORD_DIMENSION", "")   # Keyword Hero dimension; MUST be confirmed/set
# Keyword Hero is an EVENT-IMPORTED property: it has no real GA4 sessions, so the
# 'sessions'/'keyEvents' metrics come back empty. Its data rides on the
# 'kwh_session_data' event, so eventCount is the meaningful volume metric
# (one event ~= one organic session for that keyword). Overridable via env.
KH_METRIC = os.environ.get("GA4_KH_METRIC", "eventCount")


class GA4Error(Exception):
    def __init__(self, message, status=None, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def _session():
    """Build an AuthorizedSession from the service-account key. Loud on failure."""
    sa_path = os.environ.get("GA4_SA_JSON", "").strip()
    if not sa_path:
        raise GA4Error("GA4_SA_JSON is not set in the environment.")
    if not os.path.isfile(sa_path):
        raise GA4Error(f"GA4_SA_JSON points to a missing file: {sa_path}")
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except Exception as e:
        raise GA4Error(f"Google auth libs not importable — run with the venv python: {e}")
    try:
        creds = service_account.Credentials.from_service_account_file(sa_path, scopes=[SCOPE])
        return AuthorizedSession(creds)
    except Exception as e:
        raise GA4Error(f"Failed to load service-account credentials: {e}")


def _run_report(property_id, body):
    """POST runReport for a property. Returns parsed JSON. Loud on error."""
    if not property_id:
        raise GA4Error("property id is empty (check GA4_PROPERTY_ID / GA4_KEYWORD_HERO_PROPERTY_ID).")
    sess = _session()
    url = f"{ANALYTICS_DATA_HOST}/v1beta/properties/{property_id}:runReport"
    try:
        resp = sess.post(url, json=body, timeout=60)
    except Exception as e:
        raise GA4Error(f"Network error reaching GA4 Data API: {e}")
    if resp.status_code != 200:
        raise GA4Error(f"HTTP {resp.status_code} from GA4 Data API", status=resp.status_code,
                       detail=resp.text[:800])
    try:
        return resp.json()
    except Exception as e:
        raise GA4Error(f"GA4 returned non-JSON: {e}")


def _get(path):
    """GET an analyticsdata endpoint (e.g. metadata). Returns JSON. Loud on error."""
    sess = _session()
    url = f"{ANALYTICS_DATA_HOST}{path}"
    try:
        resp = sess.get(url, timeout=60)
    except Exception as e:
        raise GA4Error(f"Network error reaching GA4 Data API: {e}")
    if resp.status_code != 200:
        raise GA4Error(f"HTTP {resp.status_code} from GA4 Data API", status=resp.status_code,
                       detail=resp.text[:800])
    return resp.json()


def _rows(report, dim_names, metric_names):
    """Flatten a runReport response into list[dict]."""
    out = []
    for r in report.get("rows", []) or []:
        dvs = [d.get("value") for d in r.get("dimensionValues", [])]
        mvs = [m.get("value") for m in r.get("metricValues", [])]
        row = {}
        for i, name in enumerate(dim_names):
            row[name] = dvs[i] if i < len(dvs) else None
        for i, name in enumerate(metric_names):
            row[name] = mvs[i] if i < len(mvs) else None
        out.append(row)
    return out


def _envelope(command, property_label, property_id, query, rows, gaps=None,
              data_window=None, verify_live=None):
    out = {
        "connector": CONNECTOR,
        "command": command,
        "property": property_label,
        "property_id": property_id,
        "query": query,
        "count": len(rows),
        "rows": rows,
        "gaps": gaps or [],
    }
    if data_window:
        out["data_window"] = data_window
    if verify_live:
        out["verify_live"] = verify_live
    return out


def _shift(date_str, days):
    d = datetime.strptime(date_str, "%Y-%m-%d").date() - timedelta(days=days)
    return d.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_channels(args):
    pid = os.environ.get("GA4_PROPERTY_ID", "").strip()
    dims = ["sessionDefaultChannelGroup"]
    mets = ["sessions", KEY_EVENT_METRIC]
    body = {
        "dateRanges": [{"startDate": args.frm, "endDate": args.to}],
        "dimensions": [{"name": d} for d in dims],
        "metrics": [{"name": m} for m in mets],
        "limit": "10000",
    }
    rep = _run_report(pid, body)
    return _envelope("channels", "main", pid,
                     {"from": args.frm, "to": args.to},
                     _rows(rep, dims, mets),
                     verify_live=[f"metric '{KEY_EVENT_METRIC}' assumed (GA4 renamed conversions->keyEvents); override via GA4_KEY_EVENT_METRIC if the property rejects it"])


def cmd_forms(args):
    pid = os.environ.get("GA4_PROPERTY_ID", "").strip()
    dims = ["landingPagePlusQueryString", "eventName"]
    mets = ["eventCount"]
    body = {
        "dateRanges": [{"startDate": args.frm, "endDate": args.to}],
        "dimensions": [{"name": d} for d in dims],
        "metrics": [{"name": m} for m in mets],
        "dimensionFilter": {
            "filter": {"fieldName": "eventName",
                       "stringFilter": {"matchType": "EXACT", "value": FORM_EVENT}}
        },
        "limit": "10000",
    }
    rep = _run_report(pid, body)
    return _envelope("forms", "main", pid,
                     {"from": args.frm, "to": args.to, "event": FORM_EVENT},
                     _rows(rep, dims, mets),
                     verify_live=[f"form event name assumed '{FORM_EVENT}'; confirm PHR's actual form-submit event and override via GA4_FORM_EVENT"])


def cmd_keywords(args):
    """Keyword Hero property. Lag rule enforced here: window shifted back KH_LAG_DAYS."""
    pid = os.environ.get("GA4_KEYWORD_HERO_PROPERTY_ID", "").strip()
    kh_from = _shift(args.frm, KH_LAG_DAYS)
    kh_to = _shift(args.to, KH_LAG_DAYS)
    gaps = []
    if not KH_KEYWORD_DIMENSION:
        gaps.append("GA4_KH_KEYWORD_DIMENSION is not set: the exact Keyword Hero keyword dimension API name must be confirmed and set in env before this returns keyword rows.")
        return _envelope("keywords", "keyword_hero", pid,
                         {"from": args.frm, "to": args.to},
                         [], gaps=gaps,
                         data_window={"from": kh_from, "to": kh_to, "lag_days": KH_LAG_DAYS},
                         verify_live=["set GA4_KH_KEYWORD_DIMENSION to Keyword Hero's keyword dimension API name once confirmed against the live property"])
    dims = [KH_KEYWORD_DIMENSION]
    mets = [KH_METRIC]
    body = {
        "dateRanges": [{"startDate": kh_from, "endDate": kh_to}],
        "dimensions": [{"name": d} for d in dims],
        "metrics": [{"name": m} for m in mets],
        "orderBys": [{"metric": {"metricName": KH_METRIC}, "desc": True}],
        "limit": "10000",
    }
    rep = _run_report(pid, body)
    rows = _rows(rep, dims, mets)
    if rows:
        gaps.append("Keyword Hero returns unresolved buckets as keyword values: "
                    "'(not set)', '(not provided)' and source-tagged variants "
                    "(e.g. '(not provided)_bing', '_gmb', '_duckduckgo') are KH's own "
                    "labels, not real query strings. Exclude them when ranking real keywords.")
    return _envelope("keywords", "keyword_hero", pid,
                     {"from": args.frm, "to": args.to},
                     rows, gaps=gaps,
                     data_window={"from": kh_from, "to": kh_to, "lag_days": KH_LAG_DAYS},
                     verify_live=[f"KH keyword dimension '{KH_KEYWORD_DIMENSION}' read with metric "
                                  f"'{KH_METRIC}' (eventCount of the kwh_session_data import event); "
                                  f"sessions/keyEvents are empty on this property by design"])


def cmd_metadata(args):
    """List the real dimension/metric apiNames for a property (discover KH field names)."""
    if args.property == "keyword_hero":
        pid = os.environ.get("GA4_KEYWORD_HERO_PROPERTY_ID", "").strip()
    else:
        pid = os.environ.get("GA4_PROPERTY_ID", "").strip()
    if not pid:
        raise GA4Error("property id is empty (check GA4_PROPERTY_ID / GA4_KEYWORD_HERO_PROPERTY_ID).")
    md = _get(f"/v1beta/properties/{pid}/metadata")
    dims = [{"apiName": d.get("apiName"), "uiName": d.get("uiName"),
             "customDefinition": d.get("customDefinition", False)} for d in md.get("dimensions", [])]
    mets = [{"apiName": m.get("apiName"), "uiName": m.get("uiName"),
             "customDefinition": m.get("customDefinition", False)} for m in md.get("metrics", [])]
    return {
        "connector": CONNECTOR, "command": "metadata", "property": args.property,
        "property_id": pid, "dimensions": dims, "metrics": mets,
        "dimension_count": len(dims), "metric_count": len(mets),
    }


def cmd_conversions(args):
    """Every GA4 event with its count, so the model can sum the CONFIRMED
    conversion-event set. page_view is NOT a conversion; do not total all rows."""
    pid = os.environ.get("GA4_PROPERTY_ID", "").strip()
    dims = ["eventName"]
    mets = ["eventCount"]
    body = {
        "dateRanges": [{"startDate": args.frm, "endDate": args.to}],
        "dimensions": [{"name": d} for d in dims],
        "metrics": [{"name": m} for m in mets],
        "orderBys": [{"metric": {"metricName": "eventCount"}, "desc": True}],
        "limit": "250",
    }
    rep = _run_report(pid, body)
    return _envelope("conversions", "main", pid,
                     {"from": args.frm, "to": args.to},
                     _rows(rep, dims, mets),
                     verify_live=["Returns EVERY GA4 event with its count for the window. page_view is NOT "
                                  "a conversion. Sum ONLY the conversion events Jeremy confirms; never total "
                                  "all rows. Likely conversion set: ads_conversion_Submit_lead_form_1, "
                                  "'Lead Submission - Any Page', Consultation/Schedule Consultation events, "
                                  "Click-to-Call, 'Phone Number Clicks', qualify_lead. Exclude page_view, "
                                  "purchase, scroll, session_start, user_engagement, first_visit."])


def main():
    p = argparse.ArgumentParser(prog="ga4_client.py", description="Read-only GA4 connector (PHR MCD)")
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("channels", "forms", "keywords", "conversions"):
        sp = sub.add_parser(name)
        sp.add_argument("--from", dest="frm", required=True, help="YYYY-MM-DD")
        sp.add_argument("--to", dest="to", required=True, help="YYYY-MM-DD")
    spm = sub.add_parser("metadata")
    spm.add_argument("--property", choices=["main", "keyword_hero"], default="main")
    args = p.parse_args()
    handlers = {"channels": cmd_channels, "forms": cmd_forms, "keywords": cmd_keywords,
                "conversions": cmd_conversions, "metadata": cmd_metadata}
    try:
        print(json.dumps(handlers[args.command](args), indent=2))
        return 0
    except GA4Error as e:
        print(json.dumps({"connector": CONNECTOR, "command": args.command,
                          "error": str(e), "status": e.status, "detail": e.detail},
                         indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
