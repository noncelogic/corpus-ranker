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

After applying, read the API key Job's grant back and check it is exactly the
declared one (exit 1 names each difference: an added capability, another
path, another bound service account or namespace, an extra attached policy,
an absent policy or role; it reads names and policy text only):

```sh
node deploy/openbao/check-api-keys-grant.ts
```

`tests/deploy/openbao-writeback-readback.test.ts` holds the checker.

Each role's token lives as long as its Job's `activeDeadlineSeconds` (15
minutes for the MinIO provisioning Job, 5 for the API key Job).
`tests/deploy/minio-provision-job.test.ts` and `tests/deploy/api-keys-job.test.ts`
load the files into a throwaway OpenBao and run each Job's steps with its
role's policy alone.

The estate External Secrets role `eso-obs` (Kubernetes auth mount
`kubernetes`, the role the `openbao` ClusterSecretStore logs in with) holds
ranker read grants, one per custody path. Two live here, in `policies/`:
`external-secrets-corpus-ranker-minio.hcl` (read on `kv/corpus-ranker/minio`)
and `external-secrets-corpus-ranker.hcl` (read on `kv/corpus-ranker/api-keys`).
[`kubernetes-roles/eso-obs.attach.json`](kubernetes-roles/eso-obs.attach.json)
declares their attachment to `eso-obs`, in that order, add-only: the role's
existing policies, among them the estate-held grant on the ranker's ACR pull
credential `kv/corpus-ranker/acr-pull` (meta-harness
devops/aks/corpus-ranker-argo/README.md), stay attached.
That estate-held grant, `external-secrets-corpus-ranker-acr-pull`, was created
and attached estate-side on 2026-11-19; its reviewed source is
[`policies/external-secrets-corpus-ranker-acr-pull.hcl`](policies/external-secrets-corpus-ranker-acr-pull.hcl)
(read on `kv/corpus-ranker/acr-pull` alone, read by the ExternalSecret
`ranker-registry-pull` only; `tests/deploy/registry-pull-grant.test.ts`). It
is not in the attach manifest: the role already holds it.
The estate apply is CRANK-188, one command, logged in to OpenBao with rights
to read and write policies and the role:

```sh
node deploy/openbao/attach-eso.ts
```

It snapshots the live role, writes each declared policy whose stored text is
not byte-identical to its file (the file's bytes on stdin), appends only the
names missing from the role's `token_policies` after the existing ones
(`eso-sync` and the rest keep their order), never creates the role, never writes another
policy, then reads back both the policy bytes and the role: `token_policies`
must be the snapshot's list followed by the appended names, and every other
role setting must equal the snapshot (exit 1 names each difference, exit 2 a
failed read or write or an absent role). Before touching OpenBao it refuses,
with exit 2, a manifest policy file that grants anything but read on exactly
one `kv/corpus-ranker/<purpose>` path, or two policies granting the same
path; the readback below refuses them the same way
(`tests/deploy/external-secrets-policies.test.ts`, CR-M3-D2e, holds the
refusals and an apply from main after which each attached policy alone reads
its one custody path and nothing else). A second run writes nothing. Its last
stdout line is a JSON record (role, `token_policies` before and after, the
appended names, each policy file's sha256, `settings_preserved`) that goes
into meta-harness devops/openbao/README.md as the deploy record.
`tests/deploy/external-secrets.test.ts` ("the ExternalSecret store role names
both exact-path corpus-ranker read policies") runs it against a throwaway
OpenBao holding the role as the estate does before the apply.

After applying, read the attachment back and check it (exit 1 names each
difference: a manifest policy missing from the role's `token_policies`, an
absent policy or role, an added capability, a second or wildcard path; it
reads names and policy text only, and asserts nothing about the role's other
policies):

```sh
node deploy/openbao/check-eso-attach.ts
```

`tests/deploy/openbao-eso-attach-readback.test.ts` holds the checker.

Every ExternalSecret in `deploy/` that reads the `openbao` store reads only a
path one of these grants covers; the database ExternalSecrets read no
store (their passwords come from the in-cluster `ranker-db-password`
generator). `tests/deploy/openbao-eso-role.test.ts` holds both.

Each grant is one exact path, read-only, no wildcard (CRANK-140). The API keys are
written by the `ranker-api-keys-generate` Sync hook Job on the first Argo CD
sync that finds `kv/corpus-ranker/api-keys` empty, one key per principal
CR-D1-DEC-PRINCIPALS authorises (only `joe`); later syncs keep the key set
untouched, and no key is ever printed. No operator generates them by hand.
