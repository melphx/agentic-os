#!/usr/bin/env python3
"""
gtm_client.py - read-only Google Tag Manager (API v2) connector for PHR MCD.

MUST run with the Hermes venv Python (system python3 lacks the Google libs):
  /usr/local/lib/hermes-agent/venv/bin/python3 gtm_client.py <command> ...

Configuration only, no traffic. Purpose: when a conversion drops, check whether
a tag/trigger/variable or the container version changed.

Shared contract:
  1. Read-only creds from env: GTM_SA_JSON (Viewer service-account key path),
     GTM_ACCOUNT_ID, GTM_CONTAINER_ID (the latter two optional; discover via
     the accounts/containers commands).
  2. Structured JSON on stdout.
  3. The account/container echoed back.
  4. Loud failure: any auth/API error -> JSON error on stderr, exit 1.
  5. Gaps reported as gaps.

Commands: accounts | containers | live | versions
"""

import argparse
import json
import os
import sys

GTM_HOST = "https://tagmanager.googleapis.com"
SCOPE = "https://www.googleapis.com/auth/tagmanager.readonly"
CONNECTOR = "gtm-reader"


class GTMError(Exception):
    def __init__(self, message, status=None, detail=None):
        super().__init__(message)
        self.status = status
        self.detail = detail


def _session():
    sa_path = os.environ.get("GTM_SA_JSON", "").strip()
    if not sa_path:
        raise GTMError("GTM_SA_JSON is not set in the environment.")
    if not os.path.isfile(sa_path):
        raise GTMError(f"GTM_SA_JSON points to a missing file: {sa_path}")
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import AuthorizedSession
    except Exception as e:
        raise GTMError(f"Google auth libs not importable — run with the venv python: {e}")
    try:
        creds = service_account.Credentials.from_service_account_file(sa_path, scopes=[SCOPE])
        return AuthorizedSession(creds)
    except Exception as e:
        raise GTMError(f"Failed to load service-account credentials: {e}")


def _get(path):
    sess = _session()
    url = f"{GTM_HOST}{path}"
    try:
        resp = sess.get(url, timeout=60)
    except Exception as e:
        raise GTMError(f"Network error reaching GTM API: {e}")
    if resp.status_code != 200:
        raise GTMError(f"HTTP {resp.status_code} from GTM API", status=resp.status_code,
                       detail=resp.text[:800])
    return resp.json()


def _account_id():
    a = os.environ.get("GTM_ACCOUNT_ID", "").strip()
    if not a:
        raise GTMError("GTM_ACCOUNT_ID is not set (run the 'accounts' command to find it).")
    return a


def _container_id():
    c = os.environ.get("GTM_CONTAINER_ID", "").strip()
    if not c:
        raise GTMError("GTM_CONTAINER_ID is not set (run the 'containers' command to find it).")
    return c


def cmd_accounts(args):
    data = _get("/tagmanager/v2/accounts")
    accts = [{"accountId": a.get("accountId"), "name": a.get("name")}
             for a in data.get("account", []) or []]
    return {"connector": CONNECTOR, "command": "accounts", "count": len(accts),
            "accounts": accts, "gaps": []}


def cmd_containers(args):
    aid = _account_id()
    data = _get(f"/tagmanager/v2/accounts/{aid}/containers")
    conts = [{"containerId": c.get("containerId"), "name": c.get("name"),
              "publicId": c.get("publicId"), "usageContext": c.get("usageContext")}
             for c in data.get("container", []) or []]
    return {"connector": CONNECTOR, "command": "containers", "account_id": aid,
            "count": len(conts), "containers": conts, "gaps": []}


def cmd_live(args):
    aid, cid = _account_id(), _container_id()
    v = _get(f"/tagmanager/v2/accounts/{aid}/containers/{cid}/versions:live")
    tags = [{"tagId": t.get("tagId"), "name": t.get("name"), "type": t.get("type"),
             "firingTriggerId": t.get("firingTriggerId"), "paused": t.get("paused")}
            for t in v.get("tag", []) or []]
    triggers = [{"triggerId": t.get("triggerId"), "name": t.get("name"), "type": t.get("type")}
                for t in v.get("trigger", []) or []]
    variables = [{"variableId": x.get("variableId"), "name": x.get("name"), "type": x.get("type")}
                 for x in v.get("variable", []) or []]
    return {"connector": CONNECTOR, "command": "live", "account_id": aid, "container_id": cid,
            "live_version_id": v.get("containerVersionId"), "version_name": v.get("name"),
            "counts": {"tags": len(tags), "triggers": len(triggers), "variables": len(variables)},
            "tags": tags, "triggers": triggers, "variables": variables, "gaps": []}


def cmd_versions(args):
    aid, cid = _account_id(), _container_id()
    data = _get(f"/tagmanager/v2/accounts/{aid}/containers/{cid}/version_headers")
    heads = [{"containerVersionId": h.get("containerVersionId"), "name": h.get("name"),
              "numTags": h.get("numTags"), "numTriggers": h.get("numTriggers"),
              "numVariables": h.get("numVariables"), "deleted": h.get("deleted")}
             for h in data.get("containerVersionHeader", []) or []]
    return {"connector": CONNECTOR, "command": "versions", "account_id": aid, "container_id": cid,
            "count": len(heads), "versions": heads, "gaps": []}


def main():
    p = argparse.ArgumentParser(prog="gtm_client.py", description="Read-only GTM connector (PHR MCD)")
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("accounts", "containers", "live", "versions"):
        sub.add_parser(name)
    args = p.parse_args()
    handlers = {"accounts": cmd_accounts, "containers": cmd_containers,
                "live": cmd_live, "versions": cmd_versions}
    try:
        print(json.dumps(handlers[args.command](args), indent=2))
        return 0
    except GTMError as e:
        print(json.dumps({"connector": CONNECTOR, "command": args.command,
                          "error": str(e), "status": e.status, "detail": e.detail},
                         indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
