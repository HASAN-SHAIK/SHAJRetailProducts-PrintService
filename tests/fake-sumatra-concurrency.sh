#!/usr/bin/env bash
set -euo pipefail

: "${PRINTSERVICE_SPOOL_DIR:?PRINTSERVICE_SPOOL_DIR must be set}"
mkdir -p "$PRINTSERVICE_SPOOL_DIR"

input="${!#}"
id="$$"
touch "$PRINTSERVICE_SPOOL_DIR/started-$id"
sleep 1
cp "$input" "$PRINTSERVICE_SPOOL_DIR/spool-$id.txt"
