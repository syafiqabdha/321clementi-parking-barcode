#!/usr/bin/env bash
# =============================================================================
# NocoDB <-> PostgreSQL integration verification — 321 Clementi
#
# This script previously printed fixed "verified"/"PASSED" lines without making
# a single assertion: it reported a clean bill of health against an unreachable
# instance, and its column-permission "audit" was three hardcoded echo lines.
# Every check below performs a real request or a real query, and the script
# exits non-zero if any executed check fails.
#
# Usage
#   NOCODB_URL=https://nocodb.pancatz.com \
#   XC_TOKEN=<nocodb api token> \
#   MALL_OPS_DATABASE_URL=postgresql://mall_operations:pw@db-host:5432/clementi_redemption \
#     ./scripts/deploy-nocodb-config.sh
#
# Environment
#   NOCODB_URL              NocoDB base URL. Must be https:// (SEC-04).
#                           Default: https://nocodb.pancatz.com
#   XC_TOKEN                NocoDB API token (Team & Auth → API Tokens), or a
#                           session JWT. Required for the table-linkage checks;
#                           reported SKIPPED without it.
#   MALL_OPS_DATABASE_URL   Full connection URL for the least-privilege
#                           `mall_operations` role provisioned by
#                           scripts/nocodb-db-roles.sql. Required for the
#                           privilege checks; reported SKIPPED without it.
#   NC_BASE_ID              Optional. Base to check. When unset, the script
#                           picks the first non-meta base whose title contains
#                           "321 Clementi", else the first non-meta base.
# =============================================================================
set -uo pipefail

NOCODB_URL="${NOCODB_URL:-https://nocodb.pancatz.com}"
XC_TOKEN="${XC_TOKEN:-}"
MALL_OPS_DATABASE_URL="${MALL_OPS_DATABASE_URL:-}"
NC_BASE_ID="${NC_BASE_ID:-}"

REQUIRED_TABLES=(shops voucher_pool redemption_logs)
FAILURES=0
SKIPS=0

pass() { printf '[PASS] %s\n' "$1"; }
fail() { printf '[FAIL] %s\n' "$1"; [ -n "${2:-}" ] && printf '        -> %s\n' "$2"; FAILURES=$((FAILURES + 1)); return 0; }
skip() { printf '[SKIP] %s\n' "$1"; [ -n "${2:-}" ] && printf '        -> %s\n' "$2"; SKIPS=$((SKIPS + 1)); }
info() { printf '[info] %s\n' "$1"; }
warn() { printf '[warn] %s\n' "$1"; }

command -v curl >/dev/null 2>&1 || { echo 'fatal: curl is required'; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'fatal: python3 is required'; exit 1; }

# -----------------------------------------------------------------------------
# 0. Transport security (SEC-04): service endpoints must be https
# -----------------------------------------------------------------------------
case "$NOCODB_URL" in
  http://*)
    # Loopback-only escape hatch so the checks can be exercised against a local
    # NocoDB container before deploying. It cannot be used for a real host: the
    # URL must resolve to localhost / 127.0.0.1 / [::1].
    if [ "${NOCODB_ALLOW_INSECURE_HTTP:-false}" = 'true' ] &&
       printf '%s' "$NOCODB_URL" | grep -Eq '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?(/|$)'; then
      warn "NOCODB_URL is plain http on a loopback host — allowed by NOCODB_ALLOW_INSECURE_HTTP=true; never use this for a deployed instance"
    else
      fail 'NOCODB_URL uses plain http — refusing to continue' \
           "got '$NOCODB_URL'; set NOCODB_URL to the https:// endpoint"
      exit 1
    fi
    ;;
  https://*) pass 'NOCODB_URL is https' ;;
  *) fail 'NOCODB_URL is not an absolute http(s) URL' "got '$NOCODB_URL'"; exit 1 ;;
esac

# -----------------------------------------------------------------------------
# 1. Instance reachable
# -----------------------------------------------------------------------------
echo
echo '=== 1. NocoDB health ==='
HEALTH="$(curl -s -m 15 -w '\n%{http_code}' "${NOCODB_URL}/api/v1/health" 2>/dev/null)" || true
HEALTH_CODE="$(printf '%s' "$HEALTH" | tail -n1)"
HEALTH_BODY="$(printf '%s' "$HEALTH" | sed '$d')"
if [ "$HEALTH_CODE" = '200' ] && printf '%s' "$HEALTH_BODY" | grep -q '"message":"OK"'; then
  pass "NocoDB healthy at ${NOCODB_URL}"
else
  fail "NocoDB health check failed at ${NOCODB_URL}/api/v1/health" \
       "http ${HEALTH_CODE:-none} body: $(printf '%s' "$HEALTH_BODY" | head -c 200)"
fi

VERSION="$(curl -s -m 15 "${NOCODB_URL}/api/v1/version" 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("currentVersion",""))' 2>/dev/null)" || VERSION=""
[ -n "$VERSION" ] && info "NocoDB version ${VERSION}"

if [ -z "$XC_TOKEN" ]; then
  skip 'table linkage checks' 'set XC_TOKEN (Team & Auth → API Tokens) to enable'
else
  # ---------------------------------------------------------------------------
  # 2. The admin base exposes the three application tables
  # ---------------------------------------------------------------------------
  echo
  echo '=== 2. Base table linkage ==='
  # NocoDB accepts an API token on `xc-token` and a session JWT on `xc-auth`;
  # sending both keeps this working either way.
  AUTH=(-H "xc-token: ${XC_TOKEN}" -H "xc-auth: ${XC_TOKEN}")

  BASES_JSON="$(curl -s -m 20 "${AUTH[@]}" "${NOCODB_URL}/api/v2/meta/bases/")"
  if printf '%s' "$BASES_JSON" | grep -q 'ERR_AUTHENTICATION_REQUIRED\|Invalid token'; then
    fail 'NocoDB rejected XC_TOKEN' "$(printf '%s' "$BASES_JSON" | head -c 200)"
  else
    BASE_ID="$NC_BASE_ID"
    if [ -z "$BASE_ID" ]; then
      BASE_ID="$(printf '%s' "$BASES_JSON" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
bases = [b for b in data.get("list", []) if not b.get("is_meta")]
preferred = [b for b in bases if "321 clementi" in (b.get("title") or "").lower()]
pick = (preferred or bases or [None])[0]
print(pick["id"] if pick else "")
' 2>/dev/null)"
    fi

    if [ -z "$BASE_ID" ]; then
      fail 'no NocoDB base found for the 321 Clementi database' \
           'create the base in the NocoDB UI — see docs/operations/COOLIFY_DEPLOYMENT.md §4'
    else
      info "checking base ${BASE_ID}"
      TABLES_JSON="$(curl -s -m 25 "${AUTH[@]}" "${NOCODB_URL}/api/v2/meta/bases/${BASE_ID}/tables")"
      LINKED="$(printf '%s' "$TABLES_JSON" | python3 -c '
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(",".join(sorted(t["table_name"] for t in data.get("list", []) if t.get("type") == "table")))
' 2>/dev/null)"

      if [ -z "$LINKED" ]; then
        fail 'base exposes no linked tables' "$(printf '%s' "$TABLES_JSON" | head -c 200)"
      else
        info "linked tables: ${LINKED}"
        for t in "${REQUIRED_TABLES[@]}"; do
          case ",${LINKED}," in
            *",${t},"*) pass "table linked: ${t}" ;;
            *) fail "table NOT linked: ${t}" 'link it in the NocoDB UI (Data Sources → Sync)' ;;
          esac
        done
      fi
    fi
  fi
fi

# -----------------------------------------------------------------------------
# 3. Least-privilege enforcement, verified by real negative tests
# -----------------------------------------------------------------------------
echo
echo '=== 3. mall_operations privilege checks ==='
if [ -z "$MALL_OPS_DATABASE_URL" ]; then
  skip 'mall_operations privilege checks' \
       'set MALL_OPS_DATABASE_URL=postgresql://mall_operations:...@host:5432/clementi_redemption to enable'
else
  # psql is not guaranteed on a Coolify host; the postgres:16-alpine image the
  # stack already runs can execute the probes without installing anything.
  PSQL_MODE=''
  if command -v psql >/dev/null 2>&1; then
    PSQL_MODE='native'
  elif command -v docker >/dev/null 2>&1; then
    PSQL_MODE='docker'
    info 'psql not on PATH — probing through the postgres:16-alpine image'
  fi

  if [ -z "$PSQL_MODE" ]; then
    skip 'mall_operations privilege checks' 'neither psql nor docker is available'
  else
    # $1 label, $2 sql, $3 expectation (allow|deny)
    #
    # Every probe runs inside BEGIN/ROLLBACK: the statement is fully executed
    # and privilege-checked, but nothing is persisted — so re-running this
    # script is idempotent and never plants a probe voucher in the live pool.
    probe() {
      local label="$1" sql="$2" expect="$3" out rc
      if [ "$PSQL_MODE" = 'native' ]; then
        out="$(psql "$MALL_OPS_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "BEGIN; ${sql} ROLLBACK;" 2>&1)"; rc=$?
      else
        out="$(docker run --rm -i --network host postgres:16-alpine psql "$MALL_OPS_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "BEGIN; ${sql} ROLLBACK;" 2>&1)"; rc=$?
      fi
      if [ "$expect" = 'allow' ]; then
        if [ $rc -eq 0 ]; then pass "$label"; else fail "$label" "expected success, got: $(printf '%s' "$out" | head -c 200)"; fi
      else
        if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q 'permission denied'; then
          pass "$label"
        else
          fail "$label" "expected 'permission denied', got: $(printf '%s' "$out" | head -c 200)"
        fi
      fi
    }

    # Unique 10-digit probe code: a fixed code would collide with the previous
    # run's row through the UNIQUE constraint, which is not a privilege signal.
    PROBE_CODE="9$(printf '%09d' $(( (RANDOM * 32768 + RANDOM) % 1000000000 )))"
    PROBE_CODE_DENY="8$(printf '%09d' $(( (RANDOM * 32768 + RANDOM) % 1000000000 )))"
    info "probe voucher codes ${PROBE_CODE} / ${PROBE_CODE_DENY} (rolled back, never persisted)"

    probe 'mall_operations may READ the voucher pool (incl. vehicle_plate_hash)' \
          'SELECT count(*) FROM voucher_pool;' allow
    probe 'mall_operations may READ redemption_logs (dispute lookup)' \
          'SELECT count(*) FROM redemption_logs;' allow
    probe 'mall_operations may ADD voucher inventory (NocoDB CSV batch upload)' \
          "INSERT INTO voucher_pool (voucher_code, barcode_format, status) VALUES ('${PROBE_CODE}','CODE128','AVAILABLE');" allow
    probe 'mall_operations may NOT pre-set vehicle_plate_hash on a new voucher' \
          "INSERT INTO voucher_pool (voucher_code, barcode_format, status, vehicle_plate_hash) VALUES ('${PROBE_CODE_DENY}','CODE128','AVAILABLE','probe');" deny
    probe 'mall_operations may EDIT ticket-deck fields on shops' \
          'UPDATE shops SET name = name WHERE false;' allow
    probe 'mall_operations may NOT flip a voucher status' \
          "UPDATE voucher_pool SET status='REDEEMED' WHERE voucher_code='0991323001';" deny
    probe 'mall_operations may NOT write vehicle_plate_hash' \
          "UPDATE voucher_pool SET vehicle_plate_hash='probe' WHERE id > 0;" deny
    probe 'mall_operations may NOT rewrite a redemption row' \
          'UPDATE redemption_logs SET receipt_amount = 0 WHERE true;' deny
    probe 'mall_operations may NOT delete redemption history' \
          'DELETE FROM redemption_logs WHERE true;' deny
    probe 'mall_operations may NOT insert a forged redemption' \
          "INSERT INTO redemption_logs (receipt_amount, receipt_date, voucher_code) VALUES (99, CURRENT_DATE, '0991323001');" deny
    probe 'mall_operations may NOT truncate the audit trail' \
          'TRUNCATE redemption_audit_logs;' deny
  fi
fi

# -----------------------------------------------------------------------------
echo
if [ "$FAILURES" -eq 0 ]; then
  printf 'NOCODB INTEGRATION VERIFICATION PASSED (%d check(s) skipped)\n' "$SKIPS"
  exit 0
fi
printf '%d NOCODB INTEGRATION CHECK(S) FAILED (%d skipped)\n' "$FAILURES" "$SKIPS"
exit 1
