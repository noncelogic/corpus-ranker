#!/bin/sh
# Generate the ranker's per-principal API keys straight into OpenBao at
# kv/corpus-ranker/api-keys (TECH-STACK §9), one property per principal, for
# the ExternalSecret `ranker-api-keys` (deploy/externalsecrets.yaml) to sync.
#
#   deploy/openbao/generate-api-keys.sh <principal>...
#
# Run estate-side by an operator already logged in to OpenBao (`bao login`),
# with the principals CR-D1-DEC-PRINCIPALS grants, e.g. `juno hermes joe`.
# Not applied by kustomize or CI.
#
# The keys are never echoed: each is 256 bits from /dev/urandom, held only in
# this shell, and handed to `bao` as JSON on stdin (not argv, which `ps` would
# show); the CLI's own output is discarded. The write is check-and-set 0, so
# it refuses to overwrite an existing key set: rotating or adding a principal
# is a deliberate, separate operation. Holders read their key from OpenBao.
set -eu

MOUNT=kv
SECRET_PATH=corpus-ranker/api-keys

usage() {
  echo "usage: $0 <principal>..." >&2
  echo "principals are lowercase names ([a-z][a-z0-9-]*), each given once" >&2
  exit 2
}

[ "$#" -ge 1 ] || usage
seen=" "
for principal in "$@"; do
  case "$principal" in
    [a-z]*) ;;
    *) usage ;;
  esac
  case "$principal" in
    *[!a-z0-9-]*) usage ;;
  esac
  case "$seen" in
    *" $principal "*) usage ;;
  esac
  seen="$seen$principal "
done

new_key() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

json="{"
sep=""
for principal in "$@"; do
  key=$(new_key)
  [ "${#key}" -eq 64 ] || { echo "$0: could not read 32 random bytes" >&2; exit 1; }
  json="$json$sep\"$principal\":\"$key\""
  sep=","
done
json="$json}"
key=""

if ! printf '%s' "$json" | bao kv put -mount="$MOUNT" -cas=0 "$SECRET_PATH" - >/dev/null; then
  json=""
  echo "$0: writing $MOUNT/$SECRET_PATH failed; an existing key set is never overwritten" >&2
  exit 1
fi
json=""
echo "wrote $# API keys to $MOUNT/$SECRET_PATH for:$seen" >&2
