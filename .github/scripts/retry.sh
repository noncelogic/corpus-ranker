#!/usr/bin/env bash
# Bounded wait for an external service (policy main-stays-green: a main-only
# job tolerates the external delays it depends on, e.g. a Docker Hub 429 while
# resolving the base image, or a registry hiccup during login or push).
#
#   retry.sh <command> [args...]   run the command, retrying on failure
#   retry.sh --plan                print the waits (seconds) between attempts
#
# RETRY_ATTEMPTS (default 4, at most 6) caps the attempts; RETRY_DELAY_SECONDS
# (default 15) is the first wait, doubled before each later attempt. With the
# defaults the command runs at most 4 times with 15+30+60 = 105s of waiting,
# well inside the publish job's timeout. At the cap the script says so on
# stderr and exits with the last attempt's status: it never waits unboundedly
# and never turns a failure into a success.
set -u

attempts="${RETRY_ATTEMPTS:-4}"
delay="${RETRY_DELAY_SECONDS:-15}"
case "$attempts" in '' | *[!0-9]*) echo "retry.sh: RETRY_ATTEMPTS must be a whole number" >&2; exit 2 ;; esac
case "$delay" in '' | *[!0-9]*) echo "retry.sh: RETRY_DELAY_SECONDS must be a whole number" >&2; exit 2 ;; esac
if [ "$attempts" -lt 1 ] || [ "$attempts" -gt 6 ]; then
  echo "retry.sh: RETRY_ATTEMPTS must be between 1 and 6, got ${attempts}" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  echo "usage: retry.sh <command> [args...] | retry.sh --plan" >&2
  exit 2
fi

if [ "$1" = "--plan" ]; then
  waits=()
  wait_s="$delay"
  for ((i = 1; i < attempts; i++)); do
    waits+=("$wait_s")
    wait_s=$((wait_s * 2))
  done
  echo "${waits[*]}"
  exit 0
fi

wait_s="$delay"
for ((attempt = 1; ; attempt++)); do
  "$@"
  status=$?
  [ "$status" -eq 0 ] && exit 0
  if [ "$attempt" -ge "$attempts" ]; then
    echo "retry.sh: gave up after ${attempt} attempts (last exit ${status}): $1" >&2
    exit "$status"
  fi
  echo "retry.sh: attempt ${attempt}/${attempts} of $1 exited ${status}; retrying in ${wait_s}s" >&2
  sleep "$wait_s"
  wait_s=$((wait_s * 2))
done
