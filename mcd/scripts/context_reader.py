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

    a = ap.parse_args()
    try:
        a.fn(a)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
