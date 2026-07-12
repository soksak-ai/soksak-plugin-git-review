#!/usr/bin/env bash
# Idempotency gate: the full review e2e must pass 3 times in a row. This pins the fake-idempotency
# defect (a prior run's merge consumes the target into main, and its comments accumulate — the next
# run must not be poisoned). Each run is self-contained; a poisoned fixture dies loud at the
# non-empty-diff precondition rather than false-passing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for i in 1 2 3; do
  echo "===================== consecutive run $i/3 ====================="
  node "$HERE/loop.mjs"
done
echo "3x CONSECUTIVE GREEN"
