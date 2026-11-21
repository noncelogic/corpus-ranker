# Bounded retry for publish.yml's external build and push (CR-PUBLISH-RETRY;
# CRANK-219), sourced (`. .github/scripts/publish-retry.sh`). The credential
# preflight's calls are retried inside estate-registry-credential.mjs on the
# same terms.
#
#   publish_retry <operation> <deadline-seconds> <command> [args...]
#
# runs the command (a program or a shell function) up to
# PUBLISH_RETRY_ATTEMPTS times, waiting PUBLISH_RETRY_BACKOFF_MS before the
# second attempt and doubling the wait before each later one. No attempt
# starts once <deadline-seconds> have passed since the first; the step's own
# timeout-minutes is the hard bound on an attempt that hangs. Success
# returns 0; a failure that persists returns 1 after one line naming the
# operation and the attempts made. Bash builtins plus `sleep`.

PUBLISH_RETRY_ATTEMPTS=3

publish_retry() {
  local op="$1" deadline_s="$2" n=1 status wait_ms
  shift 2
  local backoff_ms="${PUBLISH_RETRY_BACKOFF_MS:-5000}"
  if ! [[ "$backoff_ms" =~ ^[0-9]+$ ]]; then backoff_ms=5000; fi
  local started=$SECONDS
  while :; do
    status=0
    "$@" || status=$?
    if [ "$status" = 0 ]; then return 0; fi
    if [ "$n" -ge "$PUBLISH_RETRY_ATTEMPTS" ]; then
      echo "publish-retry: ${op}: failed after ${n} attempts (last exit ${status})" >&2
      return 1
    fi
    wait_ms=$((backoff_ms * (1 << (n - 1))))
    if [ $((SECONDS - started + (wait_ms + 999) / 1000)) -ge "$deadline_s" ]; then
      echo "publish-retry: ${op}: failed after ${n} attempts (last exit ${status}; overall timeout ${deadline_s} s)" >&2
      return 1
    fi
    echo "publish-retry: ${op}: attempt ${n} of ${PUBLISH_RETRY_ATTEMPTS} failed (exit ${status}); retrying in ${wait_ms} ms" >&2
    sleep "$((wait_ms / 1000)).$(printf '%03d' $((wait_ms % 1000)))"
    n=$((n + 1))
  done
}
