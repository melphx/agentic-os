#!/usr/bin/env python3
"""
wp_client.py - read-only WordPress + RankMath connector for the PHR MCD agent.

Stdlib only (system python3 is fine). Read-only via an application password.

Shared contract (every command):
  1. Read-only creds from env: WP_BASE_URL, WP_USER, WP_APP_PASSWORD.
  2. Structured JSON on stdout.
  3. The raw query echoed back.
  4. Loud failure: any auth/API error prints a JSON error to stderr, exits 1.
  5. Gaps reported as gaps.

Commands: content | seo | meta

MIGRATION NOTE: a WordPress migration is active. Prefer the staging WP_BASE_URL
and coordinate any WordPress-side change (esp. rank_math_ meta registration)
with Mohammed.
"""

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

CONNECTOR = "wp-rankmath-reader"
MAX_PAGES = 50
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


class WPError(Exception):
    def __init__(self, message, status=None, detail=None, url=None):
        super().__init__(message)
        self.status = status
        self.detail = detail
        self.url = url


def _config():
    base = os.environ.get("WP_BASE_URL", "").strip().rstrip("/")
    user = os.environ.get("WP_USER", "").strip()
    pw = os.environ.get("WP_APP_PASSWORD", "").strip()
    if not base:
        raise WPError("WP_BASE_URL is not set in the environment.")
    if not user or not pw:
        raise WPError("WP_USER / WP_APP_PASSWORD are not set in the environment.")
    return base, user, pw


def _auth_header():
    _, user, pw = _config()
    token = base64.b64encode(f"{user}:{pw}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _request(url):
    """GET url with Basic auth. Returns (parsed_json, response_headers). Loud on error."""
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", _auth_header())
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", UA)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode("utf-8")
            headers = {k.lower(): v for k, v in resp.headers.items()}
            return (json.loads(body) if body else None), headers
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:800]
        except Exception:
            pass
        raise WPError(f"HTTP {e.code} from WordPress", status=e.code, detail=detail, url=url)
    except urllib.error.URLError as e:
        raise WPError(f"Network error reaching WordPress: {e.reason}", url=url)
    except json.JSONDecodeError as e:
        raise WPError(f"WordPress returned non-JSON: {e}", url=url)


def cmd_content(args):
    base, _, _ = _config()
    if args.type not in ("posts", "pages"):
        raise WPError("--type must be posts or pages")
    modified_after = f"{args.modified_after}T00:00:00" if args.modified_after else None
    records = []
    page = 1
    total_pages = None
    while page <= MAX_PAGES:
        params = {
            "per_page": 100, "page": page, "orderby": "modified", "order": "desc",
            "_fields": "id,slug,link,modified,modified_gmt,title,status,type",
            "status": "publish",
        }
        if modified_after:
            params["modified_after"] = modified_after
        url = f"{base}/wp-json/wp/v2/{args.type}?{urllib.parse.urlencode(params)}"
        data, headers = _request(url)
        if total_pages is None:
            total_pages = headers.get("x-wp-totalpages")
        for p in data or []:
            records.append({
                "id": p.get("id"), "slug": p.get("slug"), "link": p.get("link"),
                "modified": p.get("modified"), "modified_gmt": p.get("modified_gmt"),
                "title": (p.get("title") or {}).get("rendered"), "status": p.get("status"),
            })
        if not data or len(data) < 100:
            break
        page += 1
    return {"connector": CONNECTOR, "command": "content",
            "query": {"type": args.type, "modified_after": args.modified_after},
            "base_url": base, "total_pages": total_pages,
            "count": len(records), "records": records, "gaps": []}


def _rm_get(base, path, params=None):
    """GET a RankMath analytics endpoint. Returns parsed json."""
    url = f"{base}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data, _ = _request(url)
    return data


def _delta(d):
    """RankMath returns {total, previous, difference} blobs; keep just those three."""
    if not isinstance(d, dict):
        return d
    return {k: d.get(k) for k in ("total", "previous", "difference") if k in d}


def cmd_analytics(args):
    """RankMath Analytics: search performance, ranking distribution, indexing health,
    internal-link health, and best/worst pages. Read-only."""
    base, _, _ = _config()
    gaps, res = [], {}

    def grab(label, path, params=None):
        try:
            return _rm_get(base, path, params)
        except WPError as e:
            gaps.append(f"{label} unavailable: {e}")
            return None

    AN = "/wp-json/rankmath/v1/an"

    ks = grab("keywordsSummary", f"{AN}/keywordsSummary")
    if isinstance(ks, dict):
        res["search_performance"] = {
            "posts_tracked": ks.get("posts"),
            "clicks": _delta(ks.get("clicks")),
            "impressions": _delta(ks.get("impressions")),
            "avg_position": _delta(ks.get("position")),
            "ctr": _delta(ks.get("ctr")),
            "ranking_keyword_count": _delta(ks.get("keywords")),
        }

    ko = grab("keywordsOverview", f"{AN}/keywordsOverview")
    if isinstance(ko, dict) and isinstance(ko.get("topKeywords"), dict):
        tk = ko["topKeywords"]
        res["ranking_distribution"] = {
            k: _delta(tk.get(k)) for k in ("top3", "top10", "top50", "top100") if k in tk
        }
        res["ranking_distribution"]["ctr"] = tk.get("ctr")
        res["ranking_distribution"]["ctr_difference"] = tk.get("ctrDifference")

    asum = grab("analyticsSummary", f"{AN}/analyticsSummary")
    if isinstance(asum, dict):
        if isinstance(asum.get("optimization"), dict):
            res["seo_score_distribution"] = asum["optimization"]
        if isinstance(asum.get("summary"), dict):
            res["site_totals"] = asum["summary"]

    ins = grab("inspectionStats", f"{AN}/inspectionStats")
    if isinstance(ins, dict) and isinstance(ins.get("presence"), dict):
        res["google_indexing"] = ins["presence"]

    lnk = grab("links/posts-stats", "/wp-json/rankmath/v1/links/posts-stats")
    if isinstance(lnk, dict):
        res["internal_links"] = lnk
        tot, orph = lnk.get("total_posts"), lnk.get("orphan_posts")
        if isinstance(tot, int) and isinstance(orph, int) and tot:
            res["internal_links"]["orphan_pct"] = round(100.0 * orph / tot, 1)

    po = grab("postsOverview", f"{AN}/postsOverview")
    if isinstance(po, dict):
        def top_pages(key, limit=5):
            blob = po.get(key)
            if not isinstance(blob, dict):
                return None
            rows = []
            for page, v in list(blob.items())[:limit]:
                if not isinstance(v, dict):
                    continue
                rows.append({
                    "page": page,
                    "title": v.get("title"),
                    "position": _delta(v.get("position")),
                    "clicks": _delta(v.get("clicks")),
                    "impressions": _delta(v.get("impressions")),
                })
            return rows or None
        win, lose = top_pages("winningPosts"), top_pages("losingPosts")
        if win:
            res["winning_pages"] = win
        if lose:
            res["losing_pages"] = lose

    gaps.append("CTR values are decimal fractions: 0.0929 means 9.29 percent.")
    gaps.append("These figures are RankMath's own Google Search Console dataset over ITS "
                "configured comparison period, NOT the report's Sunday-to-Saturday week. Use them "
                "for trend and site-health context, and keep gsc-reader as the weekly clicks "
                "number. Do not present them as this week's totals.")
    if not res:
        gaps.append("no RankMath analytics endpoint returned data; treat WordPress SEO as a gap.")
    return {"connector": CONNECTOR, "command": "analytics", "base_url": base,
            "analytics": res, "gaps": gaps}


def cmd_seo(args):
    base, _, _ = _config()
    url = f"{base}/wp-json/rankmath/v1/getHead?{urllib.parse.urlencode({'url': args.url})}"
    data, _ = _request(url)
    gaps = []
    head = None
    if isinstance(data, dict):
        head = data.get("head") or data.get("data") or data
        if data.get("success") is False:
            gaps.append("RankMath getHead reported success=false for this URL")
    else:
        gaps.append("unexpected getHead response shape")
    return {"connector": CONNECTOR, "command": "seo", "query": {"url": args.url},
            "base_url": base, "rankmath_head": head, "gaps": gaps,
            "verify_live": [
                "RankMath getHead requires 'Headless CMS Support' ENABLED (Rank Math > General Settings > Others, Advanced mode). If you get HTTP 404 'No route was found', that toggle is off — one-time WP change to do with Mohammed.",
                "getHead returns the raw <head> HTML blob in 'head' (no structured per-tag JSON); parse client-side if specific tags are needed.",
            ]}


def cmd_meta(args):
    base, _, _ = _config()
    params = {"_fields": "id,slug,link,meta"}
    url = f"{base}/wp-json/wp/v2/{args.type}/{args.post_id}?{urllib.parse.urlencode(params)}"
    data, _ = _request(url)
    meta = (data or {}).get("meta") or {}
    rank_math = {k: v for k, v in meta.items() if str(k).startswith("rank_math_")}
    gaps = []
    if not rank_math:
        gaps.append("no rank_math_ meta returned: these keys are likely not registered for REST "
                    "(register_post_meta show_in_rest). One-time WordPress change to do with Mohammed, on staging first.")
    return {"connector": CONNECTOR, "command": "meta",
            "query": {"post_id": args.post_id, "type": args.type}, "base_url": base,
            "rank_math_meta": rank_math, "all_meta_keys": sorted(meta.keys()), "gaps": gaps}


def main():
    p = argparse.ArgumentParser(prog="wp_client.py", description="Read-only WordPress/RankMath connector (PHR MCD)")
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("content")
    sp.add_argument("--type", default="posts", choices=["posts", "pages"])
    sp.add_argument("--modified-after", dest="modified_after", default=None, help="YYYY-MM-DD")

    sp = sub.add_parser("analytics", help="RankMath Analytics: search performance, ranking "
                                         "distribution, indexing health, internal links")

    sp = sub.add_parser("seo")
    sp.add_argument("--url", required=True, help="full URL to fetch RankMath head for")

    sp = sub.add_parser("meta")
    sp.add_argument("--post-id", dest="post_id", required=True)
    sp.add_argument("--type", default="posts", choices=["posts", "pages"])

    args = p.parse_args()
    handlers = {"content": cmd_content, "seo": cmd_seo, "meta": cmd_meta,
                "analytics": cmd_analytics}
    try:
        print(json.dumps(handlers[args.command](args), indent=2))
        return 0
    except WPError as e:
        print(json.dumps({"connector": CONNECTOR, "command": args.command,
                          "error": str(e), "status": e.status, "detail": e.detail, "url": e.url},
                         indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
