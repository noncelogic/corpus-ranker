#!/bin/sh
# Store the ranker's own pull-only GHCR credential in OpenBao at
# kv/corpus-ranker/ghcr-pull, for the ExternalSecret `ranker-ghcr-pull`
# (deploy/externalsecrets.yaml) to sync, and check it is there by name only.
#
#   deploy/openbao/store-ghcr-pull.sh store <github-user>  < token
#   deploy/openbao/store-ghcr-pull.sh check
#
# Run estate-side by the DevOps route, already logged in to OpenBao
# (`bao login`). The token is a GitHub token scoped to read:packages only,
# the ranker's own (registry-credential-per-product; Rule:
# policies/placement-defaults.yaml#credentials), never shared with another
# product. Not applied by kustomize or CI.
#
# The token is never echoed: it is read from stdin (not argv, which `ps`
# would show), handed to `bao` as JSON on stdin, and the CLI's output is
# discarded. The write is check-and-set 0, so an existing credential is never
# overwritten: rotation is a deliberate, separate operation. Presence is
# verified with `bao kv metadata get` -- the path's name and versions, never
# its value.
set -eu

MOUNT=kv
SECRET_PATH=corpus-ranker/ghcr-pull

usage() {
  echo "usage: $0 store <github-user> < token" >&2
  echo "       $0 check" >&2
  exit 2
}

check() {
  if ! bao kv metadata get -mount="$MOUNT" "$SECRET_PATH" >/dev/null 2>&1; then
    echo "$0: absent: $MOUNT/$SECRET_PATH" >&2
    exit 1
  fi
  echo "present: $MOUNT/$SECRET_PATH" >&2
}

[ "$#" -ge 1 ] || usage
case "$1" in
  check)
    [ "$#" -eq 1 ] || usage
    check
    ;;
  store)
    [ "$#" -eq 2 ] || usage
    user=$2
    # GitHub logins: alphanumerics and single hyphens.
    case "$user" in
      "" | -* | *- | *--* | *[!A-Za-z0-9-]*) usage ;;
    esac
    token=""
    IFS= read -r token || [ -n "$token" ] || { echo "$0: no token on stdin" >&2; exit 2; }
    case "$token" in
      "" | *[!A-Za-z0-9_]*) token=""; echo "$0: the token on stdin is not a GitHub token" >&2; exit 2 ;;
    esac
    if ! printf '{"username":"%s","token":"%s"}' "$user" "$token" | bao kv put -mount="$MOUNT" -cas=0 "$SECRET_PATH" - >/dev/null 2>&1; then
      token=""
      echo "$0: writing $MOUNT/$SECRET_PATH failed; an existing credential is never overwritten" >&2
      exit 1
    fi
    token=""
    check
    ;;
  *) usage ;;
esac
