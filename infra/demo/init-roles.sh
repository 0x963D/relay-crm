#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$(cat /run/relay-secrets/db/owner-password)" \
  -v app_password="$(cat /run/relay-secrets/db/app-password)" \
  -f /opt/relay/setup-roles.sql
