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

# Prints the top-level string field $1 of the JSON object on stdin, decoded
# (every JSON escape, \uXXXX as UTF-8). Exit status: 0 printed, 1 no such field,
# 2 the field is not a string (or holds U+0000), 3 not a JSON object.
json_field() {
  awk -v want="$1" '
    function ch() { return substr(s, i, 1) }
    function ws() { while (i <= n && index(" \t\r\n", ch()) > 0) i++ }
    function hex4(  j, d, v) {
      v = 0
      for (j = 0; j < 4; j++) {
        d = index("0123456789abcdef", tolower(substr(s, i + j, 1)))
        if (d == 0) { bad = 1; return 0 }
        v = v * 16 + d - 1
      }
      i += 4
      return v
    }
    function utf8(c) {
      if (c < 128) return sprintf("%c", c)
      if (c < 2048) return sprintf("%c%c", 192 + int(c / 64), 128 + c % 64)
      if (c < 65536) return sprintf("%c%c%c", 224 + int(c / 4096), 128 + int(c / 64) % 64, 128 + c % 64)
      return sprintf("%c%c%c%c", 240 + int(c / 262144), 128 + int(c / 4096) % 64, 128 + int(c / 64) % 64, 128 + c % 64)
    }
    # Decodes the string starting at s[i] (a quote), leaving i past its closing quote.
    function str(  out, c, e, lo) {
      out = ""; nul = 0; i++
      while (i <= n) {
        c = ch()
        if (c == "\"") { i++; return out }
        if (c != "\\") { out = out c; i++; continue }
        e = substr(s, i + 1, 1); i += 2
        if (e == "\"" || e == "\\" || e == "/") out = out e
        else if (e == "b") out = out "\b"
        else if (e == "f") out = out "\f"
        else if (e == "n") out = out "\n"
        else if (e == "r") out = out "\r"
        else if (e == "t") out = out "\t"
        else if (e == "u") {
          c = hex4()
          if (c >= 55296 && c < 56320 && substr(s, i, 2) == "\\u") {
            i += 2; lo = hex4()
            if (lo >= 56320 && lo < 57344) c = 65536 + (c - 55296) * 1024 + (lo - 56320)
            else { out = out utf8(c); c = lo }
          }
          if (c == 0) nul = 1
          out = out utf8(c)
        } else bad = 1
        if (bad) return ""
      }
      bad = 1
      return ""
    }
    # Skips the value starting at s[i].
    function skip(  c, d) {
      c = ch()
      if (c == "\"") { str(); return }
      if (c == "{" || c == "[") {
        d = 0
        while (i <= n && !bad) {
          c = ch()
          if (c == "\"") { str(); continue }
          if (c == "{" || c == "[") d++
          if (c == "}" || c == "]") d--
          i++
          if (d == 0) return
        }
        bad = 1
        return
      }
      while (i <= n && index(",}] \t\r\n", ch()) == 0) i++
    }
    { s = s $0 "\n" }
    END {
      n = length(s); i = 1; bad = 0
      ws(); if (ch() != "{") exit 3
      i++; ws()
      if (ch() == "}") exit 1
      for (;;) {
        ws(); if (ch() != "\"") exit 3
        k = str(); if (bad) exit 3
        ws(); if (ch() != ":") exit 3
        i++; ws()
        if (k == want) {
          if (ch() != "\"") exit 2
          v = str()
          if (bad) exit 3
          if (nul) exit 2
          printf "%s", v
          exit 0
        }
        skip(); if (bad) exit 3
        ws(); c = ch(); i++
        if (c == "}") exit 1
        if (c != ",") exit 3
      }
    }'
}

case "$step" in
credentials)
  bao_login
  # The key already exists (it holds the MinIO root credentials). Read it once:
  # failing to read it is an error, never a reason to mint credentials nobody
  # holds (a replaced password would lock out the API pods still holding the
  # published one). bao prints the record's data as JSON.
  record=$(bao kv get -mount="$BAO_KV_MOUNT" -format=json -field=data "$BAO_KV_PATH")
  case "$record" in
  "{"*"}") ;;
  *) echo "unreadable record at $BAO_KV_MOUNT/$BAO_KV_PATH" >&2; exit 1 ;;
  esac
  # Decodes the service fields with every value MinIO accepts (any JSON string),
  # sets $<var> to it and $<var>_status to json_field's status.
  get_field() {
    _v=$(printf '%s\n' "$record" | json_field "$2" && echo ".0" || echo ".$?")
    eval "$1"'_status=${_v##*.}'
    eval "$1"'=${_v%.*}'
  }
  get_field user service-user
  get_field password service-password
  if [ "$user_status" = 3 ] || [ "$password_status" = 3 ]; then
    echo "unreadable record at $BAO_KV_MOUNT/$BAO_KV_PATH" >&2
    exit 1
  fi
  if [ "$user_status" = 1 ] && [ "$password_status" = 1 ]; then
    echo "generating credentials for MinIO user $RANKER_SERVICE_USER"
    password=$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
    [ "${#password}" -eq 40 ] || { echo "password generation failed" >&2; exit 1; }
  else
    if [ "$user_status" != 0 ] || [ "$password_status" != 0 ] || [ "$user" != "$RANKER_SERVICE_USER" ] || [ -z "$password" ]; then
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
  # Kept byte for byte: $(...) alone would strip a published password's trailing newlines.
  password=$(cat "$work/service-password"; echo .)
  password=${password%.}
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
