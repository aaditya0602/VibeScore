#!/bin/sh
# Container entrypoint for VibeScore on Render free tier (no persistent disk).
#
# When LITESTREAM_BUCKET is set, restores the SQLite file from S3-compatible
# object storage on boot (if it isn't already present locally) and then runs
# the app under `litestream replicate -exec`, which continuously streams
# writes to the replica and forwards signals (SIGTERM on spin-down/restart)
# to the app, doing a final sync before exiting.
#
# Without LITESTREAM_BUCKET, runs the app directly and warns that data will
# not survive a restart.
set -eu

: "${VIBESCORE_DATA_DIR:=/data}"
DB_PATH="${VIBESCORE_DATA_DIR}/vibescore.sqlite"
LITESTREAM_CONFIG="/app/litestream.yml"
APP_CMD="node backend/src/server.ts"

mkdir -p "${VIBESCORE_DATA_DIR}"

if [ -n "${LITESTREAM_BUCKET:-}" ]; then
  echo "docker-entrypoint: restoring ${DB_PATH} from replica (if needed)"
  litestream restore -config "${LITESTREAM_CONFIG}" -if-db-not-exists -if-replica-exists "${DB_PATH}"
  echo "docker-entrypoint: starting app under litestream replicate"
  exec litestream replicate -config "${LITESTREAM_CONFIG}" -exec "${APP_CMD}"
else
  echo "docker-entrypoint: WARNING - LITESTREAM_BUCKET is not set. Data in ${VIBESCORE_DATA_DIR} is EPHEMERAL and will be lost on restart or redeploy." >&2
  exec ${APP_CMD}
fi
