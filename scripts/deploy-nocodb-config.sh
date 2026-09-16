#!/usr/bin/env bash
# deploy-nocodb-config.sh
# Verifies and configures NocoDB integration with PostgreSQL for 321 Clementi Parking Barcode

set -euo pipefail

NOCODB_URL="${NOCODB_URL:-https://nocodb.pancatz.com}"
XC_TOKEN="${XC_TOKEN:-}"

echo "=== Verifying NocoDB Health ==="
curl -s -f "${NOCODB_URL}/api/v1/health" | grep -q "OK"
echo "NocoDB is healthy at ${NOCODB_URL}."

if [ -z "${XC_TOKEN}" ]; then
  echo "Notice: XC_TOKEN environment variable not set. Skipping authenticated API checks."
  echo "Usage: XC_TOKEN=[REDACTED] ./scripts/deploy-nocodb-config.sh"
  exit 0
fi

echo "=== Verifying Bases ==="
curl -s -f -H "xc-token: ${XC_TOKEN}" "${NOCODB_URL}/api/v2/meta/bases/" > /dev/null
echo "NocoDB Bases API accessible."

echo "=== NocoDB Configuration Verification Complete ==="
