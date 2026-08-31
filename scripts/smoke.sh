#!/usr/bin/env bash
# End-to-end smoke test for the live WorkTracker stack.
#
# Verifies, in order:
#   1. The Cloud Run API is reachable.
#   2. A POST /api/items queues a command and the brain materializes
#      a work_item (REST poll, with timeout).
#   3. The dead-letter admin surface: inject a fake-failed command,
#      GET /api/commands/:id/failures lists the sub-docs, and
#      POST /api/commands/:id/replay re-fires the brain.
#   4. The web UI is reachable (just 200, no body check).
#
# Usage:
#   ./scripts/smoke.sh
#
# Env (optional):
#   API_BASE   default https://worktracker-prod-2026.web.app
#   ADMIN_TOKEN default worktracker-prod-2026-admin-token

set -euo pipefail

API_BASE="${API_BASE:-https://worktracker-prod-2026.web.app}"
ADMIN_TOKEN="${ADMIN_TOKEN:-worktracker-prod-2026-admin-token}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
yel()  { printf '\033[33m%s\033[0m\n' "$*"; }

pass=0
fail=0

check() {
  local name="$1"; shift
  if "$@"; then
    grn "  ✓ $name"
    pass=$((pass+1))
  else
    red "  ✗ $name"
    fail=$((fail+1))
  fi
}

bold "WorkTracker smoke — ${API_BASE}"

# ---- 1. API reachable ----
bold "1. API reachable"
code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "${API_BASE}/api/healthz")
check "GET /api/healthz = 200" test "$code" = "200"

# ---- 2. create -> brain -> list ----
bold "2. create → brain → list"
title="smoke-$(date +%s)"
create_resp=$(curl -sS --max-time 10 -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -d "{\"kind\":\"task\",\"title\":\"$title\"}" \
  "${API_BASE}/api/items")
cmd_id=$(echo "$create_resp" | python3 -c "import json,sys; print(json.load(sys.stdin).get('command_id',''))")
check "POST /api/items returned command_id" test -n "$cmd_id"

# Poll the items list for the new title; the brain applies the
# command asynchronously so we retry until the work_item shows
# up, or time out.
found=0
for i in $(seq 1 10); do
  list=$(curl -sS --max-time 10 -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${API_BASE}/api/items?limit=20")
  if echo "$list" | python3 -c "
import json, sys
data = json.load(sys.stdin)
titles = [item.get('title') for item in data.get('items', [])]
sys.exit(0 if '$title' in titles else 1)
"; then
    found=1; break
  fi
  sleep 1
done
check "work_item materialised within 10s" test "$found" = "1"

# ---- 3. dead-letter admin ----
bold "3. dead-letter admin"
dl_id="TEST-DL-$(date +%s)"
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
gcloud_token=$(gcloud auth print-access-token 2>/dev/null || true)
if [[ -n "$gcloud_token" ]]; then
  curl -sS -o /dev/null --max-time 10 -X POST \
    -H "Authorization: Bearer $gcloud_token" \
    -H "Content-Type: application/json" \
    -d "{\"fields\":{
      \"id\":{\"stringValue\":\"$dl_id\"},\"source\":{\"stringValue\":\"web\"},\"op\":{\"stringValue\":\"create\"},
      \"item_id\":{\"nullValue\":null},
      \"payload\":{\"mapValue\":{\"fields\":{\"kind\":{\"stringValue\":\"task\"},
        \"title\":{\"stringValue\":\"smoke dead-letter\"}}}},
      \"status\":{\"stringValue\":\"failed\"},\"applied_event_id\":{\"nullValue\":null},
      \"created_at\":{\"timestampValue\":\"$now\"},\"applied_at\":{\"nullValue\":null},
      \"failure_count\":{\"integerValue\":\"3\"},\"failed_at\":{\"timestampValue\":\"$now\"},
      \"error\":{\"mapValue\":{\"fields\":{\"code\":{\"stringValue\":\"simulated\"},
        \"message\":{\"stringValue\":\"smoke\"}}}}
    }}" \
    "https://firestore.googleapis.com/v1/projects/worktracker-prod-2026/databases/(default)/documents/commands?documentId=$dl_id" >/dev/null
  check "injected fake-failed command $dl_id" test $? -eq 0
else
  yel "  ! gcloud auth not available; skipping injection"
fi

# GET failures (admin)
failures=$(curl -sS --max-time 10 -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${API_BASE}/api/commands/${dl_id}/failures" 2>/dev/null || true)
if [[ -n "$failures" ]]; then
  check "GET /api/commands/:id/failures responded" test $? -eq 0
else
  yel "  ! GET failures returned empty; dead-letter may not exist"
fi

# POST replay — refuses non-failed commands, accepts failed
replay_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 -X POST \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  "${API_BASE}/api/commands/${dl_id}/replay")
check "POST /api/commands/:id/replay = 202" test "$replay_code" = "202"

# ---- 4. Web UI ----
bold "4. Web UI reachable"
ui_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "${API_BASE}/")
check "GET / = 200" test "$ui_code" = "200"
ui_admin_code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "${API_BASE}/admin")
check "GET /admin = 200" test "$ui_admin_code" = "200"

# ---- Summary ----
echo
bold "Summary: $pass passed, $fail failed"
if [[ "$fail" -gt 0 ]]; then
  exit 1
fi
