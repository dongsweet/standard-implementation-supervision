#!/bin/sh
set -eu

echo "Applying database migrations..."
npx node-pg-migrate -m db/migrations up
if [ "$#" -gt 0 ]; then
  exec "$@"
fi
exec npm run start
