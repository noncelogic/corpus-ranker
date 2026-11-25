#!/bin/bash
# The deploy lane's one script (.github/workflows/deploy.yml; owner INTENTS
# I67, DELIVERY-GUARANTEE-CHECK): deploy a batch's candidate, run a suite
# against it, tear it down. Run from the root of a checkout of the candidate.
#
#   deploy-candidate.sh up              build and deploy the candidate, wait for /readyz
#   deploy-candidate.sh suite <script>  run `npm run <script>` (test:e2e or test:journeys)
#                                       against the deployed service
#   deploy-candidate.sh down            remove the deployment (always; a no-op when
#                                       nothing was deployed)
#
# Inputs come from the environment only, never from interpolated script text:
#   CANDIDATE             the full 40-character commit SHA to deploy; must be
#                         the checked-out HEAD
#   BATCH                 the deploy batch id, 1-64 of [A-Za-z0-9._-]
#   RUNNER_TEMP           where the deployment's state lives for the run
#   DEPLOY_READY_SECONDS  bound on the /readyz wait (default 180)
#
# Every input is checked before anything is built or started. The deployment
# is the candidate image (the one build definition, image-build.sh) with its
# own Postgres and MinIO from docker-compose.yaml under a compose project
# named for the candidate, host ports allocated by Docker. The database is
# set up the way deploy/ sets it up: ranker_migrator owns it, bootstrap.sql
# runs as the superuser, migrate.sh applies the migrations copied out of the
# candidate image as the migrator, and the service logs in as ranker_service,
# a member of ranker_app only. The service boots with a generated API key set
# of one principal (e2e); the suites get its URL as RANKER_E2E_URL and the key
# as RANKER_E2E_API_KEY. Credentials here are per-run throwaways.
set -euo pipefail

fail() {
  echo "deploy-candidate: $*" >&2
  exit 1
}

: "${RUNNER_TEMP:?deploy-candidate needs RUNNER_TEMP}"
state="${RUNNER_TEMP}/deploy-candidate"

compose() { docker compose -f docker-compose.yaml -p "$(<"${state}/project")" "$@"; }
secret() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

up() {
  local candidate="${CANDIDATE-}" batch="${BATCH-}" ready="${DEPLOY_READY_SECONDS:-180}" head
  [[ "${candidate}" =~ ^[0-9a-f]{40}$ ]] || fail "candidate must be a full 40-character commit SHA, got '${candidate}'"
  [[ "${batch}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] ||
    fail "batch must be 1-64 letters, digits, '.', '_' or '-' (starting with a letter or digit), got '${batch}'"
  [[ "${ready}" =~ ^[1-9][0-9]{0,3}$ ]] || fail "DEPLOY_READY_SECONDS must be a positive integer, got '${ready}'"
  head="$(git rev-parse HEAD)"
  [ "${head}" = "${candidate}" ] || fail "the checkout is at ${head}, not the candidate ${candidate}"

  local project="crdeploy-${candidate:0:12}"
  local image="corpus-ranker:candidate-${candidate}"
  local api="${project}-api"
  rm -rf "${state}"
  mkdir -p "${state}/api-keys"
  echo "${project}" > "${state}/project"
  echo "${api}" > "${state}/api"
  echo "deploy-candidate: batch ${batch}: deploying candidate ${candidate}"

  # 1. The candidate image, labelled with the candidate commit.
  # shellcheck source=image-build.sh
  . .github/scripts/image-build.sh
  export GITHUB_SHA="${candidate}"
  image_build "${image}"

  # 2. Its Postgres and MinIO, host ports allocated by Docker.
  RANKER_PG_PORT=0 RANKER_MINIO_PORT=0 RANKER_MINIO_CONSOLE_PORT=0 \
    compose up -d --wait --wait-timeout 300 postgres minio

  # 3. The database as deploy/ sets it up (deploy/db/bootstrap.sql's header).
  local migrator service
  migrator="$(secret)"
  service="$(secret)"
  local super=(exec -T -e PGPASSWORD=ranker postgres psql -h 127.0.0.1 -U ranker -X -q -v ON_ERROR_STOP=1)
  compose "${super[@]}" -d postgres <<SQL
CREATE ROLE ranker_migrator LOGIN PASSWORD '${migrator}';
ALTER DATABASE ranker OWNER TO ranker_migrator;
SQL
  compose "${super[@]}" -d ranker < deploy/db/bootstrap.sql
  compose exec -T postgres sh -c 'rm -rf /tmp/candidate-migrations && mkdir /tmp/candidate-migrations'
  docker run --rm --entrypoint tar "${image}" -C /app/db/migrations -c . |
    compose exec -T postgres tar -x -C /tmp/candidate-migrations
  compose exec -T -e PGHOST=127.0.0.1 -e PGUSER=ranker_migrator -e "PGPASSWORD=${migrator}" -e PGDATABASE=ranker \
    postgres sh -s /tmp/candidate-migrations < deploy/db/migrate.sh
  compose "${super[@]}" -d ranker <<SQL
CREATE ROLE ranker_service LOGIN PASSWORD '${service}' IN ROLE ranker_app;
SQL

  # 4. The candidate service, with a generated API key set.
  local key
  key="$(secret)"
  echo "::add-mask::${key}"
  printf '%s' "${key}" > "${state}/api-keys/e2e"
  chmod 755 "${state}/api-keys"
  chmod 644 "${state}/api-keys/e2e"
  docker run -d --name "${api}" --network "${project}_default" -p 127.0.0.1::8080 \
    -e "RANKER_DATABASE_URL=postgres://ranker_service:${service}@postgres:5432/ranker" \
    -e RANKER_S3_ENDPOINT=http://minio:9000 -e RANKER_S3_BUCKET=ranker-originals \
    -e RANKER_S3_ACCESS_KEY_ID=ranker -e RANKER_S3_SECRET_ACCESS_KEY=ranker-local-only \
    -e RANKER_API_KEYS_DIR=/keys -v "${state}/api-keys:/keys:ro" "${image}" > /dev/null
  local addr
  addr="$(docker port "${api}" 8080/tcp)"
  addr="${addr%%$'\n'*}"
  [[ "${addr}" =~ ^127\.0\.0\.1:[0-9]+$ ]] || fail "the service publishes no local port (docker port: '${addr}')"
  echo "http://${addr}" > "${state}/url"

  # 5. Ready: the database and the object store answer (GET /readyz).
  DEPLOY_URL="http://${addr}" DEPLOY_READY_SECONDS="${ready}" node --input-type=module -e '
const url = `${process.env.DEPLOY_URL}/readyz`;
const seconds = Number(process.env.DEPLOY_READY_SECONDS);
const deadline = Date.now() + seconds * 1000;
let last = "no answer";
while (Date.now() < deadline) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    await r.body?.cancel();
    if (r.status === 200) process.exit(0);
    last = `HTTP ${r.status}`;
  } catch (e) {
    last = e.message;
  }
  await new Promise((ok) => setTimeout(ok, 500));
}
console.error(`deploy-candidate: ${url} not ready within ${seconds}s (last: ${last})`);
process.exit(1);
'
  echo "deploy-candidate: batch ${batch}: candidate ${candidate} deployed at http://${addr}"
}

suite() {
  local script="${1-}"
  case "${script}" in
    test:e2e | test:journeys) ;;
    *) fail "unknown suite '${script}' (test:e2e or test:journeys)" ;;
  esac
  [ -f "${state}/url" ] || fail "no deployed candidate to run ${script} against"
  RANKER_E2E_URL="$(<"${state}/url")" RANKER_E2E_API_KEY="$(<"${state}/api-keys/e2e")" npm run --silent "${script}"
}

down() {
  if [ ! -f "${state}/project" ]; then
    echo "deploy-candidate: nothing deployed"
    return 0
  fi
  local api
  api="$(<"${state}/api")"
  # The service's last words, for whoever reads a red batch.
  docker logs --tail 200 "${api}" 2>&1 || true
  docker rm -f "${api}" > /dev/null 2>&1 || true
  compose down -v --remove-orphans
  rm -rf "${state}"
  echo "deploy-candidate: deployment removed"
}

case "${1-}" in
  up) up ;;
  suite) suite "${2-}" ;;
  down) down ;;
  *) fail "usage: deploy-candidate.sh up | suite <test:e2e|test:journeys> | down" ;;
esac
