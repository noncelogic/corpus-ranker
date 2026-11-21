# A stand-in `docker` for the workflow tests that keeps image state the way
# the daemon does, for the two subcommands the image build definition
# (.github/scripts/image-build.sh) uses. Sourced by a test's stand-in, with
# the docker arguments as "$@"; state lives under the directory $DOCKER_STATE.
#
#   - `docker build ... [--platform P] [--label k=v]... -t TAG CONTEXT`
#     records TAG's platform (default linux/amd64, the runner's) and labels;
#   - `docker image inspect --format FMT TAG` prints, for the format
#     image_verify passes, what the daemon would: `<os>/<arch>`, then one
#     `key=value` line per label; an unknown TAG is "No such image".
#
# Faults a test injects through the environment, standing in for a build
# that drifts from what publish pushes:
#   FAKE_DOCKER_PLATFORM=os/arch   the image is built for this platform
#   FAKE_DOCKER_DROP_LABEL=key     the image lacks this label
#   FAKE_DOCKER_SET_LABEL=key=val  the image carries this label value instead
#   FAKE_DOCKER_FAIL_BUILD=N       the first N builds fail (a transient fault)
#   FAKE_DOCKER_FAIL_PUSH=N        the first N pushes fail (a transient fault)
#
# Bash builtins only, so it also runs where PATH holds nothing but stand-ins.

# fake_transient <subcommand> <N>: fail the first N calls of <subcommand>.
fake_transient() {
  local count_file="${DOCKER_STATE}/fail-count-$1" count=0
  if [ -f "$count_file" ]; then read -r count < "$count_file"; fi
  count=$((count + 1))
  echo "$count" > "$count_file"
  if [ "$count" -le "${2:-0}" ]; then
    echo "fake docker: $1 failed (transient fault ${count} of $2)" >&2
    exit 1
  fi
}

fake_image_file() { local t="${1//\//_}"; echo "${DOCKER_STATE}/${t//:/_}"; }

case "$1" in
  build)
    fake_transient build "${FAKE_DOCKER_FAIL_BUILD:-0}"
    shift
    fake_platform=linux/amd64; fake_tag=""; fake_labels=()
    while [ $# -gt 1 ]; do
      case "$1" in
        --platform) fake_platform="$2"; shift 2 ;;
        --label) fake_labels+=("$2"); shift 2 ;;
        -t|--tag) fake_tag="$2"; shift 2 ;;
        -f|--file|--build-arg) shift 2 ;;
        *) echo "fake docker: unexpected build option $1" >&2; exit 2 ;;
      esac
    done
    if [ -z "$fake_tag" ]; then echo "fake docker: build without -t" >&2; exit 2; fi
    if [ -n "${FAKE_DOCKER_PLATFORM:-}" ]; then fake_platform="$FAKE_DOCKER_PLATFORM"; fi
    {
      echo "$fake_platform"
      for l in "${fake_labels[@]}"; do
        if [ -n "${FAKE_DOCKER_DROP_LABEL:-}" ] && [ "${l%%=*}" = "$FAKE_DOCKER_DROP_LABEL" ]; then continue; fi
        if [ -n "${FAKE_DOCKER_SET_LABEL:-}" ] && [ "${l%%=*}" = "${FAKE_DOCKER_SET_LABEL%%=*}" ]; then l="$FAKE_DOCKER_SET_LABEL"; fi
        echo "$l"
      done
    } > "$(fake_image_file "$fake_tag")"
    ;;
  push)
    fake_transient push "${FAKE_DOCKER_FAIL_PUSH:-0}"
    ;;
  image)
    if [ "$2" != inspect ] || [ "$3" != --format ]; then echo "fake docker: unexpected $*" >&2; exit 2; fi
    fake_tag="${*: -1}"
    fake_file="$(fake_image_file "$fake_tag")"
    if [ ! -f "$fake_file" ]; then echo "Error: No such image: $fake_tag" >&2; exit 1; fi
    while IFS= read -r line; do echo "$line"; done < "$fake_file"
    ;;
esac
