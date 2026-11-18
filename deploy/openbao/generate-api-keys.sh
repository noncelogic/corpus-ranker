#!/bin/sh
# Generate the ranker's per-principal API keys straight into OpenBao at
# kv/corpus-ranker/api-keys (TECH-STACK §9), one property per principal, for
# the ExternalSecret `ranker-api-keys` (deploy/externalsecrets.yaml) to sync.
#
#   deploy/openbao/generate-api-keys.sh
#
# Run estate-side by an operator already logged in to OpenBao (`bao login`).
# Not applied by kustomize or CI.
#
# The principals are the ones CR-D1-DEC-PRINCIPALS authorises, fixed here
# rather than chosen on the command line (Rule:
# policies/placement-defaults.yaml#service_access): at the first deployment
# only the owner's principal, `joe`, gets a key, with full scope. The agent
# principals (CortexPlane, Hermes) get theirs in a later routine decision,
# each scoped to the operations its loop needs; Juno gets no new keys. The
# custody path is the product's own, kv/<product>/<purpose> (Rule:
# policies/placement-defaults.yaml#credentials). The estate External Secrets
# role reads it through deploy/openbao/external-secrets-corpus-ranker.hcl.
#
# The keys are never echoed: each is 256 bits from /dev/urandom, held only in
# this shell, and handed to `bao` as JSON on stdin (not argv, which `ps` would
# show); the CLI's own output is discarded. The write is check-and-set 0, so
# it refuses to overwrite an existing key set: rotating or adding a principal
# is a deliberate, separate operation. Holders read their key from OpenBao.
# tests/deploy/generate-api-keys.test.ts holds all of this.
set -eu

MOUNT=kv
SECRET_PATH=corpus-ranker/api-keys
PRINCIPALS="joe"

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  echo "the principals are fixed by CR-D1-DEC-PRINCIPALS:$PRINCIPALS; none may be named here" >&2
  exit 2
fi

new_key() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

json="{"
sep=""
count=0
for principal in $PRINCIPALS; do
  key=$(new_key)
  [ "${#key}" -eq 64 ] || { echo "$0: could not read 32 random bytes" >&2; exit 1; }
  json="$json$sep\"$principal\":\"$key\""
  sep=","
  count=$((count + 1))
done
json="$json}"
key=""

if ! printf '%s' "$json" | bao kv put -mount="$MOUNT" -cas=0 "$SECRET_PATH" - >/dev/null; then
  json=""
  echo "$0: writing $MOUNT/$SECRET_PATH failed; an existing key set is never overwritten" >&2
  exit 1
fi
json=""
echo "wrote $count API keys to $MOUNT/$SECRET_PATH for: $PRINCIPALS" >&2
