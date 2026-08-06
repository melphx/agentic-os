#!/usr/bin/env python3
"""
initiatives_client.py - read-only Google Docs connector for PHR MCD.

Reads Jeremy's initiatives Google Doc and returns "Top Priorities for the Year"
as structured items. MUST run with the Hermes venv Python (Google libs):
  /usr/local/lib/hermes-agent/venv/bin/python3 initiatives_client.py <command>

Shared contract:
  1. Read-only creds from env: INITIATIVES_SA_JSON (Viewer SA key path),
     INITIATIVES_DOC_ID.
  2. Structured JSON on stdout.
  3. Loud failure: any auth/API error -> JSON error on stderr, exit 1.
  4. Gaps reported as gaps; missing two-section structure is a gap, not a guess.

PRIORITIZATION RULE (enforced here):
  Items come ONLY from "Top Priorities for the Year". "Other Priorities to
  Consider Later" is returned as context_only, never as priorities. If both
  headings are not present, return no priorities + structure_ok=false.

Commands: priorities | dump
"""

import argparse
import json
import os
import re
import sys

DOCS_HOST = "https://docs.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/documents.readonly"
CONNECTOR = "initiatives-reader"

TOP_HEADING = "top priorities for the year"
OTHER_HEADING = "other priorities to consider later"


class InitError(Exception):
    def __init__(self, message, status=None, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def _doc_id():
    d = os.environ.get("INITIATIVES_DOC_ID", "").strip()
    if not d:
        raise InitError("INITIATIVES_DOC_ID is not set in the environment.")
    return d


def _session():
    sa_path = os.environ.get("INITIATIVES_SA_JSON", "").strip()
    if not sa_path:
        raise InitError("INITIATIVES_SA_JSON is not set in the environment.")
    if not os.path.isfile(sa_path):
        raise InitError(f"INITIATIVES_SA_JSON points to a missing file: {sa_path}")
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except Exception as e:
        raise InitError(f"Google auth libs not importable — run with the venv python: {e}")
    try:
        creds = service_account.Credentials.from_service_account_file(sa_path, scopes=[SCOPE])
        return AuthorizedSession(creds)
    except Exception as e:
        raise InitError(f"Failed to load service-account credentials: {e}")


def _get_document():
    sess = _session()
    url = f"{DOCS_HOST}/v1/documents/{_doc_id()}"
    try:
        resp = sess.get(url, timeout=60)
    except Exception as e:
        raise InitError(f"Network error reaching Docs API: {e}")
    if resp.status_code != 200:
        raise InitError(f"HTTP {resp.status_code} from Docs API", status=resp.status_code,
                        detail=resp.text[:800])
    return resp.json()


def _paragraphs(doc):
    """Return list of {text, style} per paragraph, in document order."""
    out = []
    for el in (doc.get("body", {}) or {}).get("content", []) or []:
        para = el.get("paragraph")
        if not para:
            continue
        text = "".join(
            (e.get("textRun", {}) or {}).get("content", "")
            for e in para.get("elements", []) or []
        ).strip()
        style = (para.get("paragraphStyle", {}) or {}).get("namedStyleType", "")
        out.append({"text": text, "style": style})
    return out


def _parse_item(text):
    """Best-effort extraction of impact/effort/status from an item line.
    Jeremy's exact tagging format must be confirmed against the real doc."""
    def grab(label):
        m = re.search(rf"{label}\s*[:=]?\s*\(?\s*(H|M|L|high|medium|low)\b", text, re.I)
        return m.group(1).upper()[0] if m else None
    impact = grab("impact")
    effort = grab("effort")
    ms = re.search(r"status\s*[:=]?\s*([^\|\)\]]+)", text, re.I)
    status = ms.group(1).strip() if ms else None
    return {"text": text, "impact": impact, "effort": effort, "status": status}


def _group_by_headings(paras):
    """Group non-empty paragraphs under their nearest preceding heading/title.
    Used ONLY by the unstructured-pile fallback so the model can reason over the
    doc's natural sections. The connector does NOT decide which sections are
    priorities here; it just exposes the structure and lets the model judge."""
    sections = []
    current = {"heading": "(intro / no heading)", "items": []}
    for p in paras:
        text = (p.get("text") or "").strip()
        if not text:
            continue
        style = p.get("style", "") or ""
        if style.startswith("HEADING") or style == "TITLE":
            if current["items"]:
                sections.append(current)
            current = {"heading": text, "items": []}
        else:
            current["items"].append(text[:300])
    if current["items"]:
        sections.append(current)
    return sections


def cmd_priorities(args):
    doc = _get_document()
    paras = _paragraphs(doc)
    # locate the two section headings (case-insensitive substring match)
    top_idx = other_idx = None
    for i, p in enumerate(paras):
        t = p["text"].lower()
        if top_idx is None and TOP_HEADING in t:
            top_idx = i
        elif other_idx is None and OTHER_HEADING in t:
            other_idx = i
    gaps = []
    structure_ok = top_idx is not None and other_idx is not None
    if not structure_ok:
        # DEVIATION from spec (approved by Stanly 2026-06-23; Jeremy is low on bandwidth to
        # restructure the doc now, "figure it out, can adjust later"). The spec says refuse and
        # report to Jeremy when the two-section structure is missing. Instead we degrade
        # gracefully: expose the doc's natural sections as UNMARKED, MIXED-PRIORITY candidates
        # with a hard caveat. This auto-reverts to the strict two-section path the moment a
        # "Top Priorities for the Year" heading appears in the doc.
        sections = _group_by_headings(paras)
        gaps.append("No 'Top Priorities for the Year' / 'Other Priorities to Consider Later' "
                    "headings found. Reading the RAW initiatives doc (a pile of ideas of MIXED "
                    "priority). These are NOT Jeremy-confirmed priorities: treat each item as an "
                    "unranked candidate, apply your own judgment filtered against the mid-funnel "
                    "bottleneck, and state plainly that you are inferring from an unmarked idea "
                    "list. Never present an item as a directive from Jeremy.")
        return {"connector": CONNECTOR, "command": "priorities", "doc_id": _doc_id(),
                "structure_ok": False, "mode": "unstructured_pile",
                "priorities": [], "context_only": [], "candidate_sections": sections,
                "section_count": len(sections), "gaps": gaps,
                "verify_live": ["DEVIATION (Stanly-approved 2026-06-23): reads the unstructured doc "
                                "instead of refusing; reverts to strict two-section parsing once a "
                                "'Top Priorities for the Year' heading exists in the doc."]}

    # priorities = item lines between TOP heading and OTHER heading (whichever order)
    lo, hi = sorted([top_idx, other_idx])
    if top_idx < other_idx:
        prio_slice = paras[top_idx + 1: other_idx]
        ctx_slice = paras[other_idx + 1:]
    else:
        # Other section appears first; priorities run from TOP heading to end
        prio_slice = paras[top_idx + 1:]
        ctx_slice = paras[other_idx + 1: top_idx]
    priorities = [_parse_item(p["text"]) for p in prio_slice
                  if p["text"] and not p["style"].startswith("HEADING")]
    context_only = [p["text"] for p in ctx_slice
                    if p["text"] and not p["style"].startswith("HEADING")]
    return {"connector": CONNECTOR, "command": "priorities", "doc_id": _doc_id(),
            "structure_ok": True, "mode": "structured", "count": len(priorities), "priorities": priorities,
            "context_only": context_only, "gaps": gaps,
            "verify_live": ["impact/effort/status parsing is best-effort regex; tune to Jeremy's actual tagging format once the doc exists"]}


def cmd_dump(args):
    doc = _get_document()
    paras = _paragraphs(doc)
    return {"connector": CONNECTOR, "command": "dump", "doc_id": _doc_id(),
            "title": doc.get("title"), "paragraph_count": len(paras),
            "paragraphs": [p for p in paras if p["text"]], "gaps": []}


def main():
    p = argparse.ArgumentParser(prog="initiatives_client.py", description="Read-only initiatives Doc connector (PHR MCD)")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("priorities")
    sub.add_parser("dump")
    args = p.parse_args()
    handlers = {"priorities": cmd_priorities, "dump": cmd_dump}
    try:
        print(json.dumps(handlers[args.command](args), indent=2))
        return 0
    except InitError as e:
        print(json.dumps({"connector": CONNECTOR, "command": args.command,
                          "error": str(e), "status": e.status, "detail": e.detail},
                         indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
