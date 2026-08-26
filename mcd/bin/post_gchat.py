#!/usr/bin/env python3
"""Post a text report to the MCD Reports Google Chat space via its incoming webhook.
Reads MCD_GCHAT_WEBHOOK from the environment. Chunks long reports at <=3900 chars on
line boundaries (Google Chat caps a text message near 4096). Read-only side effect:
posts ONLY to the configured MCD Reports webhook.

Usage:
  post_gchat.py <file>            post the file's contents
  post_gchat.py < report.txt      post stdin
  post_gchat.py <file> --dry-run  show the chunking, post nothing
Loud failure: empty report or any non-200 from Google Chat exits 1."""
import sys, os, json, time, urllib.request, urllib.error

MAX = 3900
ENV_FILE = "/root/.hermes/profiles/mcd/.env"

def webhook_url():
    """Prefer env; fall back to parsing the profile .env directly (robust against
    env-injection quirks and the '&' in the URL that breaks bash-sourcing)."""
    u = os.environ.get("MCD_GCHAT_WEBHOOK", "").strip()
    if u:
        return u
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for ln in f:
                ln = ln.strip()
                if ln.startswith("MCD_GCHAT_WEBHOOK="):
                    return ln.split("=", 1)[1].strip().strip("\"'")
    except OSError:
        pass
    return ""

def chunk(text, limit=MAX):
    out, cur = [], ""
    for line in text.split("\n"):
        while len(line) > limit:                 # hard-split a single oversized line
            if cur:
                out.append(cur); cur = ""
            out.append(line[:limit]); line = line[limit:]
        add = ("\n" if cur else "") + line
        if len(cur) + len(add) > limit:
            out.append(cur); cur = line
        else:
            cur += add
    if cur.strip():
        out.append(cur)
    return out or [text]

def main():
    flags = sys.argv[1:]
    dry = "--dry-run" in flags
    pos = [a for a in flags if a != "--dry-run"]
    text = (open(pos[0], encoding="utf-8").read() if pos else sys.stdin.read()).strip()
    if not text:
        print("post_gchat: empty report, nothing to post", file=sys.stderr); sys.exit(1)
    parts = chunk(text)
    n = len(parts)
    url = webhook_url()
    if dry:
        for i, p in enumerate(parts, 1):
            print(f"[dry-run] part {i}/{n}  {len(p)} chars")
        print(f"[dry-run] {n} message(s); MCD_GCHAT_WEBHOOK {'SET' if url else 'MISSING'}")
        return
    if not url:
        print("post_gchat: MCD_GCHAT_WEBHOOK not set", file=sys.stderr); sys.exit(1)
    for i, p in enumerate(parts, 1):
        body = (f"[{i}/{n}] " if n > 1 else "") + p
        req = urllib.request.Request(
            url, data=json.dumps({"text": body}).encode(), method="POST",
            headers={"Content-Type": "application/json; charset=UTF-8"})
        try:
            r = urllib.request.urlopen(req, timeout=30)
            if r.status != 200:
                print(f"post_gchat: part {i}/{n} HTTP {r.status}", file=sys.stderr); sys.exit(1)
        except urllib.error.HTTPError as e:
            print(f"post_gchat: part {i}/{n} HTTP {e.code}: {e.read().decode()[:200]}",
                  file=sys.stderr); sys.exit(1)
        print(f"posted part {i}/{n} ({len(body)} chars) -> HTTP 200")
        if i < n:
            time.sleep(0.6)

if __name__ == "__main__":
    main()
