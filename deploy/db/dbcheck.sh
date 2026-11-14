#!/bin/sh
# Logs in to the ranker database once with each generated role secret and
# fails if any secret is missing or any login is refused. Run by the
# ranker-db-check PostSync-hook Job (deploy/dbcheck-job.yaml), so a failure
# fails the Argo sync. Connection target from the standard PG* environment
# variables (PGHOST, PGPORT, PGDATABASE, PGSSLMODE); credentials from
# $DBCHECK_SECRETS_DIR/<secret>/{username,password}, the Secrets mounted as
# volumes.
#
# Usage: dbcheck.sh SECRET_NAME...
set -u

[ "$#" -gt 0 ] || { echo "usage: dbcheck.sh SECRET_NAME..." >&2; exit 2; }
dir="${DBCHECK_SECRETS_DIR:-/secrets}"
wait_seconds="${DBCHECK_WAIT_SECONDS:-60}"

failed=0
for secret in "$@"; do
  if [ ! -s "$dir/$secret/username" ] || [ ! -s "$dir/$secret/password" ]; then
    echo "dbcheck: FAIL $secret: secret missing (no username/password in $dir/$secret)" >&2
    failed=1
    continue
  fi
  user=$(cat "$dir/$secret/username")
  # A role's password may still be propagating (CNPG reloads managed-role
  # secrets), so retry for up to DBCHECK_WAIT_SECONDS before failing.
  tries=0
  while :; do
    if out=$(PGUSER="$user" PGPASSFILE=/dev/null PGPASSWORD=$(cat "$dir/$secret/password") \
        psql -X -q -w -v ON_ERROR_STOP=1 -tA -c 'select current_user' 2>&1) && [ "$out" = "$user" ]; then
      echo "dbcheck: ok $secret: logged in as $user"
      break
    fi
    tries=$((tries + 1))
    if [ "$tries" -gt "$wait_seconds" ]; then
      echo "dbcheck: FAIL $secret: login as $user refused: $out" >&2
      failed=1
      break
    fi
    sleep 1
  done
done

[ "$failed" = 0 ] || { echo "dbcheck: one or more ranker role logins failed" >&2; exit 1; }
echo "dbcheck: every ranker role logged in"
