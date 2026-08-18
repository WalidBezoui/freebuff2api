#!/usr/bin/env python3
"""
Freebuff Real-Time English Account, US Cloud & Quota Monitor Dashboard
Zero quota consumption (uses read-only GET /session & /healthz).
"""

import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

import os
import time
import json
import urllib.request
import urllib.parse
from datetime import datetime
from pathlib import Path

CODEBUFF_URL = "https://www.codebuff.com"
VERCEL_API_URL = "https://freebuff2api-walid-bezouis-projects-fc73dfba.vercel.app"
LOCAL_API_URL = "http://localhost:8787"
CRED_FILE = Path(__file__).resolve().parent / "freebuff_credentials.json"
REQUEST_TIMEOUT = 10

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')

def check_endpoint_health(base_url):
    try:
        req = urllib.request.Request(f"{base_url}/healthz", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status == 200:
                return True, "Online 🟢 (US Egress Active)"
    except Exception as e:
        pass
    return False, "Offline / Standby ⚪"

def http_get_session(tok):
    url = f"{CODEBUFF_URL}/api/v1/freebuff/session"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Authorization": f"Bearer {tok}",
        "x-freebuff-include-unused-rate-limits": "1"
    }
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = {"raw": raw.decode(errors="replace")[:300]}
        return e.code, parsed
    except Exception as e:
        return None, {"error": str(e)}

def load_accounts():
    if CRED_FILE.exists():
        try:
            data = json.loads(CRED_FILE.read_text(encoding="utf-8"))
            if isinstance(data.get("accounts"), dict):
                return list(data["accounts"].values())
            if isinstance(data.get("default"), dict) and data["default"].get("authToken"):
                return [data["default"]]
            if data.get("authToken"):
                return [data]
        except Exception:
            pass
    env_tok = os.environ.get("FREEBUFF_TOKEN")
    if env_tok:
        return [{"email": "Environment Token", "authToken": env_tok}]
    return []

def evaluate_account(tok):
    status, data = http_get_session(tok)
    if status is None:
        return {
            "status_str": "Network Error ⚠️",
            "active_session": False,
            "quota_info": f"Connection failed: {data.get('error')}",
            "resets_at": None,
        }
    if status == 401:
        return {
            "status_str": "Token Invalid ❌",
            "active_session": False,
            "quota_info": "Unauthorized (authToken expired or revoked)",
            "resets_at": None,
        }
    if status == 403:
        banned = isinstance(data, dict) and data.get("status") == "banned"
        return {
            "status_str": "Banned ❌" if banned else "Access Denied (403)",
            "active_session": False,
            "quota_info": "Account restricted or IP blocked",
            "resets_at": None,
        }
    
    is_active = (status == 200 and isinstance(data, dict) and data.get("status") == "active")
    current_model = data.get("model", "None") if is_active else None
    
    if is_active:
        status_label = f"Healthy (Active Session: {current_model}) 🟢"
    else:
        status_label = "Healthy (Standby / Ready) ✅"
    
    rate_limits = data.get("rateLimitsByModel") if isinstance(data, dict) else {}
    quota_lines = []
    earliest_reset = None
    
    if isinstance(rate_limits, dict) and rate_limits:
        for model, info in sorted(rate_limits.items()):
            if not isinstance(info, dict):
                continue
            rc = info.get("recentCount", 0)
            lim = info.get("limit", 6)
            reset = info.get("resetAt") or info.get("reset_at")
            if reset and not earliest_reset:
                earliest_reset = reset
            
            try:
                rem = max(0, round(float(lim) - float(rc), 1))
            except Exception:
                rem = "?"
            quota_lines.append(f"• {model:28} : {rc}/{lim} used ({rem} sessions remaining)")
    
    return {
        "status_str": status_label,
        "active_session": is_active,
        "quota_info": "\n      ".join(quota_lines) if quota_lines else "Standard quota active",
        "resets_at": earliest_reset,
    }

def run_monitor(auto_refresh=True, interval=10):
    while True:
        clear_screen()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        vercel_ok, vercel_status = check_endpoint_health(VERCEL_API_URL)
        
        print("==================================================================")
        print("         FREEBUFF REAL-TIME ACCOUNT & US CLOUD MONITOR            ")
        print("==================================================================")
        print(f" Last Updated : {now_str}")
        print(f" US Cloud API : {vercel_status}")
        print(f" US Endpoint  : {VERCEL_API_URL}/v1")
        print(f" Refresh Rate : Auto-refreshing every {interval}s (Zero Quota Usage)")
        print("==================================================================\n")
        
        accounts = load_accounts()
        if not accounts:
            print("❌ No accounts found in local pool! Run 1-Login.bat to add an account.\n")
        else:
            print(f"📊 Active Accounts in Pool: {len(accounts)}\n")
            for idx, acct in enumerate(accounts, 1):
                email = acct.get("email", "Unknown Email")
                tok = acct.get("authToken", "")
                tok_masked = tok[:8] + "..." + tok[-4:] if len(tok) > 12 else tok
                res = evaluate_account(tok)
                
                print(f"[{idx}] Account: {email}")
                print(f"    Token  : {tok_masked}")
                print(f"    Status : {res['status_str']}")
                print(f"    Quota  :\n      {res['quota_info']}")
                if res["resets_at"]:
                    print(f"    Reset  : {res['resets_at']}")
                print("-" * 66)
        
        if not auto_refresh:
            break
        print("\n💡 Press Ctrl + C to exit this monitor window.")
        try:
            time.sleep(interval)
        except KeyboardInterrupt:
            print("\nExiting monitor...")
            break

if __name__ == "__main__":
    once = "--once" in sys.argv
    run_monitor(auto_refresh=not once, interval=10)
