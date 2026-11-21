#!/bin/bash
# Burn-in: prove named tests deterministic before they merge (policy
# tests-burn-in-before-merge: in-test retries forbidden, scope added or changed
# tests only, a failure blocks the merge). Run by .github/workflows/burn-in.yml,
# which the conductor dispatches on a pull request head.
#
# Inputs come from the environment only, never from interpolated script text:
#   TESTS   repository test file paths, separated by spaces or newlines; each
#           must be an existing tests/**/*.test.ts file
#   REPEAT  how many times to run each file, a positive integer
#
# Every input is checked before anything runs. Then each file is run REPEAT
# times, one run at a time, with `node --test --test-concurrency=1 <file>`
# (package.json's test command, one file), with no retries; the first failing
# run stops the burn-in, naming the file and the run number.
set -euo pipefail

fail() {
  echo "burn-in: $*" >&2
  exit 1
}

repeat="${REPEAT-}"
[[ "${repeat}" =~ ^[1-9][0-9]{0,5}$ ]] || fail "repeat must be a positive integer, got '${repeat}'"

# Split on whitespace only: no globbing, no other expansion of the input.
set -f
read -r -d '' -a files <<<"${TESTS-}" || true
set +f
[ "${#files[@]}" -gt 0 ] || fail "no test files named (TESTS is empty)"

for file in "${files[@]}"; do
  if ! [[ "${file}" =~ ^tests/([A-Za-z0-9_][A-Za-z0-9._-]*/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.test\.ts$ ]] ||
    [[ "${file}" =~ (^|/)\.\.?(/|$) ]]; then
    fail "not a tests/**/*.test.ts file: ${file}"
  fi
  [ -f "${file}" ] || fail "no such test file: ${file}"
done

for file in "${files[@]}"; do
  for ((run = 1; run <= repeat; run++)); do
    echo "burn-in: ${file}: run ${run} of ${repeat}"
    if ! node --test --test-concurrency=1 "${file}"; then
      fail "${file} failed on run ${run} of ${repeat}"
    fi
    echo "burn-in: ${file}: run ${run} of ${repeat} passed"
  done
done
echo "burn-in: ${#files[@]} file(s) passed ${repeat} run(s) each"
