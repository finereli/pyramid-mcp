#!/usr/bin/env bash
# Query Cloudflare Workers Observability logs for pyramid-mcp.
#
# Usage:
#   ./scripts/logs.sh                    # errors from the last 7 days
#   ./scripts/logs.sh errors 24h         # errors from the last 24 hours
#   ./scripts/logs.sh all 1h             # all events from the last hour
#   ./scripts/logs.sh slow 7d            # slow requests (>1s wall time)
#   ./scripts/logs.sh summary 7d         # edge-level summary (counts by outcome)
#
# Requires: CLOUDFLARE_API_TOKEN env var

set -euo pipefail

ACCOUNT_ID="7485eb8ab648601f411b650cd794bce3"
SCRIPT_NAME="pyramid-mcp"
QUERY_TYPE="${1:-errors}"
LOOKBACK="${2:-7d}"

parse_lookback() {
  local val="${1%[dhm]}"
  local unit="${1: -1}"
  case "$unit" in
    d) echo $((val * 86400000)) ;;
    h) echo $((val * 3600000)) ;;
    m) echo $((val * 60000)) ;;
    *) echo $((val * 86400000)) ;;
  esac
}

NOW_MS=$(python3 -c "import time; print(int(time.time()*1000))")
LOOKBACK_MS=$(parse_lookback "$LOOKBACK")
FROM_MS=$((NOW_MS - LOOKBACK_MS))

# --- summary mode: edge-level analytics via GraphQL ---

if [ "$QUERY_TYPE" = "summary" ]; then
  FROM_ISO=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(milliseconds=$LOOKBACK_MS)).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  TO_ISO=$(python3 -c "from datetime import datetime,timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")

  TMPFILE=$(mktemp)
  trap 'rm -f "$TMPFILE"' EXIT

  curl -s "https://api.cloudflare.com/client/v4/graphql" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{
      "query": "query { viewer { accounts(filter: {accountTag: \"'"$ACCOUNT_ID"'\"}) { workersInvocationsAdaptive(limit: 200, filter: { scriptName: \"'"$SCRIPT_NAME"'\", datetime_gt: \"'"$FROM_ISO"'\", datetime_lt: \"'"$TO_ISO"'\" }, orderBy: [datetime_DESC]) { dimensions { datetime status } sum { requests errors subrequests } } } } }"
    }' > "$TMPFILE"

  python3 - "$TMPFILE" "$LOOKBACK" <<'PYEOF'
import json, sys
from collections import Counter

with open(sys.argv[1]) as f:
    data = json.load(f)

lookback = sys.argv[2]
rows = data.get('data', {}).get('viewer', {}).get('accounts', [{}])[0].get('workersInvocationsAdaptive', [])

total = sum(r['sum']['requests'] for r in rows)
by_status = Counter()
for r in rows:
    by_status[r['dimensions']['status']] += r['sum']['requests']

print(f'Edge summary | Lookback: {lookback} | Total requests: {total}')
print()
for status, count in by_status.most_common():
    pct = count / total * 100 if total else 0
    marker = '  ' if status == 'success' else '! '
    print(f'{marker}{status}: {count} ({pct:.1f}%)')

non_success = [(s, c) for s, c in by_status.items() if s != 'success']
if not non_success:
    print()
    print('No errors or disconnects in this period.')
else:
    print()
    print('Non-success events by time:')
    for r in rows:
        if r['dimensions']['status'] != 'success':
            print(f"  {r['dimensions']['datetime']}  {r['dimensions']['status']}  x{r['sum']['requests']}")
PYEOF
  exit 0
fi

# --- telemetry mode: detailed log events via observability API ---

build_filters() {
  local base='{"key":"$workers.scriptName","operation":"eq","type":"string","value":"'"$SCRIPT_NAME"'"}'
  case "$QUERY_TYPE" in
    errors)
      echo '['$base',{"key":"$workers.outcome","operation":"neq","type":"string","value":"ok"}]'
      ;;
    slow)
      echo '['$base',{"key":"$workers.wallTimeMs","operation":"gt","type":"number","value":1000}]'
      ;;
    *)
      echo '['$base']'
      ;;
  esac
}

FILTERS=$(build_filters)
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "queryId": "cli-'"$QUERY_TYPE"'",
    "timeframe": { "from": '"$FROM_MS"', "to": '"$NOW_MS"' },
    "view": "invocations",
    "limit": 30,
    "parameters": {
      "datasets": [],
      "filters": '"$FILTERS"',
      "filterCombination": "and"
    }
  }' > "$TMPFILE"

python3 - "$TMPFILE" "$QUERY_TYPE" "$LOOKBACK" <<'PYEOF'
import json, sys
from datetime import datetime, timezone

with open(sys.argv[1]) as f:
    data = json.load(f)

query_type = sys.argv[2]
lookback = sys.argv[3]

if not data.get('success', False):
    print('Query failed:', json.dumps(data.get('errors', []), indent=2))
    sys.exit(1)

result = data.get('result', {})
stats = result.get('run', {}).get('statistics', {})
invocations = result.get('invocations', {})

print(f'Query: {query_type} | Lookback: {lookback} | Invocations: {len(invocations)} | Rows scanned: {stats.get("rows_read", "?")}')
print()

for req_id, events in sorted(invocations.items(), key=lambda x: x[1][0].get('timestamp', 0)):
    first = events[0]
    w = first.get('$workers', {})
    outcome = w.get('outcome', '?')
    wall = w.get('wallTimeMs', '?')
    cpu = w.get('cpuTimeMs', '?')
    ts = first.get('timestamp', 0)
    dt = datetime.fromtimestamp(ts/1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

    print(f'--- {dt} UTC | {req_id} | outcome={outcome} | wall={wall}ms cpu={cpu}ms ---')

    for e in events:
        ets = e.get('timestamp', 0)
        src = e.get('source', {})
        et = datetime.fromtimestamp(ets/1000, tz=timezone.utc).strftime('%H:%M:%S.%f')[:-3]

        if isinstance(src, dict):
            level = src.get('level', '')
            msg = src.get('message', '')
            exc = src.get('exception', {})
            if exc:
                name = exc.get('name', '')
                emsg = exc.get('message', '')
                stack = exc.get('stack', '')
                print(f'  {et} [EXCEPTION] {name}: {emsg}')
                if stack:
                    for line in stack.split('\n'):
                        print(f'           {line.strip()}')
            elif level and msg:
                print(f'  {et} [{level}] {msg[:200]}')
        else:
            print(f'  {et} {str(src)[:200]}')
    print()

if not invocations:
    print('No matching events found.')
PYEOF
