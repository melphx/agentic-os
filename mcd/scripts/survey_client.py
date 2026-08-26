#!/usr/bin/env python3
"""client-survey-reader: PHR's "Design Client Survey Scores & Answers" sheet (read-only).

Why this exists: Jeremy asked (2026-08-08) that MCD know the reasons homeowners move forward
with PHR, and asked whether the second tab could calculate and average each score. We do the
calculation HERE rather than writing formulas into his sheet, because MCD is read-only against
every PHR system and that sheet is his. Same answer, nothing touched.

Auth: service account, spreadsheets.readonly. Env:
  SURVEY_SHEET_ID       spreadsheet id (required)
  SURVEY_SA_JSON        service-account json path (falls back to CALL_FEEDBACK_SA_JSON)

PRIVACY GUARD: the Scores tab carries Email and Client Name for every respondent. This connector
NEVER returns either. Scores are aggregated; verbatims are returned unattributed.

Commands:
  ranked      average score per reason, ranked high to low (what Jeremy asked for)
  verbatims   the two free-text columns, unattributed: extra reasons, and near-blockers
  summary     response counts, date range, and a staleness check
"""
import argparse, json, os, re, sys
from collections import Counter

# Column roles are resolved by header text, not position, so an inserted column cannot
# silently shift a score onto the wrong reason.
DATE_HDR = "submission date"
PII_HDRS = ("email", "client name")          # never returned
FREETEXT_HINTS = ("any other reasons", "almost prevented")
SKIP_ROW_LABELS = ("totals", "total", "average", "avg")


class SurveyError(Exception):
    pass


def out(payload, gaps):
    payload["gaps"] = gaps
    payload["source"] = "PHR Design Client Survey Scores & Answers (Google Sheet), read-only"
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def _svc():
    sid = os.environ.get("SURVEY_SHEET_ID", "").strip()
    sa = (os.environ.get("SURVEY_SA_JSON", "").strip()
          or os.environ.get("CALL_FEEDBACK_SA_JSON", "").strip())
    if not sid:
        raise SurveyError("SURVEY_SHEET_ID is not set in the environment.")
    if not sa or not os.path.exists(sa):
        raise SurveyError("service-account json not found (SURVEY_SA_JSON / CALL_FEEDBACK_SA_JSON).")
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    return build("sheets", "v4", credentials=creds, cache_discovery=False), sid


def _scores_grid():
    svc, sid = _svc()
    try:
        vals = svc.spreadsheets().values().get(
            spreadsheetId=sid, range="Scores!A1:AA2000").execute().get("values", [])
    except Exception as e:  # noqa
        raise SurveyError("could not read the Scores tab: %s" % str(e)[:200])
    if not vals:
        raise SurveyError("the Scores tab came back empty")
    hdr = [(c or "").strip() for c in vals[0]]
    roles = {"date": None, "pii": [], "score": [], "free": []}
    for i, h in enumerate(hdr):
        low = re.sub(r"\s+", " ", h).lower()
        if not low:
            continue
        if low.startswith(DATE_HDR):
            roles["date"] = i
        elif any(p in low for p in PII_HDRS):
            roles["pii"].append(i)
        elif any(f in low for f in FREETEXT_HINTS):
            roles["free"].append(i)
        else:
            roles["score"].append(i)
    return vals, hdr, roles


def _data_rows(vals, roles):
    """Response rows only: drop the header, any TOTALS/AVERAGE formula row, and blanks."""
    rows = []
    for r in vals[1:]:
        if not r:
            continue
        first = (r[0] if len(r) > 0 else "").strip().lower()
        if first in SKIP_ROW_LABELS:
            continue
        # a real response has at least one numeric score
        has_score = any(_num(r[i]) is not None for i in roles["score"] if i < len(r))
        has_text = any((r[i].strip() if i < len(r) and r[i] else "") for i in roles["free"])
        if has_score or has_text:
            rows.append(r)
    return rows


def _num(s):
    if s is None:
        return None
    s = str(s).strip().replace(",", "")
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if 0 <= f <= 10 else None      # survey is a 1-10 scale; ignore stray values


def _iso(s):
    """Normalise the survey's mixed date formats to YYYY-MM-DD, or None.

    The sheet uses three formats and they are NOT interchangeable:
      2022-03-28  ISO
      2025/05/31  year first, slashes
      01/23/2026  month first, US (01/23 proves month-first: 23 is not a month)
    A previous version matched only ISO and silently dropped the rest, which made a live survey
    look dead. Anything unparseable returns None and is counted as a gap by the caller.
    """
    t = (s or "").strip()
    if not t:
        return None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", t)          # ISO
    if m:
        y, mo, d = m.group(1), m.group(2), m.group(3)
    else:
        m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})", t)      # Y/M/D
        if m:
            y, mo, d = m.group(1), m.group(2), m.group(3)
        else:
            m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", t)  # M/D/Y (US)
            if not m:
                return None
            mo, d, y = m.group(1), m.group(2), m.group(3)
    try:
        mo_i, d_i = int(mo), int(d)
    except ValueError:
        return None
    if not (1 <= mo_i <= 12 and 1 <= d_i <= 31):
        return None
    return "%s-%02d-%02d" % (y, mo_i, d_i)


def _year(s):
    iso = _iso(s)
    return iso[:4] if iso else None


def cmd_ranked(args):
    vals, hdr, roles = _scores_grid()
    rows = _data_rows(vals, roles)
    gaps = []
    ranked = []
    for i in roles["score"]:
        name = re.sub(r"\s+", " ", hdr[i]).strip().rstrip(":")
        nums = [_num(r[i]) for r in rows if i < len(r)]
        nums = [n for n in nums if n is not None]
        if not nums:
            gaps.append("no numeric scores found for %r" % name[:60])
            continue
        ranked.append({
            "reason": name,
            "avg_score": round(sum(nums) / len(nums), 2),
            "responses": len(nums),
            "tens": sum(1 for n in nums if n >= 10),
            "low_scores_1_to_4": sum(1 for n in nums if n <= 4),
        })
    ranked.sort(key=lambda d: d["avg_score"], reverse=True)
    for k, d in enumerate(ranked, 1):
        d["rank"] = k
    if ranked:
        counts = {d["responses"] for d in ranked}
        if len(counts) > 1:
            gaps.append("respondents did not all score every reason (response counts range %d to "
                        "%d), so averages rest on different sample sizes. Compare ranks with care."
                        % (min(counts), max(counts)))
    gaps.append("Averages are computed by this connector from the raw Scores tab. They are NOT "
                "read from the sheet's own Totals Ranked tab, whose current score column is empty. "
                "Nothing in the sheet is modified.")
    out({"command": "ranked", "reasons_ranked": ranked,
         "respondents_considered": len(rows)}, gaps)


def cmd_verbatims(args):
    vals, hdr, roles = _scores_grid()
    rows = _data_rows(vals, roles)
    gaps = []
    if not roles["free"]:
        gaps.append("no free-text columns matched; sheet headers may have changed")
    blocks = {}
    for i in roles["free"]:
        label = re.sub(r"\s+", " ", hdr[i]).strip()
        key = "near_blockers" if "almost prevented" in label.lower() else "other_reasons"
        items = []
        for r in rows:
            if i >= len(r):
                continue
            t = (r[i] or "").strip()
            if not t or t.lower() in ("n/a", "na", "no", "none", "-"):
                continue
            items.append({"date": (_iso(r[roles["date"]])
                                  if roles["date"] is not None and roles["date"] < len(r) else None),
                          "text": t[:args.max_chars]})
        blocks[key] = {"question": label, "count": len(items), "answers": items}
    gaps.append("Verbatims are unattributed by design: respondent email and client name are never "
                "returned by this connector. Do NOT try to identify respondents.")
    gaps.append("The 'near_blockers' answers are objection data: what almost stopped a homeowner "
                "who ultimately did buy. Treat them as the most actionable part of this survey.")
    out({"command": "verbatims", **blocks}, gaps)


def cmd_summary(args):
    vals, hdr, roles = _scores_grid()
    rows = _data_rows(vals, roles)
    gaps = []
    years, dates, unparsed = Counter(), [], 0
    for r in rows:
        if roles["date"] is None or roles["date"] >= len(r):
            continue
        raw = r[roles["date"]]
        iso = _iso(raw)
        if iso:
            years[iso[:4]] += 1
            dates.append(iso)
        elif (raw or "").strip():
            unparsed += 1
    latest = max(dates) if dates else None
    payload = {"command": "summary", "respondents": len(rows),
               "dated_responses": len(dates),
               "by_year": dict(sorted(years.items())),
               "earliest": min(dates) if dates else None, "latest": latest,
               "scored_reasons": len(roles["score"]),
               "free_text_questions": len(roles["free"]),
               "unparseable_dates": unparsed}
    if unparsed:
        gaps.append("%d row(s) have a Submission Date this connector could not parse. They are "
                    "excluded from the year counts and the date range. If that number is large, "
                    "the sheet has picked up a new date format." % unparsed)
    if latest:
        import datetime
        try:
            last = datetime.date.fromisoformat(latest)
            months = (datetime.date.today() - last).days // 30
            payload["months_since_last_response"] = months
            if months >= 6:
                gaps.append("STALE: the most recent response is %s, about %d months ago. This "
                            "survey tells you why homeowners chose PHR historically, NOT what is "
                            "driving decisions now. Say so whenever you cite it, and note that "
                            "restarting the survey would be more valuable than further analysis "
                            "of this data." % (latest, months))
        except ValueError:
            pass
    out(payload, gaps)


def main():
    ap = argparse.ArgumentParser(description="Read PHR's Design Client Survey (read-only).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("ranked", help="average score per reason, ranked")
    r.set_defaults(fn=cmd_ranked)
    v = sub.add_parser("verbatims", help="free-text reasons and near-blockers, unattributed")
    v.add_argument("--max-chars", dest="max_chars", type=int, default=600)
    v.set_defaults(fn=cmd_verbatims)
    s = sub.add_parser("summary", help="counts, date range, staleness check")
    s.set_defaults(fn=cmd_summary)
    a = ap.parse_args()
    try:
        a.fn(a)
    except SurveyError as e:
        json.dump({"error": str(e), "gaps": ["client-survey-reader unavailable: %s" % e]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
