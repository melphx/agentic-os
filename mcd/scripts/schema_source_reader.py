#!/usr/bin/env python3
"""schema_source_reader.py — read a Google Sheet or Doc for the Schema tool, keeping formatting.

Unlike context_reader.py (values only), this keeps what people use to signal meaning:
text colour (e.g. red = "needs changing"), highlight colour, strikethrough, cell notes and links.

Auth: same service account as the other Google connectors.
Env vars checked in order: SCHEMA_TOOL_SA_JSON, INITIATIVES_SA_JSON, CALL_FEEDBACK_SA_JSON, GA4_SA_JSON

Commands (all print JSON):
  whoami                                     service-account email (share sheets/docs with it)
  tabs  --id SHEET_ID                        list tab names
  sheet --id SHEET_ID [--tab TAB | --gid GID] [--range A1:Z600]
  doc   --id DOC_ID
  file  --id DRIVE_FILE_ID                   any Drive file: {kind: sheet|doc|binary, ...}; binary = base64 bytes

Write-back (needs the file shared with the service account as Editor):
  setup  --id SHEET_ID --tab TAB --status-col I [--header "Schema status"] [--values "Added,Not Added"] [--first-row 3]
         adds a dropdown column (header + data validation + green/red colouring)
  write  --id SHEET_ID --tab TAB --updates '[{"cell":"I25","value":"Added"}, {"cell":"E25","value":"Added 10-2026","black":true}]'
         ("append": true adds to the existing text instead of replacing it; "black": true sets black text)
         returns the previous values so the change can be undone
"""
import argparse
import json
import os
import sys

# httplib2 >= 0.32 refuses compressed responses that expand more than 100x once they pass 10 MB
# ("Amplification ratio … exceeds limit"). A whole Sheets tab with formatting is very repetitive JSON
# and compresses ~100x, so allow a higher ratio for Google's API, with a 300 MB hard cap on the output.
os.environ.setdefault("httplib2_decode_limit_ratio", "5000")
os.environ.setdefault("httplib2_decode_limit_hard", str(300 << 20))

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


WRITE_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def _creds(write=False):
    from google.oauth2 import service_account
    return service_account.Credentials.from_service_account_file(_sa_path(), scopes=WRITE_SCOPES if write else SCOPES)


def _svc(name, version, write=False):
    from googleapiclient.discovery import build
    return build(name, version, credentials=_creds(write), cache_discovery=False)


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
    meta = svc.spreadsheets().get(spreadsheetId=args.id, fields="properties.title,sheets.properties(title,sheetId)").execute()
    tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
    tab = args.tab
    if not tab and getattr(args, "gid", ""):
        tab = next((s["properties"]["title"] for s in meta.get("sheets", []) if str(s["properties"].get("sheetId")) == str(args.gid)), "")
    tab = tab or (tabs[0] if tabs else "")
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


def cmd_file(args):
    import base64
    drive = _svc("drive", "v3")
    f = drive.files().get(fileId=args.id, fields="name,mimeType,size", supportsAllDrives=True).execute()
    mt = f.get("mimeType", "")
    if mt == "application/vnd.google-apps.spreadsheet":
        print(json.dumps({"kind": "native", "doc_type": "sheet", "name": f.get("name", "")})); return
    if mt == "application/vnd.google-apps.document":
        print(json.dumps({"kind": "native", "doc_type": "doc", "name": f.get("name", "")})); return
    if mt.startswith("application/vnd.google-apps."):
        resp = drive.files().export(fileId=args.id, mimeType="text/plain").execute()
        text = resp.decode("utf-8", "ignore") if isinstance(resp, bytes) else str(resp)
        print(json.dumps({"kind": "text", "name": f.get("name", ""), "mimeType": mt, "text": text})); return
    if int(f.get("size") or 0) > 25 * 1024 * 1024:
        raise RuntimeError("File is larger than 25 MB.")
    data = drive.files().get_media(fileId=args.id, supportsAllDrives=True).execute()
    print(json.dumps({"kind": "binary", "name": f.get("name", ""), "mimeType": mt, "b64": base64.b64encode(data).decode()}))


def _col_index(col):
    n = 0
    for ch in col.upper():
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _sheet_id(svc, spreadsheet_id, tab):
    meta = svc.spreadsheets().get(spreadsheetId=spreadsheet_id, fields="sheets.properties(title,sheetId,gridProperties)").execute()
    for sh in meta.get("sheets", []):
        if sh["properties"]["title"] == tab:
            return sh["properties"]["sheetId"], sh["properties"].get("gridProperties", {}).get("rowCount", 1000)
    raise RuntimeError(f"Tab not found: {tab}")


def cmd_setup(args):
    svc = _svc("sheets", "v4", write=True)
    sid, rows = _sheet_id(svc, args.id, args.tab)
    col = _col_index(args.status_col)
    values = [v.strip() for v in args.values.split(",") if v.strip()]
    first = int(args.first_row) - 1
    rng = {"sheetId": sid, "startRowIndex": first, "endRowIndex": rows, "startColumnIndex": col, "endColumnIndex": col + 1}
    colour = {"Added": {"red": 0.85, "green": 0.95, "blue": 0.85}, "Not Added": {"red": 0.98, "green": 0.87, "blue": 0.87}}
    reqs = [
        {"setDataValidation": {"range": rng, "rule": {
            "condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": v} for v in values]},
            "showCustomUi": True, "strict": False}}},
    ]
    for v in values:
        if v in colour:
            reqs.append({"addConditionalFormatRule": {"index": 0, "rule": {"ranges": [rng], "booleanRule": {
                "condition": {"type": "TEXT_EQ", "values": [{"userEnteredValue": v}]},
                "format": {"backgroundColor": colour[v]}}}}})
    svc.spreadsheets().batchUpdate(spreadsheetId=args.id, body={"requests": reqs}).execute()
    svc.spreadsheets().values().update(
        spreadsheetId=args.id, range=f"'{args.tab}'!{args.status_col.upper()}1", valueInputOption="RAW",
        body={"values": [[args.header]]}).execute()
    print(json.dumps({"ok": True, "column": args.status_col.upper(), "values": values}))


def cmd_write(args):
    svc = _svc("sheets", "v4", write=True)
    updates = json.loads(args.updates)
    if not isinstance(updates, list) or not updates:
        raise RuntimeError("No updates")
    if len(updates) > 2000:
        raise RuntimeError("Too many cells in one write (max 2000)")
    ranges = [f"'{args.tab}'!{u['cell']}" for u in updates]
    prev = svc.spreadsheets().values().batchGet(spreadsheetId=args.id, ranges=ranges, valueRenderOption="FORMATTED_VALUE").execute()
    before = []
    for u, vr in zip(updates, prev.get("valueRanges", [])):
        vals = vr.get("values") or [[""]]
        before.append({"cell": u["cell"], "value": (vals[0] or [""])[0] if vals else ""})
    data = []
    for r, u, b in zip(ranges, updates, before):
        val = str(u.get("value", ""))
        if u.get("append"):
            prev_val = str(b["value"] or "")
            if val in prev_val:
                continue                      # note already there
            val = f"{prev_val}; {val}" if prev_val.strip() else val
        data.append({"range": r, "values": [[val]]})
    if data:
        svc.spreadsheets().values().batchUpdate(spreadsheetId=args.id, body={"valueInputOption": "RAW", "data": data}).execute()
    # cells marked "black": plain black text (e.g. a red "Needs to be added" note replaced by "Added 10-2026")
    black = [u["cell"] for u in updates if u.get("black")]
    if black:
        import re as _re
        sid, _rows = _sheet_id(svc, args.id, args.tab)
        reqs = []
        for c in black:
            m = _re.match(r"^([A-Z]+)(\d+)$", c.upper())
            if not m:
                continue
            col, row = _col_index(m.group(1)), int(m.group(2)) - 1
            reqs.append({"repeatCell": {
                "range": {"sheetId": sid, "startRowIndex": row, "endRowIndex": row + 1, "startColumnIndex": col, "endColumnIndex": col + 1},
                "cell": {"userEnteredFormat": {"textFormat": {"foregroundColorStyle": {"rgbColor": {"red": 0, "green": 0, "blue": 0}}}}},
                "fields": "userEnteredFormat.textFormat.foregroundColorStyle"}})
        if reqs:
            svc.spreadsheets().batchUpdate(spreadsheetId=args.id, body={"requests": reqs}).execute()
    print(json.dumps({"ok": True, "written": len(data), "previous": before}))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    t = sub.add_parser("tabs"); t.add_argument("--id", required=True)
    s = sub.add_parser("sheet"); s.add_argument("--id", required=True); s.add_argument("--tab", default=""); s.add_argument("--gid", default=""); s.add_argument("--range", default="A1:Z600")
    d = sub.add_parser("doc"); d.add_argument("--id", required=True)
    f = sub.add_parser("file"); f.add_argument("--id", required=True)
    st = sub.add_parser("setup"); st.add_argument("--id", required=True); st.add_argument("--tab", required=True)
    st.add_argument("--status-col", dest="status_col", required=True); st.add_argument("--header", default="Schema status")
    st.add_argument("--values", default="Added,Not Added"); st.add_argument("--first-row", dest="first_row", default="3")
    w = sub.add_parser("write"); w.add_argument("--id", required=True); w.add_argument("--tab", required=True); w.add_argument("--updates", required=True)
    args = ap.parse_args()
    try:
        {"whoami": cmd_whoami, "tabs": cmd_tabs, "sheet": cmd_sheet, "doc": cmd_doc, "file": cmd_file, "setup": cmd_setup, "write": cmd_write}[args.cmd](args)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "403" in msg or "PERMISSION_DENIED" in msg or "does not have permission" in msg:
            msg = ("The service account can't change this file. Share it as Editor with the service-account email shown in the Sources tab."
                   if args.cmd in ("setup", "write") else
                   "The service account can't open this file. Share it (Viewer) with the service-account email shown in the Sources tab.")
        print(json.dumps({"error": msg[:600]}))
        sys.exit(1)


if __name__ == "__main__":
    main()
