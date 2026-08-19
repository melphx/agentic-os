#!/usr/bin/env python3
"""
ghl_monitor.py — GHL Monitor agent for AgenticOS.

Runs all configured rules against the GHL REST API and returns a structured
JSON report with findings per rule.

Output (stdout): JSON { run_at, status, findings: [{ rule_id, title, status, items, count }] }
Errors (stderr): descriptive message, exit 1.

Config (env vars):
  GHL_API_KEY          — sub-account PIT token (read-only)
  GHL_LOCATION_ID      — sub-account location ID

Optional user-ID config (env vars — fill in after finding IDs in GHL):
  GHL_MONITOR_AVA_ID          — GHL user ID for Ava
  GHL_MONITOR_JUSTIN_ID       — GHL user ID for Justin
  GHL_MONITOR_RODRIGO_ID      — GHL user ID for Rodrigo
  GHL_MONITOR_REBEKAH_ID      — GHL user ID for Rebekah
  GHL_MONITOR_NICOLE_ID       — GHL user ID for Nicole
  GHL_MONITOR_PPC_LIST_ID     — smart list ID for PPC leads
  GHL_MONITOR_N8N_WEBHOOK     — N8N webhook for design-rendering email alerts
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("America/Phoenix")
except Exception:
    TZ = None

BASE_URL   = "https://services.leadconnectorhq.com"
VERSION    = "2021-07-28"

# ── Config ─────────────────────────────────────────────────────────────────

def _cfg():
    key = os.environ.get("GHL_API_KEY", "").strip()
    loc = os.environ.get("GHL_LOCATION_ID", "").strip()
    if not key or not loc:
        raise RuntimeError("GHL_API_KEY and GHL_LOCATION_ID must be set.")
    return key, loc

def _uid(name):
    """Get a configured user ID; returns None if not set (rule will skip)."""
    return os.environ.get(f"GHL_MONITOR_{name}_ID", "").strip() or None

DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.net", "yopmail.com",
    "throwam.com", "sharklasers.com", "spam4.me", "trashmail.com",
    "maildrop.cc", "dispostable.com", "fakeinbox.com", "tempmail.com",
    "temp-mail.org", "getnada.com", "mailnull.com",
}

TYPO_DOMAINS = {"gmial.com", "yahooo.com", "hotmal.com", "outlok.com", "gmai.com", "gnail.com"}

NEGATIVE_PHRASES = [
    "i got this email already", "already got this", "already scheduled",
    "stop sending", "stop emailing", "unsubscribe", "remove me",
    "take me off", "don't email me", "do not email", "i already have an appointment",
]

DESIGN_TASK_KEYWORDS = ["design rendering", "client story", "rendering and story"]

# Stagnation windows per stage name (days) — adjust as needed
STAGE_WINDOWS = {
    "new lead":                        1,
    "phone consultation scheduled":    4,
    "phone consultation completed":    3,
    "in-home scheduled":               5,
    "proposal sent":                   7,
    "follow up":                       5,
}

# ── HTTP helper ─────────────────────────────────────────────────────────────

def _get(path, params=None, retries=3):
    key, _ = _cfg()
    params = params or {}
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BASE_URL}{path}?{qs}" if qs else f"{BASE_URL}{path}"
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, method="GET")
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Version", VERSION)
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent",
                       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(2)
                continue
            detail = ""
            try: detail = e.read().decode()[:300]
            except: pass
            raise RuntimeError(f"GHL HTTP {e.code}: {detail} ({url})")
        except urllib.error.URLError as e:
            if attempt < retries:
                time.sleep(1.5)
                continue
            raise RuntimeError(f"GHL network error: {e.reason}")


def _get_all_pages(path, list_key, params=None, max_pages=20):
    """Paginate through GHL results, return all items."""
    params = dict(params or {})
    _, loc = _cfg()
    params.setdefault("locationId", loc)
    items = []
    params["limit"] = 100
    params["skip"] = 0
    for _ in range(max_pages):
        data = _get(path, params)
        batch = data.get(list_key, [])
        items.extend(batch)
        total = data.get("total", data.get("count", len(items)))
        params["skip"] += len(batch)
        if not batch or params["skip"] >= total:
            break
    return items


def _now_phoenix():
    if TZ:
        return datetime.now(TZ)
    return datetime.utcnow()


def _days_ago(n):
    return (_now_phoenix() - timedelta(days=n)).isoformat()


def _days_since(iso_str):
    """Return days since an ISO timestamp string, or 0 if unparseable."""
    if not iso_str:
        return 0
    try:
        for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S%z"):
            try:
                dt = datetime.strptime(iso_str[:26], fmt[:len(iso_str)])
                if TZ and dt.tzinfo is None:
                    from zoneinfo import ZoneInfo
                    dt = dt.replace(tzinfo=ZoneInfo("UTC"))
                return (_now_phoenix().replace(tzinfo=None) - dt.replace(tzinfo=None)).days
            except:
                continue
    except:
        pass
    return 0


def _ok(rule_id, title):
    return {"rule_id": rule_id, "title": title, "status": "ok", "items": [], "count": 0}

def _finding(rule_id, title, items, urgent=False):
    status = "urgent" if (urgent and items) else ("warning" if items else "ok")
    return {"rule_id": rule_id, "title": title, "status": status, "items": items, "count": len(items)}


# ── Rules ───────────────────────────────────────────────────────────────────

def rule_1_test_contacts():
    """Search contacts with 'test' in name."""
    _, loc = _cfg()
    try:
        data = _get("/contacts/search", {"locationId": loc, "query": "test", "limit": 50})
        contacts = data.get("contacts", [])
        items = []
        for c in contacts:
            name = (c.get("contactName") or c.get("name") or "").lower()
            if "test" not in name:
                continue
            items.append({
                "name": c.get("contactName") or c.get("name"),
                "email": c.get("email", ""),
                "assigned_to": c.get("assignedTo", ""),
                "created": c.get("dateAdded", ""),
                "age_days": _days_since(c.get("dateAdded", "")),
                "id": c.get("id", ""),
            })
        urgent_count = sum(1 for i in items if i.get("age_days", 0) >= 7)
        return _finding(1, '"Test" Contact Sweep', items, urgent=urgent_count > 0)
    except Exception as e:
        return {"rule_id": 1, "title": '"Test" Contact Sweep', "status": "error", "error": str(e), "items": [], "count": 0}


def rule_2_fake_emails():
    """Scan contacts created in last 7 days for bad/fake emails."""
    _, loc = _cfg()
    try:
        contacts = _get_all_pages("/contacts/", "contacts", {
            "locationId": loc,
            "startAfter": int((_now_phoenix() - timedelta(days=7)).timestamp() * 1000),
        })
        items = []
        for c in contacts:
            email = (c.get("email") or "").strip().lower()
            if not email:
                continue
            flag = None
            if "@" not in email:
                flag = "no @ symbol"
            else:
                domain = email.split("@")[-1]
                if domain in DISPOSABLE_DOMAINS:
                    flag = f"disposable domain ({domain})"
                elif domain in TYPO_DOMAINS:
                    flag = f"likely typo domain ({domain})"
            if flag:
                items.append({
                    "name": c.get("contactName") or c.get("name"),
                    "email": email,
                    "flag": flag,
                    "assigned_to": c.get("assignedTo", ""),
                    "created": c.get("dateAdded", ""),
                    "id": c.get("id", ""),
                })
        return _finding(2, "Fake / Bad Email Detection", items)
    except Exception as e:
        return {"rule_id": 2, "title": "Fake / Bad Email Detection", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_3_missed_replies():
    """Conversations with unanswered inbound messages older than 24h."""
    _, loc = _cfg()
    try:
        data = _get("/conversations/search", {
            "locationId": loc, "status": "open", "limit": 100,
        })
        convos = data.get("conversations", [])
        items = []
        cutoff_hours = 24
        for c in convos:
            last_dir = c.get("lastMessageDirection", "")
            last_ts  = c.get("lastMessageDate") or c.get("dateUpdated", "")
            if last_dir != "inbound":
                continue
            age_h = _days_since(last_ts) * 24
            if age_h < cutoff_hours:
                # try finer check
                try:
                    from datetime import datetime
                    dt_str = last_ts[:19]
                    dt = datetime.strptime(dt_str, "%Y-%m-%dT%H:%M:%S")
                    age_h = (_now_phoenix().replace(tzinfo=None) - dt).total_seconds() / 3600
                except:
                    pass
            if age_h >= cutoff_hours:
                items.append({
                    "contact_name": c.get("contactName") or c.get("fullName", "Unknown"),
                    "last_message_preview": (c.get("lastMessageBody") or "")[:80],
                    "hours_waiting": round(age_h, 1),
                    "conversation_id": c.get("id", ""),
                })
        return _finding(3, "Missed Employee Replies", items)
    except Exception as e:
        return {"rule_id": 3, "title": "Missed Employee Replies", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_4_negative_phrases():
    """Scan recent inbound messages for negative sentiment phrases."""
    _, loc = _cfg()
    try:
        data = _get("/conversations/search", {
            "locationId": loc, "status": "open", "limit": 100,
        })
        convos = data.get("conversations", [])
        items = []
        for c in convos:
            body = (c.get("lastMessageBody") or "").lower()
            if c.get("lastMessageDirection") != "inbound":
                continue
            matched = next((p for p in NEGATIVE_PHRASES if p in body), None)
            if matched:
                items.append({
                    "contact_name": c.get("contactName") or c.get("fullName", "Unknown"),
                    "matched_phrase": matched,
                    "message_preview": (c.get("lastMessageBody") or "")[:80],
                    "conversation_id": c.get("id", ""),
                })
        return _finding(4, "Negative Sentiment Phrases", items)
    except Exception as e:
        return {"rule_id": 4, "title": "Negative Sentiment Phrases", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_5_ava_tasks():
    """Check for any open tasks assigned to Ava — URGENT."""
    _, loc = _cfg()
    ava_id = _uid("AVA")
    if not ava_id:
        return {"rule_id": 5, "title": "Ava Has Tasks", "status": "skipped",
                "note": "Set GHL_MONITOR_AVA_ID env var to enable this rule.", "items": [], "count": 0}
    try:
        data = _get("/tasks/", {"locationId": loc, "assignedTo": ava_id, "isCompleted": "false", "limit": 50})
        tasks = data.get("tasks", [])
        items = [{"task": t.get("title"), "contact_id": t.get("contactId", ""),
                  "due": t.get("dueDate", ""), "id": t.get("id", "")} for t in tasks]
        return _finding(5, "Ava Has Tasks", items, urgent=True)
    except Exception as e:
        return {"rule_id": 5, "title": "Ava Has Tasks", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_6_design_rendering():
    """Design Rendering tasks older than 30 days for Rebekah / Nicole."""
    _, loc = _cfg()
    rebekah_id = _uid("REBEKAH")
    nicole_id  = _uid("NICOLE")
    watched = [uid for uid in [rebekah_id, nicole_id] if uid]
    if not watched:
        return {"rule_id": 6, "title": "Design Rendering Overdue", "status": "skipped",
                "note": "Set GHL_MONITOR_REBEKAH_ID and/or GHL_MONITOR_NICOLE_ID to enable.", "items": [], "count": 0}
    try:
        all_tasks = _get_all_pages("/tasks/", "tasks", {"locationId": loc, "isCompleted": "false"})
        items = []
        for t in all_tasks:
            if t.get("assignedTo") not in watched:
                continue
            title_lower = (t.get("title") or "").lower()
            if not any(k in title_lower for k in DESIGN_TASK_KEYWORDS):
                continue
            age = _days_since(t.get("dateAdded") or t.get("createdAt", ""))
            if age >= 30:
                contact = t.get("contact", {}) or {}
                items.append({
                    "task": t.get("title"),
                    "designer": "Rebekah" if t.get("assignedTo") == rebekah_id else "Nicole",
                    "client_name": contact.get("name") or t.get("contactId", ""),
                    "age_days": age,
                    "due": t.get("dueDate", ""),
                    "id": t.get("id", ""),
                })
        return _finding(6, "Design Rendering Overdue", items)
    except Exception as e:
        return {"rule_id": 6, "title": "Design Rendering Overdue", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_7_hard_bounces():
    """Contacts with hard-bounced email and Email DND not yet enabled."""
    _, loc = _cfg()
    try:
        # GHL doesn't expose a direct bounce filter; pull contacts and check flags
        contacts = _get_all_pages("/contacts/", "contacts", {
            "locationId": loc, "limit": 100,
        })
        items = []
        for c in contacts:
            # emailBounced flag or dnd settings
            if not c.get("emailBounced", False):
                continue
            dnd = c.get("dnd", False)
            dnd_settings = c.get("dndSettings", {}) or {}
            email_dnd = dnd or dnd_settings.get("email", {}).get("status") == "active"
            if not email_dnd:
                items.append({
                    "name": c.get("contactName") or c.get("name"),
                    "email": c.get("email", ""),
                    "bounced": True,
                    "email_dnd_on": False,
                    "id": c.get("id", ""),
                })
        return _finding(7, "Hard Bounce / Email DND", items, urgent=len(items) > 5)
    except Exception as e:
        return {"rule_id": 7, "title": "Hard Bounce / Email DND", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_11_opp_stagnation():
    """Open opps stuck in same stage beyond threshold days."""
    _, loc = _cfg()
    justin_id   = _uid("JUSTIN")
    rodrigo_id  = _uid("RODRIGO")
    rebekah_id  = _uid("REBEKAH")
    watched     = {uid: name for uid, name in [
        (justin_id, "Justin"), (rodrigo_id, "Rodrigo"), (rebekah_id, "Rebekah")
    ] if uid}
    try:
        data = _get("/opportunities/search", {"location_id": loc, "status": "open", "limit": 100})
        opps = data.get("opportunities", [])
        items = []
        for o in opps:
            assigned = o.get("assignedTo") or (o.get("user") or {}).get("id", "")
            stage    = (o.get("pipelineStage") or o.get("status", "")).lower().strip()
            window   = next((v for k, v in STAGE_WINDOWS.items() if k in stage), None)
            if window is None:
                continue
            age = _days_since(o.get("lastStageChangeAt") or o.get("dateAdded", ""))
            if age < window:
                continue
            items.append({
                "name": o.get("name") or o.get("contactName", "Unknown"),
                "stage": o.get("pipelineStage") or o.get("status"),
                "days_in_stage": age,
                "threshold_days": window,
                "assigned_to": watched.get(assigned, assigned),
                "opp_id": o.get("id", ""),
            })
        return _finding(11, "Opp Stage Stagnation", items)
    except Exception as e:
        return {"rule_id": 11, "title": "Opp Stage Stagnation", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_12_overdue_tasks():
    """All open tasks past their due date (excluding Ava, Rebekah/Nicole design tasks)."""
    _, loc = _cfg()
    ava_id     = _uid("AVA")
    rebekah_id = _uid("REBEKAH")
    nicole_id  = _uid("NICOLE")
    exclude    = {uid for uid in [ava_id, rebekah_id, nicole_id] if uid}
    try:
        all_tasks = _get_all_pages("/tasks/", "tasks", {"locationId": loc, "isCompleted": "false"})
        now = _now_phoenix().replace(tzinfo=None)
        items = []
        by_employee: dict = {}
        for t in all_tasks:
            if t.get("assignedTo") in exclude:
                continue
            if any(k in (t.get("title") or "").lower() for k in DESIGN_TASK_KEYWORDS):
                if t.get("assignedTo") in {rebekah_id, nicole_id}:
                    continue
            due_str = t.get("dueDate", "")
            if not due_str:
                continue
            try:
                due_dt = datetime.strptime(due_str[:10], "%Y-%m-%d")
                overdue_days = (now - due_dt).days
            except:
                continue
            if overdue_days < 1:
                continue
            emp = t.get("assignedTo") or "Unassigned"
            by_employee.setdefault(emp, []).append({
                "task": t.get("title"),
                "due": due_str[:10],
                "overdue_days": overdue_days,
                "contact_id": t.get("contactId", ""),
                "id": t.get("id", ""),
            })
        for emp, emp_tasks in by_employee.items():
            emp_tasks.sort(key=lambda x: x["overdue_days"], reverse=True)
            items.append({"employee_id": emp, "task_count": len(emp_tasks), "tasks": emp_tasks[:5]})
        return _finding(12, "Employee Tasks Overdue", items)
    except Exception as e:
        return {"rule_id": 12, "title": "Employee Tasks Overdue", "status": "error", "error": str(e), "items": [], "count": 0}


def rule_14_ppc_leads():
    """PPC leads with no outbound reply or task within 24h of creation."""
    _, loc = _cfg()
    list_id = os.environ.get("GHL_MONITOR_PPC_LIST_ID", "").strip()
    if not list_id:
        return {"rule_id": 14, "title": "PPC Leads Unworked", "status": "skipped",
                "note": "Set GHL_MONITOR_PPC_LIST_ID env var to enable this rule.", "items": [], "count": 0}
    try:
        data = _get(f"/contacts/smart_list/{list_id}", {"locationId": loc, "limit": 100})
        contacts = data.get("contacts", [])
        cutoff   = _now_phoenix().replace(tzinfo=None) - timedelta(hours=24)
        items = []
        for c in contacts:
            created_str = c.get("dateAdded", "")
            if not created_str:
                continue
            try:
                created = datetime.strptime(created_str[:19], "%Y-%m-%dT%H:%M:%S")
            except:
                continue
            if created < cutoff:
                continue  # older than 24h, already handled
            # Check for any outbound activity — use lastActivity or conversation flag
            last_activity = c.get("lastActivity") or c.get("dateUpdated", "")
            has_activity = last_activity and last_activity != created_str
            if not has_activity:
                items.append({
                    "name": c.get("contactName") or c.get("name"),
                    "email": c.get("email", ""),
                    "phone": c.get("phone", ""),
                    "created": created_str[:19],
                    "source": c.get("source", ""),
                    "id": c.get("id", ""),
                })
        return _finding(14, "PPC Leads Unworked", items, urgent=len(items) > 0)
    except Exception as e:
        return {"rule_id": 14, "title": "PPC Leads Unworked", "status": "error", "error": str(e), "items": [], "count": 0}


# ── Main ────────────────────────────────────────────────────────────────────

def run_all():
    start = time.time()
    findings = []

    rules = [
        rule_1_test_contacts,
        rule_2_fake_emails,
        rule_3_missed_replies,
        rule_4_negative_phrases,
        rule_5_ava_tasks,
        rule_6_design_rendering,
        rule_7_hard_bounces,
        rule_11_opp_stagnation,
        rule_12_overdue_tasks,
        rule_14_ppc_leads,
    ]

    for fn in rules:
        try:
            findings.append(fn())
        except Exception as e:
            findings.append({
                "rule_id": fn.__name__,
                "title": fn.__name__,
                "status": "error",
                "error": str(e),
                "items": [],
                "count": 0,
            })

    # Overall status
    statuses = [f.get("status") for f in findings]
    if "urgent" in statuses:
        overall = "urgent"
    elif "warning" in statuses:
        overall = "issues"
    elif "error" in statuses:
        overall = "error"
    else:
        overall = "ok"

    # Summary text
    flagged = [f for f in findings if f.get("status") in ("warning", "urgent")]
    if flagged:
        parts = [f"{f['title']} ({f['count']})" for f in flagged]
        summary = f"GHL Monitor: {len(flagged)} rule(s) flagged — " + ", ".join(parts)
    else:
        summary = "GHL Monitor: All clear ✅"

    result = {
        "run_at": _now_phoenix().isoformat(),
        "status": overall,
        "summary": summary,
        "duration_ms": int((time.time() - start) * 1000),
        "findings": findings,
    }
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        run_all()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
