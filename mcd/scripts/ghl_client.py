#!/usr/bin/env python3
"""
ghl_client.py - read-only GoHighLevel (v2) connector for the PHR MCD agent.

Deterministic data pulls. The model does judgment; this script does the API
calls and prints audited JSON. Stdlib only.

Shared contract (every command):
  1. Read-only creds from env: GHL_API_KEY (sub-account Private Integration
     Token, read scopes only) and GHL_LOCATION_ID.
  2. Structured JSON on stdout.
  3. The raw query + date range are echoed back in every result.
  4. Every record carries its GHL record id (auditable).
  5. Loud failure: any API error prints a JSON error to stderr and exits 1.
     Never a silent empty result, never a fabricated number.
  6. Attribution / coverage gaps are reported in "gaps", not estimated around.

Commands: leads | pipeline | appointments | opportunities | calls

NOTE ON VERIFICATION: the calendar, pipelines, and opportunities endpoints are
implemented against GoHighLevel's published OpenAPI spec (exact param casing /
date formats). The contacts (leads) and conversations (calls) endpoints are
implemented to known v2 patterns but were not spec-verified at build time; each
emits a "verify_live" note so the first live run is checked, not trusted blind.
"""

import argparse
import json
import re
from datetime import datetime as _dt, timedelta as _td
import sys
import time as _time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, time, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("America/Phoenix")
except Exception:  # pragma: no cover - stdlib fallback
    TZ = None

import os

BASE_URL = "https://services.leadconnectorhq.com"
CONNECTOR = "ghl-reader"

# Version header differs per endpoint family (confirmed from the OpenAPI spec):
VERSION_CALENDARS = "2021-04-15"
VERSION_DEFAULT = "2021-07-28"  # opportunities, contacts, conversations

MAX_PAGES = 100  # runaway guard on paginated pulls


class GHLError(Exception):
    def __init__(self, message, status=None, detail=None, url=None):
        super().__init__(message)
        self.status = status
        self.detail = detail
        self.url = url


def _config():
    key = os.environ.get("GHL_API_KEY", "").strip()
    loc = os.environ.get("GHL_LOCATION_ID", "").strip()
    if not key:
        raise GHLError("GHL_API_KEY is not set in the environment.")
    if not loc:
        raise GHLError("GHL_LOCATION_ID is not set in the environment.")
    return key, loc


def _request(path, params, version, retries=3):
    """GET {BASE_URL}{path}?params. Returns parsed JSON. Raises GHLError loudly.
    Retries once or twice on HTTP 429 (rate limit) and transient network errors."""
    key, _ = _config()
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BASE_URL}{path}"
    if qs:
        url = f"{url}?{qs}"
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Version", version)
        req.add_header("Accept", "application/json")
        # GoHighLevel sits behind Cloudflare, which bans the default Python-urllib
        # user-agent (Error 1010 browser_signature_banned). Send a normal UA so the
        # request reaches the API instead of being blocked at the edge.
        req.add_header("User-Agent",
                       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8")[:800]
            except Exception:
                pass
            if e.code == 429 and attempt < retries:
                ra = e.headers.get("Retry-After") if e.headers else None
                _time.sleep(float(ra) if (ra and str(ra).replace('.', '', 1).isdigit()) else 2.0)
                continue
            raise GHLError(f"HTTP {e.code} from GHL", status=e.code, detail=detail, url=url)
        except urllib.error.URLError as e:
            if attempt < retries:
                _time.sleep(1.5)
                continue
            raise GHLError(f"Network error reaching GHL: {e.reason}", url=url)
        except json.JSONDecodeError as e:
            raise GHLError(f"GHL returned non-JSON: {e}", url=url)


# ---------------------------------------------------------------------------
# date helpers
# ---------------------------------------------------------------------------

def _parse_day(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def _epoch_ms(date_str, end_of_day=False):
    """YYYY-MM-DD -> epoch milliseconds at Phoenix-local day boundary (string)."""
    d = _parse_day(date_str)
    t = time(23, 59, 59, 999000) if end_of_day else time(0, 0, 0, 0)
    dt = datetime.combine(d, t)
    if TZ is not None:
        dt = dt.replace(tzinfo=TZ)
        return str(int(dt.timestamp() * 1000))
    # fallback: treat as UTC, flag handled by caller's verify_live note
    return str(int(dt.timestamp() * 1000))


def _mmddyyyy(date_str):
    """YYYY-MM-DD -> MM-DD-YYYY (the format the opportunities search documents)."""
    d = _parse_day(date_str)
    return d.strftime("%m-%d-%Y")


def _iso_in_range(iso_str, frm, to):
    """Is an ISO-8601 timestamp within [frm 00:00, to 23:59] (date-level)?"""
    if not iso_str:
        return False
    try:
        ds = iso_str[:10]
        d = _parse_day(ds)
    except Exception:
        return False
    return _parse_day(frm) <= d <= _parse_day(to)


def _envelope(command, query, records, gaps=None, verify_live=None, extra=None):
    _, loc = _config()
    out = {
        "connector": CONNECTOR,
        "command": command,
        "query": query,
        "location_id": loc,
        "source_api": "GoHighLevel API v2",
        "count": len(records),
        "records": records,
        "gaps": gaps or [],
    }
    if verify_live:
        out["verify_live"] = verify_live
    if extra:
        out.update(extra)
    return out


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------

def cmd_pipeline(args):
    """Open-opportunity counts per pipeline stage. VERIFIED endpoints.
    Per-stage count = meta.total of /opportunities/search filtered to that stage with
    status=open. Calls run concurrently (the location can have many pipelines/stages)."""
    _, loc = _config()
    pipelines_resp = _request("/opportunities/pipelines", {"locationId": loc}, VERSION_DEFAULT)
    pipelines = pipelines_resp.get("pipelines", [])
    status = args.status or "open"
    # build the full task list (one cheap limit=1 search per stage)
    tasks = []
    for p in pipelines:
        pid = p.get("id")
        for st in (p.get("stages", []) or []):
            tasks.append((pid, st.get("id")))

    counts = {}
    gaps = []

    def fetch(task):
        pid, sid = task
        r = _request(
            "/opportunities/search",
            {"location_id": loc, "pipeline_id": pid, "pipeline_stage_id": sid,
             "status": status, "limit": 1},
            VERSION_DEFAULT,
        )
        return pid, sid, (r.get("meta") or {}).get("total")

    if tasks:
        with ThreadPoolExecutor(max_workers=3) as ex:
            futs = {ex.submit(fetch, t): t for t in tasks}
            for fu in as_completed(futs):
                pid, sid = futs[fu]
                try:
                    rpid, rsid, total = fu.result()
                    counts[(rpid, rsid)] = total
                except GHLError as e:
                    counts[(pid, sid)] = None
                    gaps.append(f"stage {sid} count unavailable: {e}")

    records = []
    for p in pipelines:
        pid = p.get("id")
        stage_rows = []
        for st in (p.get("stages", []) or []):
            sid = st.get("id")
            stage_rows.append({"stage_id": sid, "stage_name": st.get("name"),
                               "position": st.get("position"),
                               "open_count": counts.get((pid, sid))})
        records.append({"pipeline_id": pid, "pipeline_name": p.get("name"), "stages": stage_rows})
    return _envelope(
        "pipeline", {"as_of": "now", "status": status}, records, gaps=gaps,
    )


def cmd_opportunities(args):
    """Opportunities created in [from,to], optionally by status. VERIFIED endpoint."""
    _, loc = _config()
    params = {
        "location_id": loc,
        "date": _mmddyyyy(args.frm),        # START date (param literally named 'date')
        "endDate": _mmddyyyy(args.to),      # END date (camelCase even in snake variant)
        "limit": 100,
        "page": 1,
    }
    if args.status:
        params["status"] = args.status
    records = []
    gaps = []
    page = 1
    total = None
    while page <= MAX_PAGES:
        params["page"] = page
        r = _request("/opportunities/search", params, VERSION_DEFAULT)
        opps = r.get("opportunities", []) or []
        meta = r.get("meta") or {}
        total = meta.get("total", total)
        for o in opps:
            records.append({
                "id": o.get("id"),
                "name": o.get("name"),
                "status": o.get("status"),
                "monetaryValue": o.get("monetaryValue"),
                "pipelineId": o.get("pipelineId"),
                "pipelineStageId": o.get("pipelineStageId"),
                "source": o.get("source"),
                "createdAt": o.get("createdAt"),
                "updatedAt": o.get("updatedAt"),
                "contactId": o.get("contactId"),
            })
        if not opps or len(opps) < params["limit"]:
            break
        page += 1
    return _envelope(
        "opportunities",
        {"from": args.frm, "to": args.to, "status": args.status, "reported_total": total},
        records, gaps=gaps,
        verify_live=[
            "CONFIRMED on live data: the --from/--to range filters the opportunity CREATED/ADDED date (MM-DD-YYYY), NOT the won/close date. So 'won opps in the last N days' counts deals CREATED in that window that are now won, not deals CLOSED in that window. For close-rate-by-period analysis, account for the long sales cycle (a deal won this month was likely created months ago).",
        ],
    )


def cmd_appointments(args):
    """Calendar events (DC + in-home) in [from,to]. VERIFIED endpoints."""
    _, loc = _config()
    start_ms = _epoch_ms(args.frm, end_of_day=False)
    end_ms = _epoch_ms(args.to, end_of_day=True)
    # 1) list calendars to iterate (events endpoint requires a calendar/user/group id)
    cals_resp = _request("/calendars/", {"locationId": loc}, VERSION_CALENDARS)
    calendars = cals_resp.get("calendars", []) or []
    records = []
    gaps = []
    cal_filter = (args.calendar_id or "").strip()
    iterated = 0
    for c in calendars:
        cid = c.get("id")
        cname = c.get("name")
        if cal_filter and cid != cal_filter:
            continue
        iterated += 1
        try:
            ev = _request(
                "/calendars/events",
                {"locationId": loc, "calendarId": cid, "startTime": start_ms, "endTime": end_ms},
                VERSION_CALENDARS,
            )
        except GHLError as e:
            gaps.append(f"calendar '{cname}' ({cid}) events unavailable: {e}")
            continue
        for e in ev.get("events", []) or []:
            records.append({
                "id": e.get("id"),
                "calendar_id": cid,
                "calendar_name": cname,
                "title": e.get("title"),
                "startTime": e.get("startTime"),
                "endTime": e.get("endTime"),
                "appointmentStatus": e.get("appointmentStatus"),
                "contactId": e.get("contactId"),
                "assignedUserId": e.get("assignedUserId"),
            })
    if iterated == 0:
        gaps.append("no calendars matched; nothing queried")
    return _envelope(
        "appointments",
        {"from": args.frm, "to": args.to, "calendar_id": args.calendar_id or "ALL",
         "start_ms": start_ms, "end_ms": end_ms},
        records, gaps=gaps,
        verify_live=[
            "request times are epoch-ms at America/Phoenix day boundaries; confirm tz handling matches GHL",
            "events endpoint is not paginated — for very busy windows confirm results are not silently capped",
        ],
    )


def cmd_leads(args):
    """Contacts/leads added in [from,to], optional source.
    GET /contacts/ returns newest-first by dateAdded (confirmed live), and has no
    server-side date filter. So we paginate newest-first and STOP once we pass the
    --from date. Date + source filtered client-side."""
    _, loc = _config()
    from_d, to_d = _parse_day(args.frm), _parse_day(args.to)
    records = []
    gaps = []
    params = {"locationId": loc, "limit": 100}
    pages = 0
    start_after = None
    start_after_id = None
    stop = False
    while pages < MAX_PAGES and not stop:
        if start_after is not None:
            params["startAfter"] = start_after
        if start_after_id is not None:
            params["startAfterId"] = start_after_id
        r = _request("/contacts/", params, VERSION_DEFAULT)
        contacts = r.get("contacts", []) or []
        if not contacts:
            break
        for c in contacts:
            added = c.get("dateAdded") or c.get("createdAt")
            try:
                d = _parse_day(added[:10]) if added else None
            except Exception:
                d = None
            if d is None:
                continue
            if d < from_d:
                stop = True   # newest-first: everything after this is older than the window
                continue
            if d > to_d:
                continue      # newer than the window
            if args.source and (c.get("source") or "").lower() != args.source.lower():
                continue
            nm = (c.get("contactName") or
                  ((c.get("firstName") or "") + " " + (c.get("lastName") or "")).strip())
            records.append({"id": c.get("id"), "dateAdded": added, "name": nm,
                            "source": c.get("source"), "type": c.get("type"),
                            "tags": c.get("tags")})
        meta = r.get("meta") or {}
        start_after = meta.get("startAfter")
        start_after_id = meta.get("startAfterId")
        pages += 1
        if start_after is None and start_after_id is None:
            break
    if pages >= MAX_PAGES and not stop:
        gaps.append(f"hit page cap ({MAX_PAGES}) before reaching the --from date; widen caution for very old windows.")
    LEAD_TYPES = {"lead", "prospect"}
    by_type = {}
    for r in records:
        t = (r.get("type") or "unknown")
        by_type[t] = by_type.get(t, 0) + 1
    lead_count = sum(1 for r in records if (r.get("type") or "").lower() in LEAD_TYPES)
    QUALIFIED_TAG = "reporting tags - new lead - all new qualified leads - for reporting"
    # Non-homeowner contact types sometimes carry the qualified tag, but PHR's dashboard
    # smartlist filters them out. Confirmed 2026-07-20: excluding these made our count
    # match the dashboard exactly (29 -> 26 for Jul 5-11). Homeowner types kept are lead,
    # prospect, and referred_out_to_another_contractor/handyman (a homeowner PHR referred
    # elsewhere; the dashboard counts those).
    NON_HOMEOWNER_TYPES = {"vendor", "solicitor", "subcontractor", "bogus_lead"}
    def _has_qtag(r):
        return any((t or "").lower() == QUALIFIED_TAG for t in (r.get("tags") or []))
    def _outbound(r):
        # Outbound-originated contacts (e.g. "Discovery Call - Receptionist Outbound") are
        # calls PHR made OUT, not new inbound leads. PHR's dashboard excludes them from the
        # qualified count (confirmed 2026-07-20: richard weisenberg, the lone 18-vs-17 gap).
        return (r.get("source") or "").strip().lower().endswith("outbound")
    def _is_qual(r):
        return (_has_qtag(r)
                and (r.get("type") or "").lower() not in NON_HOMEOWNER_TYPES
                and not _outbound(r))
    def _blank_src(r):
        s = (r.get("source") or "").strip()
        return s == "" or s.lower() in ("none", "null")
    qualified_records = [r for r in records if _is_qual(r)]
    _type_excluded = [r for r in records if _has_qtag(r)
                      and (r.get("type") or "").lower() in NON_HOMEOWNER_TYPES]
    _outbound_excluded = [r for r in records if _has_qtag(r)
                          and (r.get("type") or "").lower() not in NON_HOMEOWNER_TYPES
                          and _outbound(r)]
    if _outbound_excluded:
        gaps.append("EXCLUDED %d outbound-originated contact(s) (source ends 'Outbound') from "
                    "qualified_lead_count, matching PHR's dashboard: %s."
                    % (len(_outbound_excluded),
                       ", ".join((r.get("name") or "?") for r in _outbound_excluded)))
    if _type_excluded:
        gaps.append("EXCLUDED %d non-homeowner contact(s) (type vendor/solicitor/subcontractor/"
                    "bogus_lead) that carried the qualified tag, matching PHR's dashboard "
                    "contact-type filter: %s."
                    % (len(_type_excluded),
                       ", ".join("%s (%s)" % (r.get("name") or "?", r.get("type"))
                                 for r in _type_excluded)))
    # Test contacts sometimes carry the qualified tag (e.g. "Test Test", 2026-07-06,
    # caused a 32-vs-26 dispute with PHR's sheet). Exclude them, loudly.
    import re as _re
    _test_rows = [r for r in qualified_records
                  if _re.search(r"\btest\b", (r.get("name") or ""), _re.I)]
    if _test_rows:
        qualified_records = [r for r in qualified_records if r not in _test_rows]
        gaps.append("EXCLUDED %d test contact(s) carrying the qualified tag from "
                    "qualified_lead_count: %s. Ask the team to strip the reporting tag "
                    "from test contacts in GHL."
                    % (len(_test_rows), ", ".join((r.get("name") or "?") for r in _test_rows)))
    qualified_lead_count = len(qualified_records)
    # Blank-source is only meaningful over QUALIFIED leads. Over all contacts it is
    # dominated by solicitors/vendors/unworked entries that never carry a source.
    qualified_blank_source_count = sum(1 for r in qualified_records if _blank_src(r))
    qualified_source_breakdown = {}
    for r in qualified_records:
        s = (r.get("source") or "").strip() or "(blank)"
        qualified_source_breakdown[s] = qualified_source_breakdown.get(s, 0) + 1
    total_blank_source_count = sum(1 for r in records if _blank_src(r))
    gaps.append("THREE counts: total_contacts_created = ALL contacts (includes solicitors/vendors/etc); "
                "lead_count = contact type lead or prospect; qualified_lead_count = PHR's 'New Qualified "
                "Leads' weekly sales-report metric (the 'new qualified leads for reporting' tag). For the "
                "weekly report, report qualified_lead_count as 'New Qualified Leads' to match PHR's sheet.")
    gaps.append("source filtered on the standard contact 'source' field only; tag/custom-field slicing is not supported server-side (per Mel) — request those separately if needed.")
    gaps.append("BLANK SOURCE: report it over QUALIFIED LEADS only (qualified_blank_source_count of qualified_lead_count). total_blank_source_count is over ALL contacts and is dominated by solicitors/vendors/unworked contacts that never carry a source; do NOT present it as a lead-source data-quality problem.")
    return _envelope(
        "leads",
        {"from": args.frm, "to": args.to, "source": args.source},
        records, gaps=gaps,
        extra={"qualified_lead_count": qualified_lead_count, "lead_count": lead_count,
               "total_contacts_created": len(records), "by_type": by_type,
               "qualified_test_excluded": len(_test_rows),
               "qualified_type_excluded": len(_type_excluded),
               "qualified_outbound_excluded": len(_outbound_excluded),
               "qualified_blank_source_count": qualified_blank_source_count,
               "qualified_source_breakdown": qualified_source_breakdown,
               "total_blank_source_count": total_blank_source_count},
    )


MAX_CONV = 1500  # cap on conversations scanned for calls in a window


def cmd_calls(args):
    """Call-tracking summaries by line for [from,to].
    Calls are TYPE_CALL messages inside conversations (no calls-list endpoint).
    Method: page conversations newest-first (early-stop past --from), then pull each
    conversation's TYPE_CALL messages in the window concurrently, and aggregate by
    PHR line (inbound -> 'to', outbound -> 'from'). The 'Realtor line' is one such
    number in the breakdown."""
    _, loc = _config()
    from_ms = int(_epoch_ms(args.frm, end_of_day=False))
    to_ms = int(_epoch_ms(args.to, end_of_day=True))
    from_d, to_d = _parse_day(args.frm), _parse_day(args.to)
    gaps = []

    # 1) conversation ids active in/after the window (newest-first by lastMessageDate)
    conv_ids = []
    start_after_date = None
    pages = 0
    capped = False
    while pages < MAX_PAGES:
        params = {"locationId": loc, "limit": 100}
        if start_after_date is not None:
            params["startAfterDate"] = start_after_date
        r = _request("/conversations/search", params, VERSION_DEFAULT)
        convs = r.get("conversations", []) or []
        if not convs:
            break
        stop = False
        for c in convs:
            lmd = c.get("lastMessageDate")
            if lmd is None:
                continue
            if lmd < from_ms:
                stop = True
                break
            conv_ids.append(c.get("id"))
            if len(conv_ids) >= MAX_CONV:
                capped = True
                stop = True
                break
        start_after_date = convs[-1].get("lastMessageDate")
        pages += 1
        if stop or start_after_date is None:
            break
    if capped:
        gaps.append(f"conversation scan capped at {MAX_CONV}; call totals may undercount for very large windows — narrow the date range.")

    # 2) pull TYPE_CALL messages in window for each conversation, concurrently
    calls = []
    fetch_errors = 0

    def fetch_calls(cid):
        r = _request(f"/conversations/{cid}/messages", {"limit": 100}, VERSION_DEFAULT)
        msgs = (r.get("messages") or {}).get("messages") or []
        out = []
        for m in msgs:
            if str(m.get("messageType", "")).upper() != "TYPE_CALL":
                continue
            added = m.get("dateAdded")
            try:
                d = _parse_day(added[:10]) if added else None
            except Exception:
                d = None
            if d is None or d < from_d or d > to_d:
                continue
            out.append(m)
        return out

    if conv_ids:
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = [ex.submit(fetch_calls, cid) for cid in conv_ids]
            for fu in as_completed(futs):
                try:
                    calls.extend(fu.result())
                except GHLError:
                    fetch_errors += 1
    if fetch_errors:
        gaps.append(f"{fetch_errors} conversation message fetches failed (transient); totals may be slightly low.")

    # 3) aggregate by PHR line
    by_line = {}
    for m in calls:
        direction = m.get("direction")
        line = (m.get("to") if direction == "inbound" else m.get("from")) or "(unknown)"
        call_meta = (m.get("meta") or {}).get("call") or {}
        dur = call_meta.get("duration") or 0
        status = call_meta.get("status") or m.get("status")
        b = by_line.setdefault(line, {"line": line, "total_calls": 0, "inbound": 0,
                                      "outbound": 0, "completed": 0, "total_duration_sec": 0})
        b["total_calls"] += 1
        if direction == "inbound":
            b["inbound"] += 1
        elif direction == "outbound":
            b["outbound"] += 1
        if status == "completed":
            b["completed"] += 1
        try:
            b["total_duration_sec"] += int(dur or 0)
        except (TypeError, ValueError):
            pass
    lines = sorted(by_line.values(), key=lambda x: -x["total_calls"])

    return _envelope(
        "calls", {"from": args.frm, "to": args.to}, lines, gaps=gaps,
        extra={"total_calls": len(calls), "conversations_scanned": len(conv_ids)},
        verify_live=[
            "lines are PHR-side numbers (inbound -> 'to', outbound -> 'from'); identify which number is the Realtor line to label it.",
            "calls are read from up to 100 messages per conversation; a conversation with >100 messages could omit an older in-window call.",
        ],
    )



# Weekly funnel MILESTONES counted by their custom DATE field (the date the event
# happened), which is how PHR's dashboard counts stage flow. This provides the weekly
# Proposal Sent / Agreement Signed counts the pipeline snapshot cannot, and reproduces
# the dashboard's Discovery Call / In-Home widgets by date.
MILESTONE_FIELDS = [
    ("phone_consultation_scheduled", "pPIXugG2BUqxmuN7aI7B"),
    ("phone_consultation_completed", "FTRzrWq5rcMHyvt9SDMu"),
    ("phone_consultation_cancelled", "VzIp5AmvmB66a8sG8qfd"),
    ("phone_consultation_no_show", "I4hHAuXvC2pTNVcjJVeN"),
    ("in_home_scheduled", "3F2ntTCkEcjshXFQT1FC"),
    ("in_home_completed", "aTSynoN4I29sd3Etxhif"),
    ("in_home_cancelled", "1EunZU308a6Ab7HGMMNA"),
    ("in_home_no_show", "5vv4TMi6gaAjibJblnwL"),
    ("proposal_sent", "LwGDlKZrTiUzbty869p4"),
    ("design_agreement_signed", "GkAROmuEdsacCNBOvuir"),
    ("construction_agreement_signed", "RmooyPbpUPdO98RYUg1D"),
]


_MS_NON_HOMEOWNER = {"vendor", "solicitor", "subcontractor", "bogus_lead"}


def _ms_passes(c):
    """Same homeowner/inbound/real filters used for qualified leads, applied to milestone
    contacts so funnel counts follow the dashboard's method and our own rules."""
    if (c.get("type") or "").lower() in _MS_NON_HOMEOWNER:
        return False
    if (c.get("source") or "").strip().lower().endswith("outbound"):
        return False
    if re.search(r"\btest\b", (c.get("contactName") or ""), re.I):
        return False
    # PHR dashboard excludes do-not-contact leads from the funnel widgets. The signal is the
    # 'mass dnd' tag (the GHL dnd property is not set on these), confirmed 2026-07-21.
    if any("mass dnd" in (t or "").lower() or (t or "").strip().lower() == "dnd"
           for t in (c.get("tags") or [])):
        return False
    return True


def _widen(day, delta):
    """Shift a 'YYYY-MM-DD' string by delta days, returning 'YYYY-MM-DD'."""
    return (_dt.strptime(day, "%Y-%m-%d") + _td(days=delta)).strftime("%Y-%m-%d")


def _field_label(c, field_id):
    """The YYYY-MM-DD date label stored in custom field field_id on contact c, or None.
    GHL stores these as 'YYYY-MM-DDT00:00:00.000Z'; we compare the calendar-date prefix so
    the account-timezone shift in GHL's range filter cannot move a contact across the
    week boundary."""
    for cf in (c.get("customFields") or []):
        if cf.get("id") == field_id:
            v = cf.get("value", cf.get("field_value", cf.get("fieldValue")))
            return str(v)[:10] if v else None
    return None


def _milestone_count(field_id, frm, to, retries=3):
    """POST /contacts/search for contacts whose custom DATE field falls in [frm,to], then
    count those passing _ms_passes. Returns (count, capped_bool). Loud on failure."""
    key, loc = _config()
    # Widen the query by 2 days each side so the timezone shift in GHL's range filter cannot
    # hide a boundary contact; we re-filter exactly on the date label below.
    body = json.dumps({
        "locationId": loc, "pageLimit": 100,
        "filters": [{"field": "customFields." + field_id, "operator": "range",
                     "value": {"gte": _widen(frm, -2), "lte": _widen(to, 2)}}],
    }).encode()
    url = f"{BASE_URL}/contacts/search"
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Version", "2021-07-28")
        req.add_header("Content-Type", "application/json")
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent",
                       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                d = json.load(resp)
            contacts = d.get("contacts", []) or []
            kept = 0
            for c in contacts:
                label = _field_label(c, field_id)          # actual stored date, e.g. 2026-07-12
                if label is None or not (frm <= label <= to):
                    continue                                # outside the true reporting week
                if _ms_passes(c):
                    kept += 1
            return kept, (d.get("total", 0) > len(contacts))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                _time.sleep(1.5 * (attempt + 1)); continue
            raise GHLError("contacts/search failed for " + field_id,
                           status=e.code, detail=e.read().decode()[:300], url=url)
        except Exception as e:  # noqa
            if attempt < retries:
                _time.sleep(1.0); continue
            raise GHLError(f"contacts/search error for {field_id}: {e}", url=url)


def cmd_milestones(args):
    """Weekly funnel milestone counts by custom DATE field. proposal_sent,
    design_agreement_signed, construction_agreement_signed are the weekly counts the
    open-pipeline snapshot cannot provide."""
    frm, to = args.frm, args.to
    counts, gaps = {}, []
    with ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(_milestone_count, fid, frm, to): name for name, fid in MILESTONE_FIELDS}
        for fut in as_completed(futs):
            name = futs[fut]
            try:
                cnt, capped = fut.result()
                counts[name] = cnt
                if capped:
                    gaps.append(f"{name}: over 100 in window; count may be capped.")
            except GHLError as e:
                counts[name] = None
                gaps.append(f"{name} unavailable: {e}")
    gaps.append("Counts are by each milestone's custom DATE field (when the event happened), "
                "matching PHR dashboard widgets; NOT by contact created date. Same homeowner/"
                "outbound/test filters as qualified leads are applied. proposal_sent, "
                "design_agreement_signed and construction_agreement_signed are the true weekly "
                "counts (the open-pipeline snapshot only gives current stage occupancy). NOTE: "
                "scheduled counts are filtered on the stored date LABEL (YYYY-MM-DD), which matches the "
                "PHR dashboard exactly; a prior timezone shift in GHL's range filter (bounds read "
                "in account time vs dates stored at UTC midnight) was corrected 2026-07-21, "
                "verified name-for-name against the dashboard DC-scheduled records for Jul 12-18.")
    return _envelope("milestones", {"from": frm, "to": to},
                     [{"milestone": k, "count": v} for k, v in counts.items()],
                     gaps=gaps, extra={"counts": counts})


def main():
    p = argparse.ArgumentParser(prog="ghl_client.py", description="Read-only GHL v2 connector (PHR MCD)")
    sub = p.add_subparsers(dest="command", required=True)

    def add_range(sp):
        sp.add_argument("--from", dest="frm", required=True, help="YYYY-MM-DD")
        sp.add_argument("--to", dest="to", required=True, help="YYYY-MM-DD")

    sp = sub.add_parser("leads"); add_range(sp); sp.add_argument("--source", default=None)
    sp = sub.add_parser("pipeline"); sp.add_argument("--status", default="open",
        choices=["open", "won", "lost", "abandoned", "all"])
    sp = sub.add_parser("appointments"); add_range(sp); sp.add_argument("--calendar-id", dest="calendar_id", default=None)
    sp = sub.add_parser("opportunities"); add_range(sp); sp.add_argument("--status", default=None,
        choices=["open", "won", "lost", "abandoned", "all"])
    sp = sub.add_parser("calls"); add_range(sp)
    sp = sub.add_parser("milestones"); add_range(sp)

    args = p.parse_args()
    handlers = {
        "leads": cmd_leads, "pipeline": cmd_pipeline, "appointments": cmd_appointments,
        "opportunities": cmd_opportunities, "calls": cmd_calls,
        "milestones": cmd_milestones,
    }
    try:
        result = handlers[args.command](args)
        print(json.dumps(result, indent=2))
        return 0
    except GHLError as e:
        err = {
            "connector": CONNECTOR,
            "command": args.command,
            "error": str(e),
            "status": e.status,
            "detail": e.detail,
            "url": e.url,
        }
        print(json.dumps(err, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
