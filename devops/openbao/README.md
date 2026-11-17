# OpenBao grants for Corpus Ranker

Estate-side OpenBao configuration that Corpus Ranker's own workloads need,
recorded here beside the manifests that use it and applied estate-side by an
operator (not by kustomize or CI):

| Kubernetes auth role | Service account | Policy | Grant |
| --- | --- | --- | --- |
| `corpus-ranker-minio-provision` ([role](kubernetes-roles/corpus-ranker-minio-provision.json)) | `corpus-ranker/ranker-minio-provision` (`deploy/minio-provision-job.yaml`) | [`corpus-ranker-minio-provision`](policies/corpus-ranker-minio-provision.hcl) | read and patch on `kv/corpus-ranker/minio`, nothing else (CRANK-140) |

Apply, logged in to OpenBao with rights to write policies and auth roles:

```sh
bao policy write corpus-ranker-minio-provision devops/openbao/policies/corpus-ranker-minio-provision.hcl
bao write auth/kubernetes/role/corpus-ranker-minio-provision @devops/openbao/kubernetes-roles/corpus-ranker-minio-provision.json
```

The role's token lives 15 minutes, the Job's `activeDeadlineSeconds`.
`tests/deploy/minio-provision-job.test.ts` loads both files into a throwaway
OpenBao and runs the Job's steps with the role's policy alone.
