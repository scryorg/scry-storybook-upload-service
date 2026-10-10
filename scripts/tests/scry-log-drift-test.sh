#!/usr/bin/env bash
# Tests for scripts/scry-log-drift.sh (log-core-hardening plan rows 32-33): ahead fails with "deploy logs-service first",
# network error passes with a warning, plus the in-sync / behind / changed-definition / no-hash cases.
# The stage Worker is faked with a file:// URL (curl reads <dir>/healthz), so no network or server is needed.
# Run from the repo root (or anywhere): scripts/tests/scry-log-drift-test.sh
set -uo pipefail
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(cd -- "$here/../.." && pwd)
drift=$root/scripts/scry-log-drift.sh
dir=${SCRY_LOG_DIR:-$root/src/lib/scry-log}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
fail=0; n=0
export SCRY_LOG_TS_DIR=${SCRY_LOG_TS_DIR:-$root}
export SCRY_LOG_DRIFT_NAME=test-repo

vjson=$(node "$root/scripts/scry-log-schema.mjs" "$dir") || { echo "FAIL: cannot compute the vendored schema"; exit 1; }
vhash=$(jq -r .hash <<< "$vjson"); vcount=$(jq -r .entries <<< "$vjson")

# run <name> <expected rc> <expected output substring> <healthz json | "-" for none> [dir]
run() {
    local name=$1 want_rc=$2 want_out=$3 body=$4 d=${5:-$dir} out rc url
    n=$((n + 1)); mkdir -p "$tmp/s$n"
    if [[ $body == - ]]; then url=http://127.0.0.1:9; else printf '%s' "$body" > "$tmp/s$n/healthz"; url=file://$tmp/s$n; fi
    out=$(SCRY_LOGS_STAGE_URL=$url "$drift" "$d" 2>&1); rc=$?
    if [[ $rc != "$want_rc" || $out != *"$want_out"* ]]; then
        echo "FAIL [$n] $name: rc=$rc (want $want_rc), output: $out"; fail=1
    else echo "ok   [$n] $name"; fi
}

hz() { printf '{"ok":true,"service":"scry-logs","env":"staging","commit":"%s","schema":{"version":1,"hash":"%s"},"entries":%s}' "$1" "$2" "$3"; }

run "in sync passes" 0 "in sync" "$(hz 1111111111 "$vhash" "$vcount")"
run "vendored ahead (store has fewer entries) fails" 1 "Deploy logs-service first" "$(hz 1111111111 deadbeef $((vcount - 3)))"
run "ahead names the counts" 1 "$vcount schema entries here, $((vcount - 3)) in the store" "$(hz 1111111111 deadbeef $((vcount - 3)))"
run "vendored behind warns and passes" 0 "behind the stage log store" "$(hz 1111111111 deadbeef $((vcount + 2)))"
run "same count, different hash warns and passes" 0 "a definition changed" "$(hz 1111111111 deadbeef "$vcount")"
run "store without a schema hash (predates S2) fails" 1 "Deploy logs-service first" '{"ok":true,"service":"scry-logs","env":"staging","commit":"91fc9e0111d03641821f53136b754b28234c3a3c"}'
run "network error passes with a warning" 0 "unreachable or unreadable" -
run "garbage body passes with a warning" 0 "unreachable or unreadable" 'not json at all'
run "missing vendored dir is a usage error" 2 "cannot read the vendored scry-log" "$(hz 1111111111 "$vhash" "$vcount")" "$tmp/nope"

# A vendored copy that gained an entry the store lacks: add one allowed key to a temp copy and compare against the
# store as it was before (the real hash and count of the unmodified copy).
cp -r "$dir" "$tmp/ahead-copy"
sed -i "s/\(ALLOWED_KEYS[^=]*=.*'attrs'\)\]/\1, 'zz_new_field']/" "$tmp/ahead-copy/schema.ts"
if ! grep -q zz_new_field "$tmp/ahead-copy/schema.ts"; then echo "FAIL: could not mutate the temp copy"; fail=1; fi
run "copy with a new allowed key is ahead of the store that has the old schema" 1 "Deploy logs-service first" "$(hz 1111111111 "$vhash" "$vcount")" "$tmp/ahead-copy"
[[ $fail == 0 ]] && echo "all $n scry-log-drift tests passed"
exit "$fail"
