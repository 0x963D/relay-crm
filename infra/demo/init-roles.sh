#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_password="$(cat /run/relay-secrets/owner-password)" \
  -v app_password="$(cat /run/relay-secrets/app-password)" \
  -f /opt/relay/setup-roles.sql
