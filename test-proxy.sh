#!/bin/bash
# Test proxy endpoint directly
set -e
if ! command -v jq >/dev/null 2>&1; then
  echo "jq not installed; printing raw responses"
  USE_JQ=0
else
  USE_JQ=1
fi

EPOCH=$(date +%s%3N)
REDEEM_URL="http://localhost:3001/proxy?action=redeem&session_id=cs_test_abc&productId=abc&origin=http://localhost:8000&_=$EPOCH"
HEALTH_URL="http://localhost:3001/proxy?action=health&_=$EPOCH"

echo "Testing proxy redeem endpoint: $REDEEM_URL"
if [ "$USE_JQ" -eq 1 ]; then
  curl -s "$REDEEM_URL" | jq .
else
  curl -s "$REDEEM_URL"
fi

echo -e "\nTesting proxy health endpoint: $HEALTH_URL"
if [ "$USE_JQ" -eq 1 ]; then
  curl -s "$HEALTH_URL" | jq .
else
  curl -s "$HEALTH_URL"
fi