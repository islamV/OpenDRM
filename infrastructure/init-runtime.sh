#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=runtime_pass="$RUNTIME_PASSWORD" <<'SQL'
CREATE ROLE shield_api LOGIN PASSWORD :'runtime_pass';
GRANT USAGE ON SCHEMA public TO shield_api;
SQL
