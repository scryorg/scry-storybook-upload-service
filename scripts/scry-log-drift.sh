#!/usr/bin/env bash
# scry-log-drift: is the scry-log vendored in this repo AHEAD of the stage log store (logs-service)?
# Part of log-core-hardening S4. The vendored copy's schema is computed exactly as scry-management's
# scripts/logs-deploy-check.sh does (scripts/scry-log-schema.mjs, same hash + token list), then compared with the
# stage Worker's open /healthz, which reports {schema: {hash}, entries: <token count>} and never a field name.
#
#   scry-log-drift.sh [dir]       dir defaults to src/lib/scry-log
#     exit 0  in sync, behind (warning), definitions differ (warning), or /healthz unreachable (warning, fail open)
#     exit 1  AHEAD: the vendored copy has more schema entries than the stage store knows, so the store would drop
#             those fields. Message ends "deploy logs-service first". Also when the store reports no hash at all
#             (it predates the schema hash, so every current copy is ahead of it).
#     exit 2  usage, missing dependency, or the vendored copy cannot be read (run sync.sh)
#
# Why counts: scry-management is private, so CI cannot read the store's source at its deployed commit (which is how
# logs-deploy-check.sh finds the missing names). More entries here than in the store is exactly "has names the store
# lacks" when a copy is only ever extended, which is how lib/scry-log changes. A same-count hash difference is a changed
# definition (warning only, as in logs-deploy-check.sh).
#
# Env: SCRY_LOGS_STAGE_URL (default https://logs-stage.scrymore.com), SCRY_LOG_TS_DIR (where `typescript` lives).
set -uo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
dir=${1:-src/lib/scry-log}
url=${SCRY_LOGS_STAGE_URL:-https://logs-stage.scrymore.com}
name=${SCRY_LOG_DRIFT_NAME:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}

warn() { printf 'scry-log-drift: warning: %s\n' "$*"; if [[ -n ${GITHUB_ACTIONS:-} ]]; then printf '::warning title=scry-log-drift::%s\n' "$*"; fi; }

for d in curl jq node; do command -v "$d" >/dev/null 2>&1 || { echo "scry-log-drift: missing dependency: $d" >&2; exit 2; }; done

if ! vjson=$(node "$here/scry-log-schema.mjs" "$dir" 2>&1); then
    printf 'scry-log-drift: cannot read the vendored scry-log in %s: %s\n' "$dir" "$(head -n 3 <<< "$vjson" | tr '\n' ' ')" >&2
    exit 2
fi
vhash=$(jq -r .hash <<< "$vjson"); vcount=$(jq -r .entries <<< "$vjson")

if ! body=$(curl -4 -fsS --max-time 10 --retry 2 --retry-delay 2 "${url%/}/healthz" 2>/dev/null) \
    || ! hz=$(jq -ce 'select(type == "object") | {commit: (.commit // null), hash: (.schema.hash // null), entries: (.entries // null)}' <<< "$body" 2>/dev/null); then
    warn "$url/healthz is unreachable or unreadable; not checking this copy against the stage log store (passing)"
    exit 0
fi
shash=$(jq -r '.hash // empty' <<< "$hz"); scount=$(jq -r '.entries // empty' <<< "$hz"); scommit=$(jq -r '.commit // "unknown"' <<< "$hz")

if [[ -z $shash || -z $scount ]]; then
    printf 'scry-log-drift: %s: its vendored scry-log (%s entries, hash %s) is ahead of the stage log store: the store (commit %s) reports no schema hash, so it predates the hash and cannot know the current schema. Deploy logs-service first.\n' \
        "$name" "$vcount" "${vhash:0:12}" "${scommit:0:9}"
    exit 1
fi
if [[ $shash == "$vhash" ]]; then
    printf 'scry-log-drift: %s: in sync with the stage log store (hash %s, %s entries).\n' "$name" "${vhash:0:12}" "$vcount"
    exit 0
fi
if (( vcount > scount )); then
    printf 'scry-log-drift: %s: its vendored scry-log is ahead of the stage log store (%s schema entries here, %s in the store at commit %s; hash %s vs %s). The store would drop the new fields. Deploy logs-service first.\n' \
        "$name" "$vcount" "$scount" "${scommit:0:9}" "${vhash:0:12}" "${shash:0:12}"
    exit 1
elif (( vcount < scount )); then
    warn "$name: the vendored scry-log is behind the stage log store ($vcount entries here, $scount in the store; hash ${vhash:0:12} vs ${shash:0:12}); harmless, re-run scry-management/lib/scry-log/sync.sh to catch up"
else
    warn "$name: same entry count ($vcount) but the schema hash differs (${vhash:0:12} vs ${shash:0:12}): a definition changed (a max, a pattern, an enum value swapped); not blocking"
fi
exit 0
