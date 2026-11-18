#!/bin/sh
# Generates the ranker's per-principal API keys straight into OpenBao at
# $BAO_KV_MOUNT/$BAO_KV_PATH (kv/corpus-ranker/api-keys, TECH-STACK §9), one
# property per principal, for the ExternalSecret `ranker-api-keys`
# (deploy/externalsecrets.yaml) to sync. Run by the Argo CD Sync hook Job
# ranker-api-keys-generate (deploy/api-keys-job.yaml) on every sync; never by hand.
#
# The principals are the ones CR-D1-DEC-PRINCIPALS authorises, fixed here
# rather than chosen at run time (Rule:
# policies/placement-defaults.yaml#service_access): at the first deployment
# only the owner's principal, `joe`, gets a key, with full scope. The agent
# principals (CortexPlane, Hermes) get theirs in a later routine decision,
# each scoped to the operations its loop needs; Juno gets no new keys.
#
# Idempotent: the write is check-and-set 0, which OpenBao (and the role's
# policy, create and read only) accepts only while the path is empty. When a
# key set is already there and holds every authorised principal, it is kept
# untouched and the step succeeds; one lacking a principal fails the sync
# (adding a principal or rotating is a deliberate, separate operation).
#
# The keys are never printed: each is 256 bits from /dev/urandom, held only in
# this shell, and handed to `bao` as JSON on stdin (not argv, which `ps` would
# show); the CLI's output is discarded, and an existing key is only checked for
# presence, its value sent to /dev/null. Holders read their key from OpenBao.
#
# OpenBao is reached with $BAO_TOKEN when set, otherwise by logging in with the
# pod's service account token at auth/$BAO_K8S_AUTH_MOUNT, role
# $BAO_K8S_AUTH_ROLE (corpus-ranker-api-keys, devops/openbao/).
# tests/deploy/api-keys-job.test.ts holds all of this.
set -eu

PRINCIPALS="joe"

if [ "$#" -ne 0 ]; then
  echo "usage: $0" >&2
  echo "the principals are fixed by CR-D1-DEC-PRINCIPALS: $PRINCIPALS; none may be named here" >&2
  exit 2
fi

mount=${BAO_KV_MOUNT:?}
path=${BAO_KV_PATH:?}

if [ -z "${BAO_TOKEN:-}" ]; then
  BAO_TOKEN=$(bao write -field=token "auth/${BAO_K8S_AUTH_MOUNT:-kubernetes}/login" \
    role="$BAO_K8S_AUTH_ROLE" jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token)
  export BAO_TOKEN
fi

new_key() {
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
}

json="{"
sep=""
count=0
for principal in $PRINCIPALS; do
  key=$(new_key)
  [ "${#key}" -eq 64 ] || { echo "could not read 32 random bytes" >&2; exit 1; }
  json="$json$sep\"$principal\":\"$key\""
  sep=","
  count=$((count + 1))
done
json="$json}"
key=""

# bao's error output names the path and the reason, never the data it was handed.
if err=$(printf '%s' "$json" | bao kv put -mount="$mount" -cas=0 "$path" - 2>&1 >/dev/null); then
  json=""
  echo "wrote $count API keys to $mount/$path for: $PRINCIPALS"
  exit 0
fi
json=""

# The path already holds a key set (or the write failed): keep a set that has
# every authorised principal, and fail on anything else.
missing=""
for principal in $PRINCIPALS; do
  if ! bao kv get -mount="$mount" -field="$principal" "$path" >/dev/null 2>&1; then
    missing="$missing $principal"
  fi
done
if [ -n "$missing" ]; then
  echo "writing $mount/$path failed and no key set there holds every authorised principal (missing:$missing);" \
    "an existing key set is never overwritten" >&2
  echo "$err" >&2
  exit 1
fi
echo "kept the existing API key set at $mount/$path for: $PRINCIPALS"
