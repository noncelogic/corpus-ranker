# 0001 — MinIO image source for the replica and the deployment

- Status: accepted (CR-M3-MINIO-PIN, 2026-11-16)
- Scope: only the *image source* of the ranker's MinIO. MinIO stays the
  engine (TECH-STACK §5); where the estate MinIO runs is CR-D1-DEC-MINIO /
  CRANK-57's call, not this record's.

## Context

`docker-compose.yaml` and `deploy/minio.yaml` both pinned
`cgr.dev/chainguard/minio:latest@sha256:a1ac4589…` (since CR-M1-T1,
2026-11-08). On 2026-11-16 the API suite could not run because pulling MinIO
returned HTTP 403 (COND-102-review2), and `tests/foundation/local-replica.test.ts`
fails at the pull on any host without a cached image.

What was confirmed while making this change (from a review/build worker):

- `docker pull cgr.dev/chainguard/minio:latest@sha256:a1ac4589…` →
  `Get "https://cgr.dev/v2/": Forbidden`. The 403 is returned to the
  `CONNECT cgr.dev:443` itself by the workers' egress proxy
  (`X-Squid-Error: ERR_ACCESS_DENIED`), so these workers cannot reach cgr.dev at all.
  `quay.io` is refused the same way. Docker Hub (also through the in-cluster
  pull-through `registry-mirror`) and ghcr.io are reachable.
- Whether cgr.dev also refuses the superseded digest from an unrestricted host
  could not be checked from here. Either way the pin is fragile: Chainguard's
  free tier publishes only the rolling `latest` tag and does not promise to
  keep serving digests that `latest` has moved past. A digest of a rolling tag
  is not a stable pin.

Requirements for the replacement: one image for both the replica and the
deployment; a **release tag and its digest** (the tag says which MinIO it is,
the digest makes it immutable); a registry that keeps serving tagged releases;
pullable anonymously from the review/build workers, GitHub-hosted runners and
the AKS nodes; it ships `sh` and `mc`, because both manifests provision the
bucket in the MinIO container itself; multi-arch (amd64 and arm64).

## Options weighed

1. **Upstream MinIO release image (`quay.io/minio/minio` / `docker.io/minio/minio`
   `RELEASE.*`).** This is the canonical build. MinIO stopped publishing community
   images in late 2025, so the newest available is a 2025 release. Anonymous
   pulls of `docker.io/minio/minio` now fail with "repository does not exist or
   may require 'docker login'". `quay.io` is refused by the worker egress proxy, so
   the replica would still not start where reviews run. Rejected.
2. **Mirror under `ghcr.io/noncelogic/minio`.** Full control and the registry
   is already in use (`publish.yml`). It needs a new publish/mirror workflow
   with package write scope, an upstream to mirror from (which runs into option 1's
   problem), and the package made public so runners and nodes can pull it
   anonymously. That makes it a separate change with its own review, not this fix.
   Kept as the fallback if option 3 goes away.
3. **`docker.io/pgsty/minio` (community fork built from MinIO's AGPL source by
   the Pigsty project).** Release-tagged in MinIO's own scheme
   (`RELEASE.2026-08-04T00-00-00Z`) and still updated in 2026. It is a
   multi-arch OCI index (linux/amd64 and linux/arm64) on Docker Hub, which keeps
   serving tagged pushes. It pulls through the workers' registry mirror and on
   GitHub-hosted runners. Its UBI9-micro base ships `sh`, `minio` and `mc`.
   It runs as root by default and also works as the deployment's uid 65532 with
   `MC_CONFIG_DIR=/tmp/mc`. Downsides: a third-party publisher and not MinIO, Inc.,
   and Docker Hub's anonymous pull rate limits.
4. `docker.io/bitnamilegacy/minio`: frozen at 2025.7.23 with no further
   security updates, and Bitnami gives no long-term retention promise. Rejected.

## Decision

Option 3. Both manifests run

    docker.io/pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372

The digest is the multi-arch OCI index digest. The image is fully qualified
(`docker.io/…`) so CRI-O nodes that reject short names can still resolve it.
`tests/deploy/manifests.test.ts` ("the replica and the deployment run the same
MinIO image, pinned by release tag and digest") holds both files to one image
with a `RELEASE.*` tag plus a digest, and holds this record to naming it.

## Consequences

- To bump, change the tag and digest together in both files and here.
  Resolve the digest from the registry (`docker buildx imagetools inspect`),
  not from a local cache.
- If pgsty stops publishing, or its Docker Hub tags disappear, switch to
  option 2.
