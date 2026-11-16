#!/bin/sh
# Provisions the ranker's bucket on the estate MinIO (deploy/minio-provision-job.yaml),
# one step per container of the Job, sharing $PROVISION_WORK_DIR (an emptyDir):
#
#   credentials  (OpenBao image) the ranker service user's credentials: the ones
#                already published at $BAO_KV_MOUNT/$BAO_KV_PATH, or freshly
#                generated on the first run.
#   bucket       (MinIO image, root credentials) creates $RANKER_BUCKET, refuses
#                anonymous access, and makes $RANKER_SERVICE_USER, holding the
#                writer policy, the bucket's only writer (CRANK-57).
#   publish      (OpenBao image) patches the user's credentials into
#                $BAO_KV_MOUNT/$BAO_KV_PATH as service-user / service-password,
#                next to the estate's root credentials, for the ranker-minio-service
#                ExternalSecret to sync.
#
# Every step is idempotent, so the Job re-runs on every Argo sync. OpenBao is
# reached with $BAO_TOKEN when set, otherwise by logging in with the pod's
# service account token at auth/$BAO_K8S_AUTH_MOUNT, role $BAO_K8S_AUTH_ROLE.
set -eu

step=${1:?usage: provision.sh credentials|bucket|publish}
work=${PROVISION_WORK_DIR:-/work}
umask 077

bao_login() {
  if [ -z "${BAO_TOKEN:-}" ]; then
    BAO_TOKEN=$(bao write -field=token "auth/${BAO_K8S_AUTH_MOUNT:-kubernetes}/login" \
      role="$BAO_K8S_AUTH_ROLE" jwt=@/var/run/secrets/kubernetes.io/serviceaccount/token)
    export BAO_TOKEN
  fi
}

case "$step" in
credentials)
  bao_login
  # The key already exists (it holds the MinIO root credentials). Read it once:
  # failing to read it is an error, never a reason to mint credentials nobody
  # holds (a replaced password would lock out the API pods still holding the
  # published one). bao prints the record's data as JSON, one field per line.
  record=$(bao kv get -mount="$BAO_KV_MOUNT" -format=json -field=data "$BAO_KV_PATH")
  case "$record" in
  "{"*"}") ;;
  *) echo "unreadable record at $BAO_KV_MOUNT/$BAO_KV_PATH" >&2; exit 1 ;;
  esac
  has_field() { printf '%s\n' "$record" | grep -q "^  \"$1\":"; }
  field() { printf '%s\n' "$record" | sed -n "s/^  \"$1\": \"\([A-Za-z0-9._-]*\)\",\{0,1\}\$/\1/p"; }
  if ! has_field service-user && ! has_field service-password; then
    echo "generating credentials for MinIO user $RANKER_SERVICE_USER"
    password=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
    [ "${#password}" -eq 40 ] || { echo "password generation failed" >&2; exit 1; }
  else
    user=$(field service-user)
    password=$(field service-password)
    if [ "$user" != "$RANKER_SERVICE_USER" ] || [ -z "$password" ]; then
      echo "$BAO_KV_MOUNT/$BAO_KV_PATH holds service credentials that are not a usable" \
        "password for MinIO user $RANKER_SERVICE_USER; refusing to replace them" >&2
      exit 1
    fi
    echo "reusing the published credentials of MinIO user $RANKER_SERVICE_USER"
  fi
  printf '%s' "$RANKER_SERVICE_USER" >"$work/service-user"
  printf '%s' "$password" >"$work/service-password"
  ;;

bucket)
  user=$(cat "$work/service-user")
  password=$(cat "$work/service-password")
  waited=0
  until mc alias set ranker "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "$waited" -gt "${MINIO_WAIT_SECONDS:-300}" ]; then
      echo "MinIO at $MINIO_ENDPOINT did not accept the root credentials" >&2
      exit 1
    fi
    sleep 2
  done
  mc mb --ignore-existing "ranker/$RANKER_BUCKET"
  mc anonymous set none "ranker/$RANKER_BUCKET"
  mc admin policy create ranker "$RANKER_WRITER_POLICY" "$RANKER_WRITER_POLICY_FILE"
  # Creates the user, or resets its secret to the published one.
  mc admin user add ranker "$user" "$password" >/dev/null
  if ! mc admin policy entities ranker --user "$user" | grep -qx "[[:space:]]*$RANKER_WRITER_POLICY"; then
    mc admin policy attach ranker "$RANKER_WRITER_POLICY" --user "$RANKER_SERVICE_USER"
  fi
  echo "bucket $RANKER_BUCKET: writer $user"
  ;;

publish)
  bao_login
  bao kv patch -mount="$BAO_KV_MOUNT" "$BAO_KV_PATH" service-user=@"$work/service-user" service-password=@"$work/service-password" >/dev/null
  echo "published MinIO user $(cat "$work/service-user") to $BAO_KV_MOUNT/$BAO_KV_PATH"
  ;;

*)
  echo "unknown step: $step" >&2
  exit 2
  ;;
esac
