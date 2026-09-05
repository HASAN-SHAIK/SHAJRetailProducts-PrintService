#!/usr/bin/env bash
set -euo pipefail
printf 'FAKE_SUMATRA_STARTED=true\n' >> "${FAKE_SUMATRA_LOG:?}"
sleep "${FAKE_SUMATRA_SLEEP_SECONDS:-30}"
printf 'FAKE_SUMATRA_FINISHED=true\n' >> "${FAKE_SUMATRA_LOG:?}"
