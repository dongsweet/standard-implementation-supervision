#!/bin/sh
set -eu

echo "Applying database migrations..."
npx node-pg-migrate -m db/migrations up
exec npm run start
