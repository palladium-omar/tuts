#!/bin/sh
set -eu
for service in platform clients scheduling learning billing payments notifications integrations planning reporting; do
  upper=$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')
  password=$(printenv "${upper}_DB_PASSWORD")
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -v name="$service" -v password="$password" <<'SQL'
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', :'name', :'password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'name') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'name', :'name')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=:'name') \gexec
REVOKE CONNECT ON DATABASE :"name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"name" TO :"name";
SQL
done
