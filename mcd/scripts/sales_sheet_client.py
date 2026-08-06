#!/usr/bin/env python3
"""sales-sheet-reader: read PHR's own "Weekly Sales Report" Google Sheet (read-only).

This is the business's source of truth for the weekly funnel. MCD reads it to CHECK ITS OWN
NUMBERS against what PHR records, and to pull PHR's real baselines instead of hardcoded ones.

Auth: service account, spreadsheets.readonly scope. Env:
  SALES_SHEET_ID        spreadsheet id (required)
  SALES_SHEET_SA_JSON   service-account json path (falls back to CALL_FEEDBACK_SA_JSON)

PRIVACY GUARD: the sheet's right-hand area holds individual client names, project amounts and
a block literally labelled "DO NOT TOUCH THIS AREA OR SHOW IN REPORTS". This connector returns
ONLY the WEEKLY METRICS columns, by header whitelist. It can never surface client or revenue
detail even though the tab contains it.

Commands:
  week --week-of YYYY-MM-DD   the sheet's row for the week starting that Sunday
  baselines                   the AVERAGE and TOTAL rows for the year
  weeks --limit N             the last N populated weeks (trend context)
"""
import argparse, json, os, re, sys

METRIC_HEADERS = [
    "New Qualified Leads",
    "Discovery Calls Scheduled",
    "Discovery Calls Cancelled",
    "Discovery Calls No-Shows",
    "Discovery Calls Completed",
    "In-Homes Scheduled",
    "In-Homes Cancelled",
    "In-Homes Completed",
    "Proposal Sent",
    "DB Agreement Signed",
    "Construction Agreement Signed",
    "Lead to Discovery Call Completed",
    "Discovery Call to In-home Scheduled",
    "Discovery Call to In-home Completed",
    "Proposal to Design",
]
MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


class SheetError(Exception):
    pass


def out(payload, gaps):
    payload["gaps"] = gaps
    payload["source"] = "PHR Weekly Sales Report (Google Sheet), read-only"
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def _svc():
    sid = os.environ.get("SALES_SHEET_ID", "").strip()
    sa = (os.environ.get("SALES_SHEET_SA_JSON", "").strip()
          or os.environ.get("CALL_FEEDBACK_SA_JSON", "").strip())
    if not sid:
        raise SheetError("SALES_SHEET_ID is not set in the environment.")
    if not sa or not os.path.exists(sa):
        raise SheetError("service-account json not found (SALES_SHEET_SA_JSON / CALL_FEEDBACK_SA_JSON).")
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    return build("sheets", "v4", credentials=creds, cache_discovery=False), sid


def _grid(tab):
    """Rows of the WEEKLY METRICS block only (cols A..T), plus the header index map."""
    svc, sid = _svc()
    try:
        vals = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="%s!A1:T60" % tab).execute().get("values", [])
    except Exception as e:  # noqa
        raise SheetError("could not read tab %r: %s" % (tab, str(e)[:200]))
    if not vals:
        raise SheetError("tab %r came back empty" % tab)
    # locate the header row (the one containing "New Qualified Leads")
    hdr_i = next((i for i, r in enumerate(vals)
                  if any((c or "").strip() == "New Qualified Leads" for c in r)), None)
    if hdr_i is None:
        raise SheetError("header row not found in tab %r (no 'New Qualified Leads' cell)" % tab)
    hdr = [(c or "").strip() for c in vals[hdr_i]]
    idx = {}
    for want in METRIC_HEADERS:
        # headers can carry stray whitespace/newlines in the sheet
        j = next((k for k, c in enumerate(hdr)
                  if re.sub(r"\s+", " ", c).lower() == want.lower()), None)
        if j is not None:
            idx[want] = j
    return vals, hdr_i, idx


def _num(s):
    s = (s or "").strip().replace(",", "")
    if s in ("", "-", "N/A", "#DIV/0!"):
        return None
    if s.endswith("%"):
        try:
            return round(float(s[:-1]) / 100.0, 6)
        except ValueError:
            return s
    try:
        f = float(s)
        return int(f) if f == int(f) else f
    except ValueError:
        return s


def _row_values(row, idx):
    return {h: _num(row[j]) if j < len(row) else None for h, j in idx.items()}


def _label_date(label, year):
    """'Week of Jul 26th' -> (year, 7, 26); None if the label is not a week row."""
    m = re.search(r"week\s+of\s+([A-Za-z]+)\s+(\d{1,2})", label or "", re.I)
    if not m:
        return None
    mon = MONTHS.get(m.group(1)[:3].lower())
    return (year, mon, int(m.group(2))) if mon else None


def cmd_week(args):
    gaps = []
    y, mo, d = (int(x) for x in args.week_of.split("-"))
    tab = str(y)
    vals, hdr_i, idx = _grid(tab)
    missing = [h for h in METRIC_HEADERS if h not in idx]
    if missing:
        gaps.append("columns not found in the sheet, returned as null: %s" % ", ".join(missing))
    hit = None
    for row in vals[hdr_i + 1:]:
        lbl = (row[0] if row else "") or ""
        if _label_date(lbl, y) == (y, mo, d):
            hit = (lbl, row)
            break
    if not hit:
        out({"week_of": args.week_of, "found": False,
             "values": {h: None for h in METRIC_HEADERS}},
            gaps + ["no row in tab %s matches the week starting %s. PHR may not have filled it "
                    "in yet (they fill it in after the week closes). Treat the sheet as "
                    "UNAVAILABLE for this week rather than as zeros." % (tab, args.week_of)])
        return
    lbl, row = hit
    v = _row_values(row, idx)
    blank = [h for h, x in v.items() if x is None]
    if blank:
        gaps.append("sheet cells blank for: %s (PHR had not filled these in at read time)"
                    % ", ".join(blank))
    out({"week_of": args.week_of, "sheet_row_label": lbl, "found": True, "values": v}, gaps)


def cmd_baselines(args):
    tab = args.year
    vals, hdr_i, idx = _grid(tab)
    res = {}
    for row in vals[hdr_i + 1:]:
        tag = ((row[0] if row else "") or "").strip().upper()
        if tag in ("AVERAGE", "TOTAL"):
            res[tag.lower()] = _row_values(row, idx)
    gaps = [] if res else ["AVERAGE / TOTAL rows not found in tab %s" % tab]
    out({"year": tab, "baselines": res,
         "note": "AVERAGE is PHR's own year-to-date weekly average. Use it as the baseline "
                 "instead of any hardcoded number."}, gaps)


def cmd_weeks(args):
    tab = args.year
    vals, hdr_i, idx = _grid(tab)
    rows = []
    for row in vals[hdr_i + 1:]:
        lbl = ((row[0] if row else "") or "").strip()
        if not _label_date(lbl, int(tab)):
            continue
        v = _row_values(row, idx)
        if all(x is None for x in v.values()):
            continue                                    # future/unfilled week
        rows.append({"sheet_row_label": lbl, "values": v})
    rows = rows[-args.limit:]
    out({"year": tab, "weeks": rows, "count": len(rows)}, [])


def main():
    ap = argparse.ArgumentParser(description="Read PHR's Weekly Sales Report sheet (read-only).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("week", help="the sheet row for the week starting this Sunday")
    w.add_argument("--week-of", required=True, help="YYYY-MM-DD, must be the reporting Sunday")
    w.set_defaults(fn=cmd_week)
    b = sub.add_parser("baselines", help="PHR's own AVERAGE and TOTAL rows")
    b.add_argument("--year", default="2026")
    b.set_defaults(fn=cmd_baselines)
    t = sub.add_parser("weeks", help="last N populated weeks")
    t.add_argument("--year", default="2026")
    t.add_argument("--limit", type=int, default=8)
    t.set_defaults(fn=cmd_weeks)
    a = ap.parse_args()
    try:
        a.fn(a)
    except SheetError as e:
        json.dump({"error": str(e), "gaps": ["sales-sheet-reader unavailable: %s" % e]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
