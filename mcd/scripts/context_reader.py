#!/usr/bin/env python3
"""context_reader.py — read a Google Doc or Sheet as plain text for MCD context.

Auth: service account (same credential used by other Google connectors).
Env vars checked in order: INITIATIVES_SA_JSON, CALL_FEEDBACK_SA_JSON, GA4_SA_JSON

Commands:
  doc   --id DOC_ID                     export a Google Doc as plain text
  sheet --id SHEET_ID [--tab TAB_NAME]  read a Google Sheet tab as tab-separated text
"""
import argparse
import os
import sys


def _sa():
    for key in ("INITIATIVES_SA_JSON", "CALL_FEEDBACK_SA_JSON", "GA4_SA_JSON"):
        p = os.environ.get(key, "").strip()
        if p and os.path.exists(p):
            return p
    raise RuntimeError(
        "No service account JSON found. Set INITIATIVES_SA_JSON, "
        "CALL_FEEDBACK_SA_JSON, or GA4_SA_JSON."
    )


def cmd_doc(args):
    sa = _sa()
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)
    resp = svc.files().export(fileId=args.id, mimeType="text/plain").execute()
    text = resp.decode("utf-8") if isinstance(resp, bytes) else str(resp)
    # Trim excessive blank lines
    lines = text.splitlines()
    cleaned = []
    blank_run = 0
    for line in lines:
        if line.strip() == "":
            blank_run += 1
            if blank_run <= 2:
                cleaned.append(line)
        else:
            blank_run = 0
            cleaned.append(line)
    print("\n".join(cleaned))


def cmd_sheet(args):
    sa = _sa()
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"]
    )
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    range_ = f"{args.tab}!A1:Z500" if args.tab else "A1:Z500"
    result = (
        svc.spreadsheets()
        .values()
        .get(spreadsheetId=args.id, range=range_)
        .execute()
    )
    rows = result.get("values", [])
    if not rows:
        print("(sheet returned no data)")
        return
    lines = ["\t".join(str(c) for c in row) for row in rows]
    print("\n".join(lines))


def cmd_links(args):
    """Extract Google Doc/Sheet links from a Google Doc, output as JSON."""
    import json
    import re
    from html.parser import HTMLParser
    from urllib.parse import urlparse, parse_qs, unquote

    sa = _sa()
    from google.oauth2 import service_account
    from googleapiclient.discovery import build

    creds = service_account.Credentials.from_service_account_file(
        sa, scopes=["https://www.googleapis.com/auth/drive.readonly"]
    )
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)
    raw = svc.files().export(fileId=args.id, mimeType="text/html").execute()
    html_text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)

    class LinkExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.links = []
            self._href = None
            self._text = []

        def handle_starttag(self, tag, attrs):
            if tag == "a":
                href = dict(attrs).get("href", "")
                # Unwrap Google redirect: https://www.google.com/url?q=...
                if "google.com/url" in href:
                    qs = parse_qs(urlparse(href).query)
                    href = qs.get("q", [href])[0]
                href = unquote(href).split("?")[0].split("#")[0]
                if "docs.google.com/document/d/" in href or \
                   "docs.google.com/spreadsheets/d/" in href:
                    self._href = href
                    self._text = []

        def handle_data(self, data):
            if self._href:
                self._text.append(data)

        def handle_endtag(self, tag):
            if tag == "a" and self._href:
                self.links.append((self._href, "".join(self._text).strip()))
                self._href = None
                self._text = []

    extractor = LinkExtractor()
    extractor.feed(html_text)

    seen = {}
    doc_re   = re.compile(r"/document/d/([A-Za-z0-9_-]+)")
    sheet_re = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]+)")

    for href, text in extractor.links:
        dm = doc_re.search(href)
        sm = sheet_re.search(href)
        if dm:
            doc_id, doc_type = dm.group(1), "doc"
        elif sm:
            doc_id, doc_type = sm.group(1), "sheet"
        else:
            continue
        if doc_id == args.id:   # skip self-reference
            continue
        if doc_id not in seen:
            seen[doc_id] = {
                "doc_id":   doc_id,
                "doc_type": doc_type,
                "name":     text or doc_id,
                "url":      href,
            }

    print(json.dumps(list(seen.values())))


def main():
    ap = argparse.ArgumentParser(
        description="Read a Google Doc or Sheet as plain text."
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("doc", help="export a Google Doc as plain text")
    d.add_argument("--id", required=True, help="Google Doc ID")
    d.set_defaults(fn=cmd_doc)

    s = sub.add_parser("sheet", help="read a Google Sheet tab as text")
    s.add_argument("--id", required=True, help="Google Sheet ID")
    s.add_argument("--tab", default="", help="Tab/sheet name (optional)")
    s.set_defaults(fn=cmd_sheet)

    lk = sub.add_parser("links", help="extract Google Doc/Sheet links from a Doc")
    lk.add_argument("--id", required=True, help="Google Doc ID to scan")
    lk.set_defaults(fn=cmd_links)

    a = ap.parse_args()
    try:
        a.fn(a)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
