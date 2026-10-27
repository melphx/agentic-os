#!/usr/bin/env python3
"""schema_source_reader.py — read a Google Sheet or Doc for the Schema tool, keeping formatting.

Unlike context_reader.py (values only), this keeps what people use to signal meaning:
text colour (e.g. red = "needs changing"), highlight colour, strikethrough, cell notes and links.

Auth: same service account as the other Google connectors.
Env vars checked in order: SCHEMA_TOOL_SA_JSON, INITIATIVES_SA_JSON, CALL_FEEDBACK_SA_JSON, GA4_SA_JSON

Commands (all print JSON):
  whoami                                     service-account email (share sheets/docs with it)
  tabs  --id SHEET_ID                        list tab names
  sheet --id SHEET_ID [--tab TAB] [--range A1:Z600]
  doc   --id DOC_ID
"""
import argparse
import json
import os
import sys

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
]


def _sa_path():
    for key in ("SCHEMA_TOOL_SA_JSON", "INITIATIVES_SA_JSON", "CALL_FEEDBACK_SA_JSON", "GA4_SA_JSON"):
        p = os.environ.get(key, "").strip()
        if p and os.path.exists(p):
            return p
    raise RuntimeError("No service account JSON found. Set SCHEMA_TOOL_SA_JSON (or INITIATIVES_SA_JSON).")


def _creds():
    from google.oauth2 import service_account
    return service_account.Credentials.from_service_account_file(_sa_path(), scopes=SCOPES)


def _svc(name, version):
    from googleapiclient.discovery import build
    return build(name, version, credentials=_creds(), cache_discovery=False)


def cmd_whoami(_args):
    with open(_sa_path()) as f:
        print(json.dumps({"email": json.load(f).get("client_email", "")}))


def cmd_tabs(args):
    meta = _svc("sheets", "v4").spreadsheets().get(
        spreadsheetId=args.id, fields="properties.title,sheets.properties.title"
    ).execute()
    print(json.dumps({
        "title": meta.get("properties", {}).get("title", ""),
        "tabs": [s["properties"]["title"] for s in meta.get("sheets", [])],
    }))


def cmd_sheet(args):
    svc = _svc("sheets", "v4")
    meta = svc.spreadsheets().get(spreadsheetId=args.id, fields="properties.title,sheets.properties.title").execute()
    tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
    tab = args.tab or (tabs[0] if tabs else "")
    rng = f"'{tab}'!{args.range}" if tab else args.range
    fields = ("sheets.properties.title,sheets.data.startRow,sheets.data.rowData.values("
              "formattedValue,hyperlink,note,"
              "effectiveFormat.textFormat.foregroundColorStyle,effectiveFormat.textFormat.strikethrough,"
              "effectiveFormat.textFormat.bold,effectiveFormat.backgroundColorStyle)")
    res = svc.spreadsheets().get(spreadsheetId=args.id, ranges=[rng], includeGridData=True, fields=fields).execute()
    sheet = (res.get("sheets") or [{}])[0]
    data = (sheet.get("data") or [{}])[0]
    print(json.dumps({
        "kind": "sheet",
        "title": meta.get("properties", {}).get("title", ""),
        "tab": tab,
        "tabs": tabs,
        "startRow": data.get("startRow", 0),
        "rowData": data.get("rowData", []),
    }))


def _rgb(style):
    c = (style or {}).get("rgbColor") or {}
    return [c.get("red", 0), c.get("green", 0), c.get("blue", 0)] if c else None


def cmd_doc(args):
    # Docs API keeps colours/strikethrough; fall back to a plain-text export if it isn't enabled.
    try:
        doc = _svc("docs", "v1").documents().get(documentId=args.id).execute()
        paras = []
        for el in doc.get("body", {}).get("content", []):
            p = el.get("paragraph")
            if not p:
                continue
            runs = []
            for r in p.get("elements", []):
                tr = r.get("textRun")
                if not tr:
                    continue
                st = tr.get("textStyle", {})
                runs.append({
                    "t": tr.get("content", ""),
                    "fg": _rgb((st.get("foregroundColor") or {}).get("color")),
                    "bg": _rgb((st.get("backgroundColor") or {}).get("color")),
                    "strike": bool(st.get("strikethrough")),
                    "link": (st.get("link") or {}).get("url"),
                })
            paras.append(runs)
        print(json.dumps({"kind": "doc", "title": doc.get("title", ""), "paragraphs": paras}))
    except Exception as e:  # noqa: BLE001
        resp = _svc("drive", "v3").files().export(fileId=args.id, mimeType="text/plain").execute()
        text = resp.decode("utf-8") if isinstance(resp, bytes) else str(resp)
        print(json.dumps({"kind": "doc", "title": "", "text": text, "note": f"plain text only ({type(e).__name__})"}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    t = sub.add_parser("tabs"); t.add_argument("--id", required=True)
    s = sub.add_parser("sheet"); s.add_argument("--id", required=True); s.add_argument("--tab", default=""); s.add_argument("--range", default="A1:Z600")
    d = sub.add_parser("doc"); d.add_argument("--id", required=True)
    args = ap.parse_args()
    try:
        {"whoami": cmd_whoami, "tabs": cmd_tabs, "sheet": cmd_sheet, "doc": cmd_doc}[args.cmd](args)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "403" in msg or "PERMISSION_DENIED" in msg or "does not have permission" in msg:
            msg = "The service account can't open this file. Share it (Viewer) with the service-account email shown in the Sources tab."
        print(json.dumps({"error": msg[:600]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
