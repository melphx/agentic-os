#!/usr/bin/env python3
"""call-feedback-reader: read-only connector for the OpenAI call/appointment
feedback sheet (Justin Discovery Calls, Rebekah in-homes, receptionist, widget).

Auth: Google service account (CALL_FEEDBACK_SA_JSON) with spreadsheets.readonly.
Sheet: CALL_FEEDBACK_SHEET_ID. Commands: ratings | feedback | summaries | trend | transcript.
Echoes its query + date range, includes GHL IDs for joining to ghl-reader,
excludes emails/phones/recording links, loud failure on any error (exit 1).
NOTE: rows discuss named team members; reports built on this go ONLY to the
private MCD Reports space (Sensitive Output Rule)."""
import argparse, json, os, sys, urllib.request, urllib.parse
from datetime import datetime, date, timedelta

TABS = {
    "justin": "Justin's Phone Consultation Feedback",
    "rebekah": "Rebekah In-Home Consultation Feedback",
    "receptionist": "Receptionist Inbound Call Feedback",
    "widget": "AI Widget Call Feedback",
}
ANALYSIS_TRUNC = 1800
DATE_NOTE = ("dates are the sheet Date Added (when the row was logged), not a verified "
             "call timestamp; logging can lag the call, so week boundaries are "
             "approximate and sheet counts will not reconcile with GHL appointment "
             "dates.")


class CFError(Exception):
    pass


def _die(msg):
    print(json.dumps({"connector": "call-feedback-reader", "error": str(msg)}), file=sys.stderr)
    sys.exit(1)


def _token():
    sa = os.environ.get("CALL_FEEDBACK_SA_JSON", "").strip()
    if not sa:
        raise CFError("CALL_FEEDBACK_SA_JSON is not set in the environment.")
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def _sheet_id():
    sid = os.environ.get("CALL_FEEDBACK_SHEET_ID", "").strip()
    if not sid:
        raise CFError("CALL_FEEDBACK_SHEET_ID is not set in the environment.")
    return sid


def _batch_get(ranges):
    sid, tok = _sheet_id(), _token()
    qs = "&".join("ranges=" + urllib.parse.quote(r, safe="") for r in ranges)
    url = (f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values:batchGet?"
           f"majorDimension=COLUMNS&{qs}")
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        raise CFError(f"Sheets API HTTP {e.code}: {e.read().decode()[:300]}")
    out = []
    for vr in d.get("valueRanges", []):
        cols = vr.get("values") or [[]]
        out.append(cols[0] if cols else [])
    return out


def _parse_day(s):
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            continue
    return None


def _parse_rating(s):
    if not s:
        return None
    t = str(s).strip().split("/")[0].strip()
    try:
        v = float(t)
        return v if 0 <= v <= 5 else None
    except ValueError:
        return None


def _load_tab(tab_key, want_analysis=False):
    """Return list of dicts for the tab: sheet row number, date, name,
    rating(raw+parsed), ghl_id[, analysis]."""
    tab = TABS[tab_key]
    ranges = [f"{tab}!A2:A", f"{tab}!D2:D", f"{tab}!H2:H", f"{tab}!I2:I"]
    if want_analysis:
        ranges.append(f"{tab}!G2:G")
    cols = _batch_get(ranges)
    names, dates, ratings, ghl = cols[0], cols[1], cols[2], cols[3]
    analysis = cols[4] if want_analysis else []
    n = max(len(names), len(dates), len(ratings), len(ghl))
    rows = []
    for i in range(n):
        d = _parse_day(dates[i]) if i < len(dates) and dates[i] else None
        if d is None:
            continue
        raw = ratings[i] if i < len(ratings) else ""
        rec = {"row": i + 2,
               "date": d.isoformat(), "name": (names[i] if i < len(names) else "").strip(),
               "rating": _parse_rating(raw), "rating_raw": (str(raw).strip()[:40] or None),
               "ghl_id": (ghl[i] if i < len(ghl) else "").strip() or None}
        if want_analysis:
            a = analysis[i] if i < len(analysis) else ""
            rec["analysis"] = (a[:ANALYSIS_TRUNC] + " ...[truncated]") if len(a) > ANALYSIS_TRUNC else a
        rows.append(rec)
    return rows


def _window(rows, frm, to):
    f, t = _parse_day(frm), _parse_day(to)
    if not f or not t:
        raise CFError("bad --from/--to date (use YYYY-MM-DD)")
    return [r for r in rows if f <= date.fromisoformat(r["date"]) <= t]


def _envelope(command, query, records, gaps=None, extra=None):
    out = {"connector": "call-feedback-reader", "command": command, "query": query,
           "source": "Google Sheet: Open AI Employee Call and Appt FeedBack Analysis",
           "count": len(records), "records": records, "gaps": gaps or []}
    if extra:
        out.update(extra)
    print(json.dumps(out, indent=1))


def cmd_ratings(args):
    rows = _window(_load_tab(args.tab), args.frm, args.to)
    rated = [r for r in rows if r["rating"] is not None]
    unrated = [r for r in rows if r["rating"] is None]
    dist = {}
    for r in rated:
        k = str(int(round(r["rating"])))
        dist[k] = dist.get(k, 0) + 1
    gaps = [DATE_NOTE]
    if unrated:
        gaps.append(f"{len(unrated)} call(s) in window had no numeric rating "
                    "(evaluator error rows); excluded from avg_rating.")
    if args.tab == "receptionist":
        gaps.append("receptionist tab has analyses but generally NO ratings; expect avg_rating null.")
    recs = [{k: r[k] for k in ("date", "name", "rating", "ghl_id")} for r in rows]
    _envelope("ratings", {"tab": args.tab, "from": args.frm, "to": args.to}, recs, gaps=gaps,
              extra={"calls_in_window": len(rows), "rated_calls": len(rated),
                     "avg_rating": (round(sum(r["rating"] for r in rated) / len(rated), 2) if rated else None),
                     "rating_distribution": dict(sorted(dist.items()))})


def cmd_feedback(args):
    rows = _window(_load_tab(args.tab, want_analysis=True), args.frm, args.to)
    rated = [r for r in rows if r["rating"] is not None]
    rated.sort(key=lambda r: (r["rating"], r["date"]))
    worst = [{k: r[k] for k in ("date", "name", "rating", "ghl_id", "analysis")}
             for r in rated[:args.worst]]
    gaps = [DATE_NOTE]
    if not rated:
        gaps.append("no rated calls in window; nothing to rank.")
    _envelope("feedback", {"tab": args.tab, "from": args.frm, "to": args.to, "worst": args.worst},
              worst, gaps=gaps,
              extra={"calls_in_window": len(rows), "rated_calls": len(rated),
                     "note": "records are the LOWEST-rated calls in the window with the "
                             "evaluator analysis; use for improvement themes, never quote "
                             "homeowner details outside the private space."})


IMPROV_MARKERS = ("areas for improvement", "areas of improvement", "missed opportunit",
                  "recommendations", "weaknesses", "improvement")


def _compact(analysis, head, improv):
    """Head of the evaluator analysis + the first improvement-flavored section."""
    a = analysis or ""
    low = a.lower()
    pos = -1
    for m in IMPROV_MARKERS:
        p = low.find(m)
        if p >= 0 and (pos < 0 or p < pos):
            pos = p
    if pos < 0:
        return a[:head + improv]
    if pos < head:
        return a[:min(len(a), pos + improv)]
    return a[:head] + " [...] " + a[pos:pos + improv]


def cmd_summaries(args):
    """ALL rated evaluations in the window, compacted for monthly pattern review
    (recurrence across summaries, per Jeremy). Not for verbatim quoting."""
    tab = TABS[args.tab]
    rows = _window(_load_tab(args.tab), args.frm, args.to)
    rated = [r for r in rows if r["rating"] is not None]
    gcol = _batch_get([f"{tab}!G2:G"])[0]
    recs = []
    for r in rated:
        a = gcol[r["row"] - 2] if 0 <= r["row"] - 2 < len(gcol) else ""
        recs.append({"date": r["date"], "rating": r["rating"], "ghl_id": r["ghl_id"],
                     "summary": _compact(a, args.head, args.improv)})
    gaps = [DATE_NOTE,
            f"{len(rows) - len(rated)} unrated row(s) excluded.",
            "each record is a COMPACTED evaluator analysis (summary head plus first "
            "improvement section); use for recurrence patterns, not verbatim quoting; "
            "voicemails/fragments still present, filter by reading the text."]
    _envelope("summaries", {"tab": args.tab, "from": args.frm, "to": args.to}, recs,
              gaps=gaps,
              extra={"rated_calls": len(rated),
                     "total_chars": sum(len(x["summary"]) for x in recs)})


def cmd_transcript(args):
    """Full transcript + full evaluator analysis for ONE specific call.
    Match by --ghl-id (exact) or --name (case-insensitive substring), optionally
    narrowed by --date. Multiple matches return metadata only, asking for --date."""
    if not args.ghl_id and not args.name:
        raise CFError("pass --ghl-id or --name to identify the call")
    rows = _load_tab(args.tab)
    m = rows
    if args.ghl_id:
        m = [r for r in m if (r["ghl_id"] or "") == args.ghl_id]
    if args.name:
        m = [r for r in m if args.name.lower() in r["name"].lower()]
    if args.date:
        m = [r for r in m if r["date"] == args.date]
    meta = [{k: r[k] for k in ("date", "name", "rating", "ghl_id")} for r in m]
    if len(m) != 1:
        gap = (f"{len(m)} calls match; narrow with --date (or exact --ghl-id)."
               if m else "no matching call in this tab.")
        _envelope("transcript", vars_query(args), meta, gaps=[gap])
        return
    row = m[0]["row"]
    tab = TABS[args.tab]
    cols = _batch_get([f"{tab}!F{row}:F{row}", f"{tab}!G{row}:G{row}"])
    transcript = cols[0][0] if cols[0] else ""
    analysis = cols[1][0] if cols[1] else ""
    gaps = []
    if len(transcript) > args.max_chars:
        gaps.append(f"transcript truncated to {args.max_chars} of {len(transcript)} chars "
                    "(raise --max-chars for the rest).")
        transcript = transcript[:args.max_chars] + " ...[truncated]"
    rec = dict(meta[0])
    rec["transcript"] = transcript
    rec["evaluator_analysis"] = analysis
    _envelope("transcript", vars_query(args), [rec], gaps=gaps,
              extra={"note": "SENSITIVE: full homeowner conversation; private MCD Reports "
                             "space only; quote short excerpts, never the whole call."})


def vars_query(args):
    return {"tab": args.tab, "ghl_id": args.ghl_id, "name": args.name, "date": args.date}


def cmd_trend(args):
    rows = _load_tab(args.tab)
    rated = [r for r in rows if r["rating"] is not None]
    today = date.today()
    last_sunday = today - timedelta(days=(today.weekday() + 1) % 7)
    weeks = []
    for i in range(args.weeks):
        w_end = last_sunday - timedelta(days=7 * i)
        w_start = w_end - timedelta(days=6)
        wk = [r for r in rated if w_start <= date.fromisoformat(r["date"]) <= w_end]
        weeks.append({"week": f"{w_start.isoformat()}..{w_end.isoformat()}",
                      "rated_calls": len(wk),
                      "avg_rating": (round(sum(r["rating"] for r in wk) / len(wk), 2) if wk else None)})
    weeks.reverse()
    _envelope("trend", {"tab": args.tab, "weeks": args.weeks}, weeks, gaps=[DATE_NOTE])


def main():
    p = argparse.ArgumentParser(description="Call feedback sheet reader (read-only)")
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("ratings", "feedback", "summaries"):
        sp = sub.add_parser(name)
        sp.add_argument("--from", dest="frm", required=True)
        sp.add_argument("--to", dest="to", required=True)
        sp.add_argument("--tab", choices=list(TABS), default="justin")
        if name == "feedback":
            sp.add_argument("--worst", type=int, default=5)
        if name == "summaries":
            sp.add_argument("--head", type=int, default=400)
            sp.add_argument("--improv", type=int, default=500)
    sp = sub.add_parser("trend")
    sp.add_argument("--weeks", type=int, default=8)
    sp.add_argument("--tab", choices=list(TABS), default="justin")
    sp = sub.add_parser("transcript")
    sp.add_argument("--tab", choices=list(TABS), default="justin")
    sp.add_argument("--ghl-id", dest="ghl_id", default=None)
    sp.add_argument("--name", default=None)
    sp.add_argument("--date", default=None, help="YYYY-MM-DD, narrows multiple matches")
    sp.add_argument("--max-chars", dest="max_chars", type=int, default=15000)
    args = p.parse_args()
    try:
        {"ratings": cmd_ratings, "feedback": cmd_feedback, "trend": cmd_trend,
         "transcript": cmd_transcript, "summaries": cmd_summaries}[args.command](args)
    except CFError as e:
        _die(e)
    except Exception as e:
        _die(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
