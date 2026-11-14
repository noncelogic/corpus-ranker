#!/bin/sh
# Applies the merged schema migrations (db/migrations/NNNN_name.sql) in
# version order, each in one transaction, skipping versions already recorded
# in schema_migrations. Run by the ranker-db-migrate PreSync Job, logged in as
# the migrator (connection from the standard PG* environment variables).
#
# Usage: migrate.sh MIGRATIONS_DIR
set -eu

dir="${1:?usage: migrate.sh MIGRATIONS_DIR}"
q() { psql -X -q -v ON_ERROR_STOP=1 -tA "$@"; }

# The cluster may still be coming up when the hook starts.
tries=0
until q -c 'select 1' >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge "${MIGRATE_WAIT_SECONDS:-300}" ]; then
    echo "migrate: database not reachable" >&2
    q -c 'select 1' >/dev/null
  fi
  sleep 1
done

# Only the database owner (never a superuser) applies migrations, so that it
# alone owns what they create.
who=$(q -c "select current_user || ' ' || r.rolsuper || ' ' || (d.datdba = r.oid)
            from pg_roles r, pg_database d
            where r.rolname = current_user and d.datname = current_database()")
case "$who" in
  *" false true") ;;
  *) echo "migrate: refusing to run as '$who' (must be the non-superuser database owner)" >&2; exit 1 ;;
esac

found=0
for f in "$dir"/[0-9][0-9][0-9][0-9]_*.sql; do
  [ -e "$f" ] || continue
  found=1
  file=$(basename "$f")
  version=$(expr "$file" : '0*\([0-9][0-9]*\)_')
  if [ "$(q -c "select to_regclass('public.schema_migrations') is not null")" = "t" ] &&
     [ "$(q -c "select count(*) from schema_migrations where version = $version")" != "0" ]; then
    continue
  fi
  q --single-transaction -f "$f"
  echo "migrate: applied $file"
done
[ "$found" = 1 ] || { echo "migrate: no migrations in $dir" >&2; exit 1; }
echo "migrate: schema at version $(q -c 'select max(version) from schema_migrations')"
