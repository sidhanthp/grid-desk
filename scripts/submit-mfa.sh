#!/usr/bin/env bash
set -euo pipefail

collector_url="${1:-http://localhost:8001}"
read -r -s -p "INGEST_TOKEN: " ingest_token
printf '\n'
read -r -s -p "Current six-digit Con Edison code: " mfa_code
printf '\n'

if [[ ! "$mfa_code" =~ ^[0-9]{6}$ ]]; then
  printf 'The MFA code must contain exactly six digits.\n' >&2
  exit 1
fi
if [[ "$ingest_token" == *$'\n'* || "$ingest_token" == *$'\r'* ]]; then
  printf 'INGEST_TOKEN cannot contain line breaks.\n' >&2
  exit 1
fi

payload_file="$(mktemp)"
headers_file="$(mktemp)"
trap 'rm -f "$payload_file" "$headers_file"' EXIT
chmod 600 "$payload_file" "$headers_file"
printf '{"code":"%s"}' "$mfa_code" > "$payload_file"
printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$ingest_token" > "$headers_file"

curl --fail-with-body --silent --show-error \
  --request POST \
  --header "@${headers_file}" \
  --data-binary "@${payload_file}" \
  "${collector_url%/}/auth/mfa"
printf '\n'

unset ingest_token mfa_code
