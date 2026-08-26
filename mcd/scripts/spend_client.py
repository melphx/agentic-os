#!/usr/bin/env python3
"""spend-reader: PHR's "PHR Marketing Spend" sheet (read-only).

Jeremy maintains monthly spend per paid source there; this reads it so the report can work out
cost per lead and cost per Discovery Call. He edits a cell, we pick it up, nobody is in the loop.

Auth: service account, spreadsheets.readonly. Env:
  SPEND_SHEET_ID    spreadsheet id (required)
  SPEND_SA_JSON     service-account json path (falls back to CALL_FEEDBACK_SA_JSON)

THE ONE RULE THAT MATTERS: a blank Amount means NOT KNOWN YET, never zero. Treating a blank as
zero would understate cost per lead and produce a confidently wrong number, which is exactly the
class of bug that put a wrong Discovery Call figure in front of the owner once already. This
connector reports blanks explicitly and marks the month INCOMPLETE.

Commands:
  spend [--month YYYY-MM]   spend rows for a month (default: latest month that has any data)
  months                    which months have data
  mapping                   how each spend source maps to GHL lead sources
"""
import argparse, json, os, re, sys

_MERGE_GAPS = []
TAB_SPEND = "Monthly Spend"
TAB_MAP = "Source Mapping"


class SpendError(Exception):
    pass


def out(payload, gaps):
    payload["gaps"] = gaps
    payload["source"] = "PHR Marketing Spend (Google Sheet), read-only"
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def _svc():
    sid = os.environ.get("SPEND_SHEET_ID", "").strip()
    sa = (os.environ.get("SPEND_SA_JSON", "").strip()
          or os.environ.get("CALL_FEEDBACK_SA_JSON", "").strip())
    if not sid:
        raise SpendError("SPEND_SHEET_ID is not set in the environment.")
    if not sa or not os.path.exists(sa):
        raise SpendError("service-account json not found (SPEND_SA_JSON / CALL_FEEDBACK_SA_JSON).")
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    return build("sheets", "v4", credentials=creds, cache_discovery=False), sid


def _table(tab, want_headers):
    """Return (rows_below_header, header_index_map). Headers are located by TEXT, so inserting a
    row or column above the table cannot silently shift the data."""
    svc, sid = _svc()
    try:
        vals = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="%s!A1:F200" % tab,
            valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    except Exception as e:  # noqa
        raise SpendError("could not read tab %r: %s" % (tab, str(e)[:200]))
    def _is_hdr_cell(cell, word):
        # a real header cell is SHORT and STARTS with the word. Prose above the table can
        # contain the same words (it did), so substring matching is not safe here.
        c = re.sub(r"\s+", " ", str(cell or "").strip().lower())
        return len(c) <= 30 and c.startswith(word)

    hdr_i = None
    for i, r in enumerate(vals):
        if all(any(_is_hdr_cell(c, w) for c in r) for w in want_headers):
            hdr_i = i
            break
    if hdr_i is None:
        raise SpendError("header row not found in %r (looking for %s)" % (tab, want_headers))
    hdr = [str(c or "").strip() for c in vals[hdr_i]]
    idx = {}
    for j, h in enumerate(hdr):
        idx[re.sub(r"\s+", " ", h).lower()] = j
    return vals[hdr_i + 1:], idx


def _col(idx, *cands):
    for c in cands:
        for k, j in idx.items():
            if k.startswith(c):
                return j
    return None


def _month(v):
    """Return YYYY-MM, or (None, raw) if it cannot be read.

    Sheets stores a typed "2026-08" as a date serial (days since 1899-12-30), so a numeric value
    here is a date, not a literal month label.
    """
    import datetime
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        try:
            d = datetime.date(1899, 12, 30) + datetime.timedelta(days=int(v))
            return d.strftime("%Y-%m")
        except (ValueError, OverflowError):
            return None
    t = str(v).strip()
    m = re.match(r"^(\d{4})[-/](\d{1,2})", t)
    if m:
        return "%s-%02d" % (m.group(1), int(m.group(2)))
    return None


def _amount(v):
    """Return (value_or_None, was_blank). Blank means NOT KNOWN, never zero."""
    if v is None:
        return None, True
    if isinstance(v, (int, float)):
        return float(v), False
    s = str(v).strip().replace("$", "").replace(",", "")
    if not s:
        return None, True
    try:
        return float(s), False
    except ValueError:
        return None, True


LSA_SOURCE = "Google Local Service Ads"
_MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def _find_tab(want):
    """Tab titles can carry stray spaces (Jeremy's is 'LSA spend '), so match on stripped name."""
    svc, sid = _svc()
    meta = svc.spreadsheets().get(spreadsheetId=sid).execute()
    for sh in meta.get("sheets", []):
        t = sh["properties"]["title"]
        if t.strip().lower() == want.strip().lower():
            return t
    return None


def _lsa_rows():
    """Jeremy's per-month LSA spend. Returns (rows, gaps).

    The tab carries no year. We assume the current calendar year because he described it as
    "this year's costs", and we disclose that assumption rather than hide it.
    """
    import datetime
    gaps, rows = [], []
    tab = _find_tab("LSA spend")
    if not tab:
        return rows, ["no 'LSA spend' tab found; Local Service Ads spend will show as unknown"]
    svc, sid = _svc()
    try:
        vals = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="'%s'!A1:C40" % tab,
            valueRenderOption="UNFORMATTED_VALUE").execute().get("values", [])
    except Exception as e:  # noqa
        return rows, ["could not read the %r tab: %s" % (tab, str(e)[:150])]
    year = datetime.date.today().year
    unread = []
    for r in vals:
        if not r:
            continue
        label = str(r[0] or "").strip().lower()
        if not label:
            continue
        mo = _MONTHS.get(label[:3])
        if not mo:
            if label not in ("month", "lsa spend", "total"):
                unread.append(str(r[0])[:24])
            continue
        amt, blank = _amount(r[1] if len(r) > 1 else None)
        rows.append({"month": "%d-%02d" % (year, mo), "source": LSA_SOURCE,
                     "amount": amt, "amount_known": not blank,
                     "notes": "from the '%s' tab, which Jeremy updates monthly" % tab.strip()})
    if rows:
        gaps.append("Local Service Ads spend comes from the '%s' tab, which has month names but no "
                    "year. Assumed %d because Jeremy described it as this year's costs. If a new "
                    "year is added to that tab this assumption breaks, so check it in January."
                    % (tab.strip(), year))
    if unread:
        gaps.append("rows in the '%s' tab whose month could not be read, ignored: %s"
                    % (tab.strip(), ", ".join(unread[:6])))
    return rows, gaps


def _spend_rows():
    rows, idx = _table(TAB_SPEND, ["month", "source", "amount"])
    c_month = _col(idx, "month")
    c_src = _col(idx, "source")
    c_amt = _col(idx, "amount")
    c_note = _col(idx, "note")
    outr = []
    for r in rows:
        def g(j):
            return r[j] if (j is not None and j < len(r)) else None
        raw_month = g(c_month)
        month = _month(raw_month)
        src = str(g(c_src) or "").strip()
        if not src or raw_month in (None, ""):
            continue
        if month is None:
            outr.append({"month": None, "raw_month": str(raw_month)[:40], "source": src,
                         "amount": None, "amount_known": False,
                         "notes": "UNREADABLE MONTH VALUE"})
            continue
        amt, blank = _amount(g(c_amt))
        outr.append({"month": month, "source": src, "amount": amt,
                     "amount_known": not blank,
                     "notes": str(g(c_note) or "").strip() or None})

    # merge in the LSA tab. It is the authoritative source for Local Service Ads because that is
    # where Jeremy maintains it; the placeholder row on Monthly Spend stays blank by design.
    lsa, lsa_gaps = _lsa_rows()
    _MERGE_GAPS.clear()
    _MERGE_GAPS.extend(lsa_gaps)
    for L in lsa:
        hit = next((r for r in outr
                    if r["month"] == L["month"] and "local service" in r["source"].lower()), None)
        if hit is None:
            outr.append(L)
            continue
        if hit["amount_known"] and L["amount_known"] and hit["amount"] != L["amount"]:
            _MERGE_GAPS.append(
                "CONFLICT for %s Local Service Ads: Monthly Spend says %s but the LSA spend tab "
                "says %s. Using the LSA tab, since that is where Jeremy maintains it. Someone "
                "should clear the duplicate." % (L["month"], hit["amount"], L["amount"]))
        if L["amount_known"]:
            hit["amount"] = L["amount"]
            hit["amount_known"] = True
            hit["notes"] = L["notes"]
    return outr


def cmd_months(args):
    rows = _spend_rows()
    extra = list(_MERGE_GAPS)
    ms = {}
    for r in rows:
        d = ms.setdefault(r["month"], {"month": r["month"], "sources": 0, "with_amount": 0})
        d["sources"] += 1
        if r["amount_known"]:
            d["with_amount"] += 1
    listed = sorted(ms.values(), key=lambda d: d["month"])
    out({"command": "months", "months": listed},
        extra + ([] if listed else ["no spend rows found; the sheet may be empty"]))


def cmd_spend(args):
    rows = _spend_rows()
    gaps = list(_MERGE_GAPS)
    if not rows:
        out({"command": "spend", "month": args.month, "sources": [], "complete": False},
            ["no spend rows found in the sheet"])
        return
    month = args.month
    if not month:
        with_data = [r["month"] for r in rows if r["amount_known"]]
        month = max(with_data) if with_data else max(r["month"] for r in rows)
        gaps.append("no --month given, used the latest month with any amount filled in (%s)" % month)
    sel = [r for r in rows if r["month"] == month]
    if not sel:
        out({"command": "spend", "month": month, "sources": [], "complete": False},
            gaps + ["no rows for %s. Jeremy may not have filled that month in yet. Treat spend as "
                    "UNAVAILABLE for this period, never as zero." % month])
        return
    bad = [r for r in rows if r.get("month") is None]
    if bad:
        gaps.append("%d row(s) have a Month value this connector cannot read (e.g. %r). They are "
                    "excluded. Month should be YYYY-MM or a date."
                    % (len(bad), bad[0].get("raw_month")))
    known = [r for r in sel if r["amount_known"]]
    blank_amount = [r["source"] for r in sel if not r["amount_known"]]

    # Judge completeness against the canonical source list, not just the rows that exist.
    # A mapped source with NO row for this month is unknown too, and silently ignoring that is
    # how a partial month gets published as a total.
    canonical = []
    try:
        rows_map, idx_map = _table(TAB_MAP, ["spend source", "ghl"])
        c_s = _col(idx_map, "spend source")
        for r in rows_map:
            v = str(r[c_s]).strip() if (c_s is not None and c_s < len(r) and r[c_s]) else ""
            if v:
                canonical.append(v)
    except SpendError:
        canonical = sorted({r["source"] for r in rows})
        gaps.append("source mapping unreadable, so completeness is judged against the sources seen "
                    "anywhere in the sheet rather than the canonical list")

    present = {r["source"].strip().lower() for r in sel}
    no_row = [c for c in canonical if c.strip().lower() not in present]
    missing = blank_amount + no_row

    payload = {"command": "spend", "month": month,
               "sources": sel,
               "known_spend_total": round(sum(r["amount"] for r in known), 2),
               "sources_with_amount": len(known),
               "sources_missing_amount": missing,
               "no_row_for_month": no_row,
               "blank_amount": blank_amount,
               "canonical_sources": canonical,
               "complete": not missing}
    if missing:
        bits = []
        if blank_amount:
            bits.append("blank amount for %s" % ", ".join(blank_amount))
        if no_row:
            bits.append("NO ROW AT ALL for %s (these are paid sources that probably did spend "
                        "money this month, they are simply not entered)" % ", ".join(no_row))
        gaps.append("INCOMPLETE MONTH (%s). known_spend_total is a FLOOR covering only %d of %d "
                    "known sources, NOT the real total for the month. Do NOT present it as total "
                    "spend, do NOT treat a missing source as zero, and do NOT publish a blended "
                    "cost per lead for this month. Cost per lead for an individual source whose "
                    "amount IS known is still valid."
                    % ("; ".join(bits), len(known), len(canonical) or len(sel)))
    try:
        rows_map, idx = _table(TAB_MAP, ["spend source", "ghl"])
        c_s = _col(idx, "spend source")
        c_g = _col(idx, "ghl")
        c_n = _col(idx, "note")
        m = []
        for r in rows_map:
            def g(j):
                return str(r[j]).strip() if (j is not None and j < len(r) and r[j]) else None
            if g(c_s):
                m.append({"spend_source": g(c_s), "ghl_lead_sources": g(c_g), "notes": g(c_n)})
        payload["mapping"] = m
    except SpendError as e:
        gaps.append("source mapping unavailable (%s); do not guess which GHL lead sources a spend "
                    "line covers" % e)
    gaps.append("Cost per lead is computed BY YOU, not by this connector: divide a source's spend "
                "by that source's qualified leads for the SAME month, using the mapping above to "
                "decide which GHL lead sources count. Never divide total spend by total leads "
                "while any source is missing an amount.")
    gaps.append("SEO & GBP is a BLENDED figure covering organic search and the Google Business "
                "Profile together, across several lead-source labels. Report it as directional, "
                "not as a precise per-channel cost.")
    gaps.append("Google Local Service Ads bills PER LEAD and rejected leads can be refunded, so "
                "its monthly amount is what was actually charged and will vary a lot month to "
                "month. Do not annualise it from one month.")
    out(payload, gaps)


def cmd_mapping(args):
    rows, idx = _table(TAB_MAP, ["spend source", "ghl"])
    c_s = _col(idx, "spend source")
    c_g = _col(idx, "ghl")
    c_n = _col(idx, "note")
    m = []
    for r in rows:
        def g(j):
            return str(r[j]).strip() if (j is not None and j < len(r) and r[j]) else None
        if g(c_s):
            m.append({"spend_source": g(c_s), "ghl_lead_sources": g(c_g), "notes": g(c_n)})
    gaps = []
    tbc = [x["spend_source"] for x in m if (x.get("ghl_lead_sources") or "").strip().upper() == "TBC"]
    if tbc:
        gaps.append("UNRESOLVED mapping for: %s. Leads for these cannot be separated in GHL yet, "
                    "so do NOT publish a cost per lead for them." % ", ".join(tbc))
    out({"command": "mapping", "mapping": m}, gaps)


def main():
    ap = argparse.ArgumentParser(description="Read PHR's marketing spend sheet (read-only).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("spend", help="spend rows for a month, with the source mapping")
    s.add_argument("--month", default=None, help="YYYY-MM; defaults to the latest month with data")
    s.set_defaults(fn=cmd_spend)
    m = sub.add_parser("months", help="which months have data")
    m.set_defaults(fn=cmd_months)
    p = sub.add_parser("mapping", help="spend source to GHL lead source mapping")
    p.set_defaults(fn=cmd_mapping)
    a = ap.parse_args()
    try:
        a.fn(a)
    except SpendError as e:
        json.dump({"error": str(e), "gaps": ["spend-reader unavailable: %s" % e]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
