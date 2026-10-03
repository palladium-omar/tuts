#!/bin/sh
set -eu
for service in platform clients scheduling learning billing payments notifications; do
  upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
  password=$(printenv "${upper}_DB_PASSWORD")
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v name="$service" -v password="$password" <<'SQL'
CREATE ROLE :"name" WITH LOGIN PASSWORD :'password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE :"name" OWNER :"name";
REVOKE CONNECT ON DATABASE :"name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"name" TO :"name";
SQL
done
