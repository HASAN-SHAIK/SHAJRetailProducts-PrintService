#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${DISCOVERY_MARKER:-}" ]]; then
  printf 'started\n' > "$DISCOVERY_MARKER"
fi

sleep 60
