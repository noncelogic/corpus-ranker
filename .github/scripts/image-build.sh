# The ranker image's one build definition, sourced (`. .github/scripts/image-build.sh`)
# by publish.yml's `image` job, which pushes the result, and by ci.yml's
# `image` job (DRY_RUN_OF: image), which builds the same thing on every pull
# request without any credential. Dockerfile, context, platform, build
# arguments and metadata labels live here only, so the pull-request dry run
# cannot drift from what main publishes. Bash builtins plus `docker` only.
#
# Needs GITHUB_REPOSITORY and GITHUB_SHA (set by the Actions runner).

IMAGE_DOCKERFILE="Dockerfile"
IMAGE_CONTEXT="."
IMAGE_PLATFORM="linux/amd64"
# --build-arg values (NAME=value). The Dockerfile declares no ARG today.
IMAGE_BUILD_ARGS=()

# The metadata labels publish pushes, one "key=value" per line, in order.
image_labels() {
  echo "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY}"
  echo "org.opencontainers.image.revision=${GITHUB_SHA}"
}

# Refuse to label an image with an empty source or revision.
image_require_env() {
  : "${GITHUB_REPOSITORY:?the image build needs GITHUB_REPOSITORY}" "${GITHUB_SHA:?the image build needs GITHUB_SHA}"
}

# image_build <tag>: build the image from the definition above.
image_build() {
  local tag="$1" label arg
  image_require_env
  local argv=(build -f "${IMAGE_DOCKERFILE}" --platform "${IMAGE_PLATFORM}")
  for arg in "${IMAGE_BUILD_ARGS[@]}"; do argv+=(--build-arg "$arg"); done
  while IFS= read -r label; do argv+=(--label "$label"); done < <(image_labels)
  argv+=(-t "$tag" "${IMAGE_CONTEXT}")
  docker "${argv[@]}"
}

# image_verify <tag>: fail unless the built image's manifest platform and
# metadata labels are exactly what publish pushes.
image_verify() {
  local tag="$1" inspected platform line want found failed=0
  image_require_env
  inspected="$(docker image inspect --format '{{.Os}}/{{.Architecture}}
{{range $k, $v := .Config.Labels}}{{$k}}={{$v}}
{{end}}' "$tag")"
  platform="${inspected%%$'\n'*}"
  if [ "$platform" != "${IMAGE_PLATFORM}" ]; then
    echo "image ${tag}: platform ${platform:-<none>}, publish pushes ${IMAGE_PLATFORM}" >&2
    failed=1
  fi
  while IFS= read -r want; do
    found=0
    while IFS= read -r line; do
      if [ "$line" = "$want" ]; then found=1; fi
    done <<< "$inspected"
    if [ "$found" != 1 ]; then
      echo "image ${tag}: label ${want%%=*} is not ${want#*=} as publish pushes it" >&2
      failed=1
    fi
  done < <(image_labels)
  if [ "$failed" != 0 ]; then return 1; fi
  echo "image ${tag}: ${IMAGE_PLATFORM} with the labels publish pushes"
}
