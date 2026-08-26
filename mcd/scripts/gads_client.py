#!/usr/bin/env python3
"""google-ads-reader: PHR's Google Ads account (read-only).

Built 2026-08-12 ahead of credentials, so that when the three missing pieces land this is a
config change rather than a build. Until then `status` reports exactly what is still needed and
every data command fails loudly instead of returning something misleading.

WHAT GOOGLE ADS NEEDS, and none of it is optional:
  1. GOOGLE_ADS_DEVELOPER_TOKEN   from a Google Ads MANAGER account, applied for and approved by
                                  Google. The hard dependency.
  2. an identity Google Ads accepts. Two supported routes:
       a) domain-wide delegation: set GOOGLE_ADS_IMPERSONATE to a Workspace user who has Ads
          access. A Workspace admin must first authorise the service account client id for
          https://www.googleapis.com/auth/adwords
       b) OAuth: set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN
  3. GOOGLE_ADS_CUSTOMER_ID       the 10 digit account number, no dashes.
     GOOGLE_ADS_LOGIN_CUSTOMER_ID optional, the manager account id if it sits under one.

API VERSION: v22 is the oldest version still accepted as of 2026-08-12. v20 and v21 return
UNSUPPORTED_VERSION, v19 and below no longer exist. Do not lower this without testing.

Costs come back in MICROS. Always divide by 1,000,000. A cost_micros of 1234560000 is $1,234.56.
"""
import argparse, json, os, sys, urllib.error, urllib.request

API_VERSION = os.environ.get("GOOGLE_ADS_API_VERSION", "v22")
BASE = "https://googleads.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/adwords"


class AdsError(Exception):
    pass


def out(payload, gaps):
    payload["gaps"] = gaps
    payload["source"] = "Google Ads API (read-only)"
    json.dump(payload, sys.stdout, indent=2)
    sys.stdout.write("\n")


def _config():
    cfg = {
        "developer_token": os.environ.get("GOOGLE_ADS_DEVELOPER_TOKEN", "").strip(),
        "customer_id": os.environ.get("GOOGLE_ADS_CUSTOMER_ID", "").replace("-", "").strip(),
        "login_customer_id": os.environ.get("GOOGLE_ADS_LOGIN_CUSTOMER_ID", "").replace("-", "").strip(),
        "impersonate": os.environ.get("GOOGLE_ADS_IMPERSONATE", "").strip(),
        "sa_json": (os.environ.get("GOOGLE_ADS_SA_JSON", "").strip()
                    or os.environ.get("CALL_FEEDBACK_SA_JSON", "").strip()),
        "client_id": os.environ.get("GOOGLE_ADS_CLIENT_ID", "").strip(),
        "client_secret": os.environ.get("GOOGLE_ADS_CLIENT_SECRET", "").strip(),
        "refresh_token": os.environ.get("GOOGLE_ADS_REFRESH_TOKEN", "").strip(),
    }
    return cfg


def _missing(cfg):
    miss = []
    if not cfg["developer_token"]:
        miss.append("GOOGLE_ADS_DEVELOPER_TOKEN (from a Google Ads manager account, needs Google's approval)")
    if not cfg["customer_id"]:
        miss.append("GOOGLE_ADS_CUSTOMER_ID (the 10 digit account number)")
    has_oauth = cfg["client_id"] and cfg["client_secret"] and cfg["refresh_token"]
    if not cfg["impersonate"] and not has_oauth:
        miss.append("an identity: either GOOGLE_ADS_IMPERSONATE (a Workspace user, needs "
                    "domain-wide delegation authorised for the adwords scope) or the OAuth trio "
                    "GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN")
    return miss


def _access_token(cfg):
    from google.auth.transport.requests import Request
    if cfg["client_id"] and cfg["client_secret"] and cfg["refresh_token"]:
        from google.oauth2.credentials import Credentials
        creds = Credentials(None, refresh_token=cfg["refresh_token"],
                            token_uri="https://oauth2.googleapis.com/token",
                            client_id=cfg["client_id"], client_secret=cfg["client_secret"],
                            scopes=[SCOPE])
        creds.refresh(Request())
        return creds.token, "oauth refresh token"
    from google.oauth2 import service_account
    if not cfg["sa_json"] or not os.path.exists(cfg["sa_json"]):
        raise AdsError("service-account json not found")
    creds = service_account.Credentials.from_service_account_file(cfg["sa_json"], scopes=[SCOPE])
    if cfg["impersonate"]:
        creds = creds.with_subject(cfg["impersonate"])
    try:
        creds.refresh(Request())
    except Exception as e:  # noqa
        if "unauthorized_client" in str(e):
            raise AdsError(
                "domain-wide delegation is not authorised for this service account. A Google "
                "Workspace admin must add client id %s with the scope %s under Admin console, "
                "Security, API controls, Domain-wide delegation."
                % (json.load(open(cfg["sa_json"])).get("client_id"), SCOPE))
        raise AdsError("could not get an access token: %s" % str(e)[:200])
    return creds.token, ("delegation as %s" % cfg["impersonate"] if cfg["impersonate"]
                         else "bare service account (Google Ads will likely refuse this)")


def _search(cfg, query):
    miss = _missing(cfg)
    if miss:
        raise AdsError("not configured yet. Missing: " + "; ".join(miss))
    tok, how = _access_token(cfg)
    url = "%s/%s/customers/%s/googleAds:search" % (BASE, API_VERSION, cfg["customer_id"])
    req = urllib.request.Request(url, data=json.dumps({"query": query}).encode(), method="POST")
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("developer-token", cfg["developer_token"])
    if cfg["login_customer_id"]:
        req.add_header("login-customer-id", cfg["login_customer_id"])
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.load(r), how
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:900]
        hint = ""
        if "DEVELOPER_TOKEN" in body:
            hint = " -> the developer token is missing, invalid, or not approved for this account."
        elif "USER_PERMISSION_DENIED" in body or "NOT_ADS_USER" in body:
            hint = (" -> the identity has no access to this Ads account. If using delegation, the "
                    "impersonated user must be a user on the Google Ads account.")
        elif "UNSUPPORTED_VERSION" in body:
            hint = " -> bump GOOGLE_ADS_API_VERSION; v22 was the oldest accepted on 2026-08-12."
        raise AdsError("Google Ads API returned HTTP %s.%s Body: %s" % (e.code, hint, body))
    except Exception as e:  # noqa
        raise AdsError("network error reaching Google Ads: %s" % str(e)[:200])


def _micros(v):
    try:
        return round(int(v) / 1_000_000.0, 2)
    except (TypeError, ValueError):
        return None


def cmd_status(args):
    cfg = _config()
    miss = _missing(cfg)
    sa_client = None
    if cfg["sa_json"] and os.path.exists(cfg["sa_json"]):
        try:
            sa_client = json.load(open(cfg["sa_json"])).get("client_id")
        except Exception:
            pass
    payload = {"command": "status", "api_version": API_VERSION,
               "configured": not miss, "missing": miss,
               "developer_token_present": bool(cfg["developer_token"]),
               "customer_id_present": bool(cfg["customer_id"]),
               "identity_route": ("oauth" if cfg["refresh_token"] else
                                  ("delegation as %s" % cfg["impersonate"]) if cfg["impersonate"]
                                  else "none configured"),
               "service_account_client_id_for_delegation": sa_client}
    gaps = []
    if miss:
        gaps.append("google-ads-reader is NOT usable yet. Report Google Ads as a gap; do NOT "
                    "substitute GA4 paid-search sessions for ad spend, they are different things.")
    gaps.append("Even once connected, cost per lead needs Google Ads leads to be identifiable in "
                "GHL. As of 2026-08-12 exactly 1 contact carried the 'Google Ads' source and none "
                "carried 'Google LSA', so spend cannot yet be divided by leads.")
    out(payload, gaps)


def cmd_campaigns(args):
    cfg = _config()
    q = ("SELECT campaign.id, campaign.name, campaign.status, "
         "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions "
         "FROM campaign WHERE segments.date BETWEEN '%s' AND '%s' "
         "ORDER BY metrics.cost_micros DESC" % (args.frm, args.to))
    data, how = _search(cfg, q)
    rows, total = [], 0.0
    for r in data.get("results", []) or []:
        c, m = r.get("campaign", {}), r.get("metrics", {})
        cost = _micros(m.get("costMicros")) or 0.0
        total += cost
        rows.append({"campaign": c.get("name"), "status": c.get("status"), "cost": cost,
                     "impressions": int(m.get("impressions") or 0),
                     "clicks": int(m.get("clicks") or 0),
                     "conversions": float(m.get("conversions") or 0)})
    out({"command": "campaigns", "from": args.frm, "to": args.to, "auth": how,
         "campaigns": rows, "total_cost": round(total, 2), "campaign_count": len(rows)},
        ["Costs are converted from micros. Conversions are Google's own conversion counts and are "
         "NOT the same as qualified leads in GHL; never present them as PHR lead counts."])


def cmd_spend(args):
    cfg = _config()
    q = ("SELECT segments.month, metrics.cost_micros, metrics.clicks, metrics.conversions "
         "FROM customer WHERE segments.date BETWEEN '%s' AND '%s'" % (args.frm, args.to))
    data, how = _search(cfg, q)
    months = {}
    for r in data.get("results", []) or []:
        mo = (r.get("segments", {}) or {}).get("month")
        m = r.get("metrics", {})
        d = months.setdefault(mo, {"month": mo, "cost": 0.0, "clicks": 0, "conversions": 0.0})
        d["cost"] += _micros(m.get("costMicros")) or 0.0
        d["clicks"] += int(m.get("clicks") or 0)
        d["conversions"] += float(m.get("conversions") or 0)
    listed = sorted(months.values(), key=lambda d: d["month"] or "")
    for d in listed:
        d["cost"] = round(d["cost"], 2)
    out({"command": "spend", "from": args.frm, "to": args.to, "auth": how,
         "months": listed, "total_cost": round(sum(d["cost"] for d in listed), 2)},
        ["This is Google Ads spend only. It does NOT include Local Service Ads (Google "
         "Guaranteed), which is a separate account and lives in the marketing spend sheet."])


def main():
    ap = argparse.ArgumentParser(description="Read PHR's Google Ads account (read-only).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("status", help="what is configured and what is still missing")
    s.set_defaults(fn=cmd_status)
    c = sub.add_parser("campaigns", help="cost and performance by campaign")
    c.add_argument("--from", dest="frm", required=True)
    c.add_argument("--to", required=True)
    c.set_defaults(fn=cmd_campaigns)
    p = sub.add_parser("spend", help="spend by month")
    p.add_argument("--from", dest="frm", required=True)
    p.add_argument("--to", required=True)
    p.set_defaults(fn=cmd_spend)
    a = ap.parse_args()
    try:
        a.fn(a)
    except AdsError as e:
        json.dump({"error": str(e), "gaps": ["google-ads-reader unavailable: %s" % e]},
                  sys.stdout, indent=2)
        sys.stdout.write("\n")
        sys.exit(2)


if __name__ == "__main__":
    main()
