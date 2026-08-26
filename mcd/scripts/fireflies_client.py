#!/usr/bin/env python3
"""fireflies-reader: PHR's Fireflies.ai meeting transcripts (read-only).

Jeremy asked (2026-08-20) for a monthly assessment of Video Proposal Reviews and in-home
appointments, and for MCD to hold the transcripts so he can interrogate them. Rebekah's
"Remodel Proposal Review" calls are recorded and transcribed in Fireflies, which is where this
reads from. 70 proposal reviews existed on 2026-08-22, going back to 2025-09-04.

Auth: FIREFLIES_API_KEY (a Fireflies API key, needs a paid Fireflies plan).

WHAT MAKES THIS USEFUL BEYOND THE TRANSCRIPT: Fireflies returns speaker TALK TIME and sentiment
per meeting. Talk-time split is the single most useful coaching metric available for a
consultative sales call, and PHR has never been able to see it.

VOLUME DISCIPLINE: a single proposal review transcript is roughly 25,000 characters. 70 of them
is about 1.75 million, so NEVER pull all transcripts at once. Use `monthly` for a month's
metrics plus Fireflies' own summaries (about 1-2k each), and `transcript` for one call at a time.

PRIVACY: meeting titles contain the HOMEOWNER'S NAME (e.g. "Jane Smith Remodel Proposal Review").
Every command therefore also returns `label`, a redacted reference like "29 min review on
2026-08-18". Reports must use `label`, never the homeowner name, matching the rule already in
knowledge/call-quality.md.

Commands:
  meetings  --from YYYY-MM-DD --to YYYY-MM-DD [--type proposal|inhome|all]
  monthly   --month YYYY-MM     metrics + summaries for the month, the monthly-assessment feed
  transcript --id <id> [--max-chars N]     ONE full transcript
"""
import argparse, datetime, json, os, re, sys, time, urllib.error, urllib.request

URL = "https://api.fireflies.ai/graphql"
PROPOSAL_RE = re.compile(r"proposal\s+review", re.I)
INHOME_RE = re.compile(r"in.?home", re.I)


class FFError(Exception):
    pass


def out(payload, gaps):
    payload["gaps"] = gaps
    payload["source"] = "Fireflies.ai (read-only)"
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def gql(query, variables=None, tries=3):
    key = os.environ.get("FIREFLIES_API_KEY", "").strip()
    if not key:
        raise FFError("FIREFLIES_API_KEY is not set in the environment.")
    body = {"query": query}
    if variables:
        body["variables"] = variables
    last = None
    for a in range(tries):
        try:
            r = urllib.request.Request(URL, data=json.dumps(body).encode(), method="POST")
            r.add_header("Authorization", "Bearer " + key)
            r.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(r, timeout=90) as resp:
                d = json.load(resp)
            if d.get("errors"):
                raise FFError("Fireflies returned errors: %s" % json.dumps(d["errors"])[:300])
            return d.get("data") or {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            if e.code == 401:
                raise FFError("Fireflies rejected the API key (401). %s" % detail)
            if e.code == 429 and a < tries - 1:
                time.sleep(4 * (a + 1)); continue
            raise FFError("Fireflies HTTP %s: %s" % (e.code, detail))
        except FFError:
            raise
        except Exception as e:  # noqa
            last = e
            time.sleep(3 * (a + 1))
    raise FFError("could not reach Fireflies: %s" % str(last)[:160])


def _date(ms):
    try:
        return datetime.datetime.fromtimestamp(int(ms) / 1000).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _label(t):
    """Redacted reference for use in reports: never the homeowner's name."""
    kind = "proposal review" if PROPOSAL_RE.search(t.get("title") or "") else "meeting"
    dur = t.get("duration")
    return "%s min %s on %s" % (round(dur) if dur else "?", kind, _date(t.get("date")) or "?")


def _fetch_all(limit_pages=12):
    """Fireflies pages at 50. Pull everything, newest first."""
    rows, skip = [], 0
    for _ in range(limit_pages):
        d = gql("{ transcripts(limit: 50, skip: %d) { id title date duration "
                "organizer_email host_email } }" % skip)
        got = d.get("transcripts") or []
        rows += got
        if len(got) < 50:
            break
        skip += 50
    return rows


def _kind(t):
    ti = t.get("title") or ""
    if PROPOSAL_RE.search(ti):
        return "proposal_review"
    if INHOME_RE.search(ti):
        return "in_home"
    return "other"


def _filter(rows, frm, to, kind):
    out_rows = []
    for t in rows:
        d = _date(t.get("date"))
        if not d or (frm and d < frm) or (to and d > to):
            continue
        k = _kind(t)
        if kind == "proposal" and k != "proposal_review":
            continue
        if kind == "inhome" and k != "in_home":
            continue
        t["_date"] = d
        t["_kind"] = k
        t["label"] = _label(t)
        out_rows.append(t)
    return sorted(out_rows, key=lambda x: x["_date"], reverse=True)


def cmd_meetings(args):
    rows = _filter(_fetch_all(), args.frm, args.to, args.type)
    listed = [{"id": t["id"], "label": t["label"], "date": t["_date"],
               "kind": t["_kind"], "duration_min": round(t.get("duration") or 0, 1),
               "host": t.get("organizer_email")} for t in rows]
    kinds = {}
    for t in rows:
        kinds[t["_kind"]] = kinds.get(t["_kind"], 0) + 1
    out({"command": "meetings", "from": args.frm, "to": args.to,
         "count": len(listed), "by_kind": kinds, "meetings": listed},
        ["Titles contain homeowner names, so only `label` is safe to print in a report.",
         "In-home appointments are NOT in Fireflies unless somebody records them there; the "
         "in-home evaluations live in the call-feedback sheet instead. by_kind shows what is "
         "actually present rather than what you might expect."])


def cmd_monthly(args):
    m = args.month
    y, mo = int(m[:4]), int(m[5:7])
    last = (datetime.date(y + (mo == 12), 1 if mo == 12 else mo + 1, 1)
            - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    rows = _filter(_fetch_all(), "%s-01" % m, last, args.type)
    gaps = []
    if not rows:
        out({"command": "monthly", "month": m, "count": 0, "meetings": []},
            ["no meetings of that type in %s. Treat as UNAVAILABLE, not as zero activity." % m])
        return

    detail, talk, durs, sent = [], [], [], []
    for t in rows:
        d = gql("""{ transcripts(limit:1, skip:0) { id } }""") if False else None
        one = gql("""query($id: String!) { transcript(id: $id) {
                       id title duration
                       summary { short_summary action_items keywords topics_discussed }
                       analytics { speakers { name duration word_count duration_pct } }
                       sentences { speaker_name } } }""", {"id": t["id"]})
        tr = (one or {}).get("transcript") or {}
        sp = ((tr.get("analytics") or {}).get("speakers") or [])
        host_pct = None
        for s in sp:
            nm = (s.get("name") or "").lower()
            if "rebekah" in nm or "reed" in nm:
                host_pct = s.get("duration_pct")
        if host_pct is None and sp:
            host_pct = max(s.get("duration_pct") or 0 for s in sp)
        if host_pct is not None:
            talk.append(host_pct)
        if t.get("duration"):
            durs.append(t["duration"])
        s2 = tr.get("summary") or {}
        detail.append({
            "id": t["id"], "label": t["label"], "date": t["_date"],
            "duration_min": round(t.get("duration") or 0, 1),
            "host_talk_pct": round(host_pct, 1) if host_pct is not None else None,
            "speakers": [{"name": s.get("name"), "words": s.get("word_count"),
                          "talk_pct": round(s.get("duration_pct") or 0, 1)} for s in sp],
            "short_summary": s2.get("short_summary"),
            "action_items": s2.get("action_items"),
            "topics": s2.get("topics_discussed"),
        })

    agg = {"meetings": len(rows),
           "avg_duration_min": round(sum(durs) / len(durs), 1) if durs else None,
           "avg_host_talk_pct": round(sum(talk) / len(talk), 1) if talk else None,
           "host_talk_pct_range": [round(min(talk), 1), round(max(talk), 1)] if talk else None,
           "meetings_where_host_over_75pct": sum(1 for x in talk if x > 75)}
    if agg["avg_host_talk_pct"] and agg["avg_host_talk_pct"] > 70:
        gaps.append("The host is doing %.0f%% of the talking on average. On a consultative sales "
                    "call that is high, and it is the most actionable coaching point available "
                    "here. Raise it as an observation with the numbers, not as a verdict."
                    % agg["avg_host_talk_pct"])
    gaps.append("Summaries and action items are Fireflies' own AI output, not a PHR rubric. They "
                "describe what happened; they do NOT score against PHR's sales SOP. Say which is "
                "which when reporting.")
    gaps.append("Use `label` in reports. Never print the homeowner name from `title`.")
    gaps.append("Full transcripts are about 25,000 characters each and are NOT included here. "
                "Pull them one at a time with the transcript command for a deep dive.")
    out({"command": "monthly", "month": m, "type": args.type,
         "aggregate": agg, "meetings": detail}, gaps)


def cmd_transcript(args):
    d = gql("""query($id: String!) { transcript(id: $id) {
                 id title date duration organizer_email
                 summary { overview short_summary action_items keywords topics_discussed }
                 analytics { speakers { name duration word_count duration_pct } }
                 sentences { speaker_name text } } }""", {"id": args.id})
    tr = d.get("transcript") or {}
    if not tr:
        out({"command": "transcript", "id": args.id, "found": False},
            ["no transcript with that id"])
        return
    sents = tr.get("sentences") or []
    text = "\n".join("%s: %s" % (s.get("speaker_name") or "?", s.get("text") or "")
                     for s in sents)
    truncated = len(text) > args.max_chars
    out({"command": "transcript", "id": tr.get("id"),
         "label": _label(tr), "date": _date(tr.get("date")),
         "duration_min": round(tr.get("duration") or 0, 1),
         "speakers": (tr.get("analytics") or {}).get("speakers"),
         "summary": tr.get("summary"),
         "transcript": text[:args.max_chars],
         "transcript_chars": len(text), "truncated": truncated},
        (["TRUNCATED at %d of %d chars; raise --max-chars to get the rest."
          % (args.max_chars, len(text))] if truncated else [])
        + ["The transcript names the homeowner. Do NOT reproduce their name in a report; refer to "
           "the call by its label."])


def main():
    ap = argparse.ArgumentParser(description="Read PHR's Fireflies meeting transcripts (read-only).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("meetings", help="list meetings in a date range")
    m.add_argument("--from", dest="frm", required=True)
    m.add_argument("--to", required=True)
    m.add_argument("--type", default="all", choices=["proposal", "inhome", "all"])
    m.set_defaults(fn=cmd_meetings)
    mo = sub.add_parser("monthly", help="a month of metrics plus Fireflies summaries")
    mo.add_argument("--month", required=True, help="YYYY-MM")
    mo.add_argument("--type", default="proposal", choices=["proposal", "inhome", "all"])
    mo.set_defaults(fn=cmd_monthly)
    t = sub.add_parser("transcript", help="ONE full transcript")
    t.add_argument("--id", required=True)
    t.add_argument("--max-chars", dest="max_chars", type=int, default=40000)
    t.set_defaults(fn=cmd_transcript)
    a = ap.parse_args()
    try:
        a.fn(a)
    except FFError as e:
        json.dump({"error": str(e), "gaps": ["fireflies-reader unavailable: %s" % e]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
