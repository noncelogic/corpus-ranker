# OpenBao grants for Corpus Ranker

Estate-side OpenBao configuration that Corpus Ranker's own workloads need,
recorded here beside the manifests that use it and applied estate-side by an
operator (not by kustomize or CI):

| Kubernetes auth role | Service account | Policy | Grant |
| --- | --- | --- | --- |
| `corpus-ranker-minio-provision` ([role](kubernetes-roles/corpus-ranker-minio-provision.json)) | `corpus-ranker/ranker-minio-provision` (`deploy/minio-provision-job.yaml`) | [`corpus-ranker-minio-provision`](policies/corpus-ranker-minio-provision.hcl) | read and patch on `kv/corpus-ranker/minio`, nothing else (CRANK-140) |
| `corpus-ranker-api-keys` ([role](kubernetes-roles/corpus-ranker-api-keys.json)) | `corpus-ranker/ranker-api-keys-generate` (`deploy/api-keys-job.yaml`) | [`corpus-ranker-api-keys`](policies/corpus-ranker-api-keys.hcl) | create and read on `kv/corpus-ranker/api-keys`, nothing else: no update, patch, delete, list or metadata (CR-M3-DEC-KEYGEN-GRANT default) |

Apply, logged in to OpenBao with rights to write policies and auth roles:

```sh
bao policy write corpus-ranker-minio-provision devops/openbao/policies/corpus-ranker-minio-provision.hcl
bao write auth/kubernetes/role/corpus-ranker-minio-provision @devops/openbao/kubernetes-roles/corpus-ranker-minio-provision.json
bao policy write corpus-ranker-api-keys devops/openbao/policies/corpus-ranker-api-keys.hcl
bao write auth/kubernetes/role/corpus-ranker-api-keys @devops/openbao/kubernetes-roles/corpus-ranker-api-keys.json
```

Each role's token lives as long as its Job's `activeDeadlineSeconds` (15
minutes for the MinIO provisioning Job, 5 for the API key Job).
`tests/deploy/minio-provision-job.test.ts` and `tests/deploy/api-keys-job.test.ts`
load the files into a throwaway OpenBao and run each Job's steps with its
role's policy alone.

The estate External Secrets role (the one the `openbao` ClusterSecretStore
logs in with) holds three ranker policies, one per custody path, kept beside
the scripts that fill their paths in `deploy/openbao/`:
`external-secrets-corpus-ranker.hcl` (read on `kv/corpus-ranker/api-keys`),
`external-secrets-corpus-ranker-minio.hcl` (read on `kv/corpus-ranker/minio`)
and `external-secrets-ghcr-pull.hcl` (read on `kv/corpus-ranker/ghcr-pull`).
Attach all of them: the API key and MinIO ExternalSecrets each need theirs.
Each grant is one exact path, read-only, no wildcard (CRANK-140). The API keys are
written by the `ranker-api-keys-generate` Sync hook Job on the first Argo CD
sync that finds `kv/corpus-ranker/api-keys` empty, one key per principal
CR-D1-DEC-PRINCIPALS authorises (only `joe`); later syncs keep the key set
untouched, and no key is ever printed. No operator generates them by hand.
